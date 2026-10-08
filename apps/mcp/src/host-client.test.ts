import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { fixedSyncToken } from '$lib/sync/sync-token'

import { runGraphHost, type GraphHostDeps, type HostAnnouncement } from './graph-host'
import { HostUnavailable, requestHost, runningHosts, spawnHostProcess, stopHosts, type HostLauncher } from './host-client'
import { hostEndpoint, hostRecordPath } from './host-endpoint'
import { HOST_PROTOCOL, hostRequest, whenClosed } from './host-protocol'
import { openHeadlessGraph } from './headless-graph'

const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde22000'
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'etherpk-host-client-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    return dir
}

/** A launcher whose `spawn` starts a host in this process over a loopback graph, and counts. */
function inProcessLauncher(cacheDir: string, env: NodeJS.ProcessEnv, overrides: Partial<GraphHostDeps> = {}) {
    const exits: number[] = []
    const spawned = vi.fn(
        () =>
            new Promise<HostAnnouncement>((resolve) => {
                void runGraphHost({
                    cacheDir,
                    endpoint: hostEndpoint(cacheDir, env),
                    version: '0.10.0',
                    target: { kind: 'folder', path: '/tmp/Notes' },
                    provisionalName: 'Notes',
                    backendKind: 'folder',
                    idleMs: 60_000,
                    cmd: 'etherpk-mcp',
                    credentialsDir: '~/.config/etherpk',
                    open: async () => {
                        const relay = createLoopbackRelay()
                        const graph = await openHeadlessGraph({
                            graphId: `g-client-${Math.floor(performance.now() * 1000)}`,
                            rootDocId: ROOT,
                            keyring: createGraphKeyring('g-client'),
                            relayUrl: 'ws://loopback/sync',
                            token: fixedSyncToken('t'),
                            presenceName: 'Agent on test',
                            connect: relay.connect,
                        })
                        return { graph, wantSemantic: () => {} }
                    },
                    publish: async () => ({ etherpk: 'failed', message: 'not in this test' }),
                    log: () => {},
                    announce: resolve,
                    exit: (code) => exits.push(code),
                    ...overrides,
                }).then((handle) => cleanup.push(() => handle.stop('the test ended')))
            }),
    )
    const launcher: HostLauncher = { cacheDir, spawn: spawned }
    return { launcher, spawned, exits }
}

const session = { etherpk: 'session', protocol: HOST_PROTOCOL, version: '0.10.0' } as const

