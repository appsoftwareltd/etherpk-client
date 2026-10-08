/**
 * Reaching a graph's host from another process (ADR 0072, amended 2026-10-08): `serve` for its
 * agent's session, `publish` for a command-line publish, `running` and `stop`, and `login` and
 * `logout`, which stop the hosts that hold the login they change.
 *
 * A host is found by the record in its graph's cache directory, and started when there is none.
 * Whoever starts one does not decide whether it is needed: the new host's claim does, and a host
 * that finds a live owner says where that owner listens instead. So several agents starting at
 * once each start a host, one of them holds the graph, and every one of them ends up there.
 */
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdir, rename, stat } from 'node:fs/promises'
import type { Socket } from 'node:net'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'

import type { HostAnnouncement } from './graph-host'
import { HOST_STARTUP_MS, listHostRecords, processAlive, readHostRecord, type HostRecord } from './host-endpoint'
import { HOST_PROTOCOL, hostRequest, whenClosed, type HostReply, type HostRequest, type HostStatus } from './host-protocol'

/** How to reach one graph's host: its cache directory, and how to start one. */
export interface HostLauncher {
    cacheDir: string
    /** Start a host for the graph; resolves with what it announced. */
    spawn(): Promise<HostAnnouncement>
}

/** No host could be reached or started; the message says why, for the agent or the person. */
export class HostUnavailable extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'HostUnavailable'
    }
}

export interface RequestHostOptions {
    /** How long to keep trying, while hosts start, stop and hand over. */
    deadlineMs?: number
    /** How long one host has to answer; none for a publish, which answers when it has published. */
    answerTimeoutMs?: number
    /** The pause between tries. */
    retryMs?: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/**
 * Send `request` to the graph's host, starting one if none is running, and return its answer
 * with the connection still open. The host must prove the secret its record holds
 * (`host-protocol.ts`). A host that is stopping is waited out, and one that does not answer where
 * its record says is replaced, unless it started moments ago and may not be listening yet.
 */
export async function requestHost(launcher: HostLauncher, request: HostRequest, options: RequestHostOptions = {}): Promise<{ reply: HostReply; socket: Socket }> {
    const deadline = Date.now() + (options.deadlineMs ?? 60_000)
    const retryMs = options.retryMs ?? 250
    let why = ''
    let startOne = false
    for (;;) {
        let record = startOne ? null : await readHostRecord(launcher.cacheDir)
        startOne = false
        if (!record || !processAlive(record.pid)) {
            const announced = await launcher.spawn()
            if ('failed' in announced) throw new HostUnavailable(announced.failed)
            // The record of the host that answered: the one just started, or the one it found
            // serving the graph already. Its secret is what that host proves.
            const current = await readHostRecord(launcher.cacheDir)
            record = current?.pid === announced.pid && current.endpoint === announced.endpoint ? current : null
        }
        if (record) {
            try {
                const answer = await hostRequest(record.endpoint, request, { timeoutMs: options.answerTimeoutMs, secret: record.secret })
                if (answer.reply.etherpk !== 'stopping') return answer
                answer.socket.destroy()
                why = 'it was stopping'
            } catch (error) {
                why = describeError(error)
                if (!(Date.now() - Date.parse(record.startedAt) < HOST_STARTUP_MS)) startOne = true
            }
        } else {
            why = 'it handed the graph to another process'
        }
        if (Date.now() + retryMs > deadline) {
            throw new HostUnavailable(`The background process serving this graph did not answer in ${Math.round((options.deadlineMs ?? 60_000) / 1000)} seconds (last: ${why}).`)
        }
        await sleep(retryMs)
    }
}

/** A host's status, or null when nothing proves itself the host at its endpoint. */
export async function hostStatus(record: HostRecord): Promise<HostStatus | null> {
    try {
        const { reply, socket } = await hostRequest(record.endpoint, { etherpk: 'status', protocol: HOST_PROTOCOL }, { timeoutMs: 5_000, secret: record.secret })
        socket.destroy()
        return reply.etherpk === 'status' ? reply.status : null
    } catch {
        return null
    }
}

/** The hosts running on this computer, with what each says of itself; one that is stopping included. */
export async function runningHosts(env: NodeJS.ProcessEnv): Promise<Array<{ cacheDir: string; record: HostRecord; status: HostStatus }>> {
    const found = []
    for (const { cacheDir, record } of await listHostRecords(env)) {
        if (!processAlive(record.pid)) continue
        const status = await hostStatus(record)
        if (status) found.push({ cacheDir, record, status })
    }
    return found
}

/**
 * Ask a host to stop and wait until it has: it closes the connection once it has flushed the
 * graph and given up its claim. A host already stopping answers the same and is waited for.
 * False when it did not answer, or did not finish in time.
 */
export async function stopHost(record: HostRecord, reason: string, timeoutMs = 60_000): Promise<boolean> {
    let socket: Socket | undefined
    try {
        const answer = await hostRequest(record.endpoint, { etherpk: 'stop', protocol: HOST_PROTOCOL, reason }, { timeoutMs: 5_000, secret: record.secret })
        socket = answer.socket
        if (answer.reply.etherpk !== 'stopping') return false
        let timer: ReturnType<typeof setTimeout> | undefined
        const finished = await Promise.race([whenClosed(socket).then(() => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)))])
        clearTimeout(timer)
        return finished
    } catch {
        return false
    } finally {
        socket?.destroy()
    }
}

