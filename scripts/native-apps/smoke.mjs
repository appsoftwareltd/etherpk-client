/**
 * Starts a PACKAGED desktop app, waits for its first page, and looks at it. It needs Node and nothing
 * installed, so it runs on a clean device:
 *
 *   node scripts/native-apps/smoke.mjs [--sandbox on|off] [--version x.y.z] [--screenshot <file>] -- <executable> [argument]...
 *
 * On Linux, run it under `xvfb-run`. `--sandbox` (Linux) also says whether Chromium's sandbox must be on.
 */
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { parseArgs } from 'node:util'

const START_MS = 120_000
const linux = process.platform === 'linux'

const { positionals: [executable, ...args], values } = parseArgs({
    allowPositionals: true,
    options: { sandbox: { type: 'string' }, version: { type: 'string' }, screenshot: { type: 'string' } },
})

async function freePort() {
    const probe = createServer().listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const { port } = probe.address()
    probe.close()
    return port
}

/** Try until it gives something, or fail with what was being waited for. */
async function until(what, look) {
    const deadline = Date.now() + START_MS
    for (;;) {
        const found = await look()
        if (found) return found
        if (Date.now() > deadline) throw new Error(`Waited too long for ${what}.`)
        await wait(250)
    }
}

/** The processes below and including one, each with its command line. Linux only. */
function processes(root) {
    const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
        .split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    const family = new Set([root])
    // A child is listed after its parent unless the numbers have wrapped round, so look until nothing is new.
    for (let before = 0; before !== family.size;) {
        before = family.size
        for (const [, pid, parent] of rows) if (family.has(Number(parent))) family.add(Number(pid))
    }
    return rows.filter(([, pid]) => family.has(Number(pid))).map(([, pid, , line]) => ({ pid: Number(pid), line }))
}

/** A process's seccomp mode from /proc: 0 none, 1 strict, 2 a filter. Null when it has ended. */
function seccompOf(pid) {
    try {
        const found = /^Seccomp:\s*(\d)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
        return found ? Number(found[1]) : null
    } catch {
        return null
    }
}

/** One page, over Chromium's own debugging protocol. */
async function connect(address) {
    const socket = new WebSocket(address)
    await once(socket, 'open')
    const answers = new Map()
    const errors = []
    let last = 0
    socket.addEventListener('message', ({ data }) => {
        const message = JSON.parse(data)
        if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
        answers.get(message.id)?.(message)
    })
    const send = async (method, params = {}) => {
        const id = ++last
        const { result, error } = await new Promise((resolve) => {
            answers.set(id, resolve)
            socket.send(JSON.stringify({ id, method, params }))
        })
        if (error) throw new Error(`${method}: ${error.message}`)
        return result
    }
    await send('Runtime.enable')
    const evaluate = async (expression) => {
        const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
        return result.value
    }
    return { send, evaluate, errors, close: () => socket.close() }
}

const SEEN = `(async () => ({
    address: location.href,
    platform: globalThis.etherpkNative?.info?.platform ?? null,
    version: globalThis.etherpkNative?.info?.appVersion ?? null,
    unknownMethod: (await globalThis.etherpkNative?.call('fs.exec', {}))?.name ?? null,
    agent: navigator.userAgent,
}))()`
const DRAWN = `[...document.querySelectorAll('h1, h2')].some((one) => one.textContent.trim() === 'Graphs' && one.getClientRects().length > 0)`

function expectations(seen, errors, family) {
    const lines = family.map((one) => one.line)
    const wrong = []
    if (errors.length > 0) wrong.push(`The page threw: ${errors.join('; ')}`)
    if (!seen.address.startsWith('app://etherpk/')) wrong.push(`The page is ${seen.address}.`)
    if (seen.unknownMethod !== 'NotSupportedError') wrong.push(`A method the shell does not have was answered with ${seen.unknownMethod}.`)
    if (values.version && seen.version !== values.version) wrong.push(`The app says it is ${seen.version}, not ${values.version}.`)
    const sandboxed = !lines.some((line) => line.includes('--no-sandbox'))
    if (values.sandbox && sandboxed !== (values.sandbox === 'on')) wrong.push(`The sandbox is ${sandboxed ? 'on' : 'off'}, not ${values.sandbox}.`)
    // What a page runs in: with the sandbox on, each renderer has a system call filter (mode 2). With
    // it off the mode is reported, so the app's notice and the docs can say what is off.
    const rendererSeccomp = family.filter((one) => one.line.includes('--type=renderer')).map((one) => seccompOf(one.pid))
    if (linux && rendererSeccomp.length === 0) wrong.push('No renderer process was found.')
    if (values.sandbox === 'on' && rendererSeccomp.some((mode) => mode !== 2)) wrong.push(`A renderer has seccomp mode ${rendererSeccomp.join(', ')}, not 2, with the sandbox on.`)
    return { wrong, sandboxed, rendererSeccomp }
}

const home = mkdtempSync(join(tmpdir(), 'etherpk-smoke-'))
const port = await freePort()
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache') }
for (const name of ['LD_LIBRARY_PATH', 'WAYLAND_DISPLAY', 'NIXOS_OZONE_WL', 'DBUS_SESSION_BUS_ADDRESS']) delete env[name]
const started = performance.now()
const app = spawn(executable, [`--remote-debugging-port=${port}`, ...(linux ? ['--ozone-platform=x11'] : []), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let said = ''
for (const stream of [app.stdout, app.stderr]) stream.on('data', (chunk) => { said = (said + chunk).slice(-4000) })
let ended = null
app.on('exit', (code, signal) => { ended = `${code ?? signal}` })
app.on('error', (error) => { ended = error.message })

let failure = null
try {
    const target = await until('the first window', async () => {
        if (ended !== null) throw new Error(`The app ended (${ended}) before its page was there.`)
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json(), () => [])
        return targets.find((one) => one.type === 'page' && one.url.startsWith('app://etherpk/'))
    })
    const page = await connect(target.webSocketDebuggerUrl)
    await until('the Graphs page', () => page.evaluate(DRAWN))
    const drawn = Math.round(performance.now() - started)
    // Long enough for what runs just after the first page to fail in.
    await wait(3000)
    const seen = await page.evaluate(SEEN)
    const { wrong, sandboxed, rendererSeccomp } = expectations(seen, page.errors, linux ? processes(app.pid) : [])
    console.log(JSON.stringify({ ...seen, msToGraphsDrawn: drawn, ...(linux ? { sandboxed, rendererSeccomp } : {}) }, null, 2))
    if (values.screenshot) writeFileSync(values.screenshot, Buffer.from((await page.send('Page.captureScreenshot')).data, 'base64'))
    page.close()
    if (wrong.length > 0) failure = wrong.join('\n')
} catch (error) {
    failure = error.message
}
if (failure) console.error(`${failure}\n--- what the app said\n${said}`)

app.kill('SIGTERM')
const waited = AbortSignal.timeout(15_000)
if (ended === null) await Promise.race([once(app, 'exit'), once(waited, 'abort')])
app.kill('SIGKILL')
try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
} catch (error) {
    console.log(`The scratch folder stays: ${error.message}`)
}
process.exit(failure ? 1 : 0)