describe('reaching a graph\'s host', () => {
    it('starts one when none is running, and finds that one the next time', async () => {
        const env = { XDG_RUNTIME_DIR: await scratch() }
        const { launcher, spawned } = inProcessLauncher(join(await scratch(), 'graph'), env)

        const first = await requestHost(launcher, session)
        first.socket.destroy()
        const second = await requestHost(launcher, session)
        second.socket.destroy()

        expect(first.reply.etherpk).toBe('ok')
        expect(second.reply.etherpk).toBe('ok')
        expect(spawned).toHaveBeenCalledOnce()
    })

    it('waits out a host that is stopping, then starts the next', async () => {
        const env = { XDG_RUNTIME_DIR: await scratch() }
        const { launcher, spawned, exits } = inProcessLauncher(join(await scratch(), 'graph'), env)
        const first = await requestHost(launcher, session)
        first.socket.destroy()
        const endpoint = hostEndpoint(launcher.cacheDir, env)
        const stop = await hostRequest(endpoint, { etherpk: 'stop', protocol: HOST_PROTOCOL, reason: 'a test asked' })
        expect(stop.reply).toEqual({ etherpk: 'stopping' })

        const next = await requestHost(launcher, session, { retryMs: 20 })
        next.socket.destroy()

        await whenClosed(stop.socket)
        expect(next.reply.etherpk).toBe('ok')
        expect(exits).toEqual([0])
        expect(spawned).toHaveBeenCalledTimes(2)
    })

    it('replaces a host whose record outlived it', async () => {
        const env = { XDG_RUNTIME_DIR: await scratch() }
        const cacheDir = join(await scratch(), 'graph')
        await mkdir(cacheDir, { recursive: true })
        // A running process (this one), long started, and nothing listening where it says.
        await writeFile(
            hostRecordPath(cacheDir),
            JSON.stringify({ pid: process.pid, version: '0.9.0', endpoint: join(await scratch(), 'gone.sock'), target: { kind: 'folder', path: '/tmp/Notes' }, startedAt: '2026-01-01T00:00:00.000Z', secret: 'ef'.repeat(32) }),
        )
        const { launcher, spawned } = inProcessLauncher(cacheDir, env)

        const { reply, socket } = await requestHost(launcher, session, { retryMs: 20 })
        socket.destroy()

        expect(reply.etherpk).toBe('ok')
        expect(spawned).toHaveBeenCalledOnce()
    })

    it('says why when a host cannot be started', async () => {
        const launcher: HostLauncher = { cacheDir: join(await scratch(), 'graph'), spawn: async () => ({ failed: 'No space left on the device.' }) }
        await expect(requestHost(launcher, session)).rejects.toEqual(new HostUnavailable('No space left on the device.'))
    })

    it('lists the hosts running, and stops the ones asked for', async () => {
        const root = await scratch()
        const env = { XDG_RUNTIME_DIR: await scratch() }
        const one = inProcessLauncher(join(root, 'local', 'One-abc'), env, { target: { kind: 'folder', path: '/tmp/One' } })
        const two = inProcessLauncher(join(root, 'sync.example.com', 'graph-2'), env, { target: { kind: 'synced', server: 'https://sync.example.com', graphId: 'graph-2' }, backendKind: 'synced' })
        for (const { launcher } of [one, two]) (await requestHost(launcher, { etherpk: 'status', protocol: HOST_PROTOCOL })).socket.destroy()

        expect((await runningHosts({ ETHERPK_MCP_CACHE_DIR: root })).map((host) => host.status.target.kind).sort()).toEqual(['folder', 'synced'])
        const stopped = await stopHosts({ ETHERPK_MCP_CACHE_DIR: root }, 'logout', (host) => host.record.target.kind === 'synced')

        expect(stopped.map((host) => [host.record.target.kind, host.stopped])).toEqual([['synced', true]])
        expect(two.exits).toEqual([0])
        expect(one.exits).toEqual([])
        expect((await runningHosts({ ETHERPK_MCP_CACHE_DIR: root })).map((host) => host.status.target.kind)).toEqual(['folder'])
    })
})

describe('starting a host process', () => {
    async function spawnScript(script: string) {
        const dir = await scratch()
        const logPath = join(dir, 'cache', 'host.log')
        const announcement = await spawnHostProcess({ args: [], env: process.env, logPath, program: [process.execPath, '-e', script], timeoutMs: 10_000 })
        return { announcement, logPath }
    }

    it('reads the line the host announces, even when the host leaves straight after', async () => {
        const { announcement } = await spawnScript(`process.stdout.write(JSON.stringify({ endpoint: '/run/x.sock', pid: 42 }) + '\\n')`)
        expect(announcement).toEqual({ endpoint: '/run/x.sock', pid: 42 })
    })

    it('says where the log is when the host exits without announcing, and the log has what it said', async () => {
        const { announcement, logPath } = await spawnScript(`console.error('the folder is not a graph'); process.exit(3)`)
        expect(announcement).toEqual({ failed: `The background process for this graph exited (code 3) before it started. Its log is ${logPath}.` })
        expect(await readFile(logPath, 'utf8')).toContain('the folder is not a graph')
    })

    it('passes on a failure the host announces', async () => {
        const { announcement } = await spawnScript(`process.stdout.write(JSON.stringify({ failed: 'could not listen' }) + '\\n')`)
        expect(announcement).toEqual({ failed: 'could not listen' })
    })

    it('starts the host without the token and Recovery Code a scripted login reads, and with the rest', async () => {
        const logPath = join(await scratch(), 'cache', 'host.log')
        const env = { ...process.env, ETHERPK_PAT: 'epk_pat_example', ETHERPK_RECOVERY_CODE: 'example-code', ETHERPK_MCP_HOST_IDLE_SECONDS: '7' }
        const script = `console.error('seen', ['ETHERPK_PAT', 'ETHERPK_RECOVERY_CODE', 'ETHERPK_MCP_HOST_IDLE_SECONDS'].map((name) => process.env[name] ?? '-').join(' ')); process.exit(3)`
        await spawnHostProcess({ args: [], env, logPath, program: [process.execPath, '-e', script], timeoutMs: 10_000 })
        expect(await readFile(logPath, 'utf8')).toContain('seen - - 7')
    })
})