/** Stop every running host `which` picks, together, and say which stopped. */
export async function stopHosts(
    env: NodeJS.ProcessEnv,
    reason: string,
    which: (host: { record: HostRecord; status: HostStatus }) => boolean = () => true,
): Promise<Array<{ record: HostRecord; status: HostStatus; stopped: boolean }>> {
    const picked = (await runningHosts(env)).filter(which)
    return Promise.all(picked.map(async (host) => ({ record: host.record, status: host.status, stopped: await stopHost(host.record, reason) })))
}

/** A log over this size is moved aside to `<name>.1` when the next host starts. */
const LOG_LIMIT_BYTES = 1024 * 1024

async function rotateLog(path: string): Promise<void> {
    const size = await stat(path).then(
        (stats) => stats.size,
        () => 0,
    )
    if (size > LOG_LIMIT_BYTES) await rename(path, `${path}.1`).catch(() => {})
}

export interface SpawnHostOptions {
    /** The arguments after `host`. */
    args: string[]
    env: NodeJS.ProcessEnv
    /** Where the host's stderr goes: its log, beside the graph's cache. */
    logPath: string
    timeoutMs?: number
    /** The program and the arguments before `args`: this program's `host` command unless a test says otherwise. */
    program?: string[]
}

/**
 * The variables only `login` reads: a token and a Recovery Code set for a scripted login. A
 * graph's host has no use for either, and it outlives the `serve` that starts it by minutes, so it
 * starts without them.
 */
const LOGIN_ONLY_VARIABLES = ['ETHERPK_PAT', 'ETHERPK_RECOVERY_CODE']

/** `env` without {@link LOGIN_ONLY_VARIABLES}. */
function hostEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const kept = { ...env }
    for (const name of LOGIN_ONLY_VARIABLES) delete kept[name]
    return kept
}

/**
 * Start this program's `host` command in the background and read the one line it announces.
 * The host runs detached, in a session of its own, so it outlives the `serve` that started it
 * and is not sent the signals meant for that `serve`'s terminal or agent.
 */
export async function spawnHostProcess(options: SpawnHostOptions): Promise<HostAnnouncement> {
    const timeoutMs = options.timeoutMs ?? 45_000
    await mkdir(dirname(options.logPath), { recursive: true, mode: 0o700 })
    await rotateLog(options.logPath)
    const log = openSync(options.logPath, 'a', 0o600)
    const [file, ...leading] = options.program ?? [process.execPath, ...process.execArgv, process.argv[1], 'host']
    let child
    try {
        child = spawn(file, [...leading, ...options.args], {
            detached: true,
            stdio: ['ignore', 'pipe', log],
            env: hostEnvironment(options.env),
            windowsHide: true,
        })
    } finally {
        // The child has its own copy of the descriptor.
        closeSync(log)
    }
    const started = child
    return new Promise((resolve) => {
        let settled = false
        const lines = createInterface({ input: started.stdout! })
        const finish = (announcement: HostAnnouncement) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            lines.close()
            started.stdout?.destroy()
            started.unref()
            resolve(announcement)
        }
        const timer = setTimeout(() => finish({ failed: `The background process for this graph did not start within ${Math.round(timeoutMs / 1000)} seconds. Its log is ${options.logPath}.` }), timeoutMs)
        lines.once('line', (line) => {
            try {
                const announced = JSON.parse(line) as HostAnnouncement
                if ('failed' in announced && typeof announced.failed === 'string') return finish(announced)
                if ('endpoint' in announced && typeof announced.endpoint === 'string') return finish(announced)
            } catch {
                // Not an announcement; the failure below says where to look.
            }
            finish({ failed: `The background process for this graph said something unexpected. Its log is ${options.logPath}.` })
        })
        started.once('error', (error) => finish({ failed: `Could not start the background process for this graph: ${error.message}` }))
        // `close`, not `exit`: it comes after the last of stdout, so a host that announced and then
        // left at once (it found another host serving the graph) is read before this fires.
        started.once('close', (code) => finish({ failed: `The background process for this graph exited (code ${code}) before it started. Its log is ${options.logPath}.` }))
    })
}
