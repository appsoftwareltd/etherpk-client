/**
 * Builds the Installed Build (`installed-build.ts` says what it holds) into `build-installed/`.
 *
 * It is the Client's ordinary production build with its pages captured: the built server is started
 * once on a free loopback port, with no setting but the public ones, and the shell page, the page an
 * EBook reads in and the settings file are saved from it. Nothing of the server ships.
 *
 * The server build goes to folders of its own, so this can run beside a web build or a test server
 * that serves one.
 *
 * Run via: pnpm build:installed (after build-extensions.mjs)
 */
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { build } from 'esbuild'

import { SETTINGS_FILE, SIZE_LIMIT_BYTES, checkInstalledBuild, installedSettings, isShippedFile, settingsFileOf, staticPage } from '../installed-build.ts'

const clientRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const output = join(clientRoot, 'build-installed')
// Under node_modules, which a dev server in this folder does not watch.
const work = join(clientRoot, 'node_modules', '.cache', 'installed-build')
const serverBuild = join(work, 'server-build')
/** Assembled here and moved into place once it passes its check, so a failed run leaves no half of one. */
const staging = join(work, 'staging')

const EBOOK_PAGE = '__etherpk-ebook/reader.html'
/** How long the built server may take to answer its first request. */
const SERVER_START_MS = 60_000

const settings = installedSettings(process.env)

rmSync(staging, { recursive: true, force: true })
const { status } = spawnSync('vite build', {
    cwd: clientRoot,
    shell: true,
    stdio: 'inherit',
    env: {
        ...process.env,
        // As in vite-build.mjs: a development `.env` must not make this a development build.
        NODE_ENV: 'production',
        INSTALLED_BUILD: 'true',
        INSTALLED_ACCOUNT_ISSUER: settings.accountIssuer ?? '',
        INSTALLED_WEB_CLIENT_URL: settings.webClientUrl ?? '',
        SVELTEKIT_OUT_DIR: join('node_modules', '.cache', 'installed-build', 'kit'),
        INSTALLED_SERVER_DIR: serverBuild,
    },
})
if (status !== 0) process.exit(status ?? 1)

const client = join(serverBuild, 'client')
cpSync(client, staging, {
    recursive: true,
    filter: (source) => {
        const path = relative(client, source).split(sep).join('/')
        return path === '' || isShippedFile(path) && isShippedFile(`${path}/`)
    },
})
await captureServedPages()
await build({
    bundle: true,
    format: 'esm',
    minify: true,
    target: 'es2022',
    entryPoints: [join(clientRoot, 'src/service-worker/installed.ts')],
    outfile: join(staging, 'service-worker.js'),
})

const files = new Map(readdirSync(staging, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
        const path = join(entry.parentPath, entry.name)
        return [relative(staging, path).split(sep).join('/'), readFileSync(path)]
    }))
const problems = checkInstalledBuild(files, { secrets: privateValues(), sizeLimit: SIZE_LIMIT_BYTES })
if (problems.length > 0) {
    console.error(`build-installed: the build is not fit to ship:\n- ${problems.join('\n- ')}`)
    process.exit(1)
}
rmSync(output, { recursive: true, force: true })
renameSync(staging, output)
const size = [...files.values()].reduce((sum, content) => sum + content.byteLength, 0)
console.log(`build-installed: ${files.size} files, ${(size / 1024 / 1024).toFixed(1)} MB, in ${output}`)

/** Start the built server, save what only it can say, and stop it. */
async function captureServedPages() {
    const port = await freePort()
    const origin = `http://127.0.0.1:${port}`
    const server = spawn(process.execPath, [join(serverBuild, 'index.js')], {
        // The whole environment it gets: a private setting of this machine cannot reach a page.
        env: { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: String(port), ORIGIN: origin, LOG_LEVEL: 'error', EXTENSION_DIRECTORY_URL: '', ...settings.publicEnvironment },
        stdio: ['ignore', 'ignore', 'inherit'],
    })
    const stopped = once(server, 'exit')
    try {
        const shell = await answered(`${origin}/offline-shell`, server)
        const page = staticPage(await shell.text(), policyOf(shell))
        save('index.html', page.html)
        save('csp.txt', page.policy)
        const ebook = await answered(`${origin}/${EBOOK_PAGE}`, server)
        save(EBOOK_PAGE, await ebook.text())
        save(`${EBOOK_PAGE}.csp.txt`, policyOf(ebook))
        save('_app/env.js', await (await answered(`${origin}/_app/env.js`, server)).text())
        save(SETTINGS_FILE, settingsFileOf(settings))
    } finally {
        server.kill()
        await stopped
    }
}

function save(path, text) {
    const file = join(staging, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
}

function policyOf(response) {
    const policy = response.headers.get('content-security-policy')
    if (!policy) throw new Error(`${response.url} was served with no Content-Security-Policy.`)
    return policy
}

/** The server's answer, waiting for it to start. Fails at once when the server has stopped. */
async function answered(url, server) {
    const deadline = Date.now() + SERVER_START_MS
    for (;;) {
        if (server.exitCode !== null) throw new Error(`The built server stopped with ${server.exitCode} before it answered ${url}.`)
        const response = await fetch(url).catch(() => null)
        if (response?.ok) return response
        if (response) throw new Error(`${url} answered ${response.status}.`)
        if (Date.now() > deadline) throw new Error(`The built server did not answer ${url}.`)
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
}

async function freePort() {
    const probe = createServer().listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const { port } = probe.address()
    probe.close()
    await once(probe, 'close')
    return port
}

/** This machine's private settings that look like credentials, which no file of the build may hold. */
function privateValues() {
    const local = join(clientRoot, '.env')
    const all = { ...(existsSync(local) ? parseEnv(readFileSync(local, 'utf8')) : {}), ...process.env }
    return Object.fromEntries(Object.entries(all).filter(([name, value]) => /SECRET|PASSWORD|TOKEN|_AUTH$|_KEY$/.test(name) && !name.startsWith('PUBLIC_') && (value ?? '').length >= 12))
}
