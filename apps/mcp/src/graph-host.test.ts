import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'

import { createGraphKeyring } from '$lib/crypto'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { fixedSyncToken } from '$lib/sync/sync-token'

import { runGraphHost, sessionGraph, type GraphHostDeps, type HostedGraph } from './graph-host'
import { hostEndpoint, readHostRecord } from './host-endpoint'
import { HOST_PROTOCOL, HostImpostor, connectEndpoint, hostRequest, readJsonLine, whenClosed, writeJsonLine, type HostReply } from './host-protocol'
import { openHeadlessGraph, type HeadlessGraph } from './headless-graph'
import { SocketTransport } from './socket-transport'

const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde22000'
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'etherpk-host-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    return dir
}

async function loopbackGraph(): Promise<HeadlessGraph> {
    const relay = createLoopbackRelay()
    return openHeadlessGraph({
        graphId: `g-host-${Math.floor(performance.now() * 1000)}`,
        rootDocId: ROOT,
        keyring: createGraphKeyring('g-host'),
        relayUrl: 'ws://loopback/sync',
        token: fixedSyncToken('t'),
        presenceName: 'Agent on test',
        connect: relay.connect,
    })
}

interface StartedHost {
    deps: GraphHostDeps
    announced: Array<{ endpoint: string; pid: number } | { failed: string }>
    exits: number[]
    log: string[]
    stop(reason: string): Promise<void>
}

/** A host over `open`, in this process, with exits and announcements recorded instead of acted on. */
async function host(cacheDir: string, env: NodeJS.ProcessEnv, overrides: Partial<GraphHostDeps> = {}): Promise<StartedHost> {
    const announced: StartedHost['announced'] = []
    const exits: number[] = []
    const log: string[] = []
    const deps: GraphHostDeps = {
        cacheDir,
        endpoint: hostEndpoint(cacheDir, env),
        version: '0.10.0',
        target: { kind: 'folder', path: '/tmp/Notes' },
        provisionalName: 'Notes',
        backendKind: 'synced',
        idleMs: 60_000,
        cmd: 'etherpk-mcp',
        credentialsDir: '~/.config/etherpk',
        open: async () => {
            const graph = await loopbackGraph()
            return { graph, wantSemantic: () => {} }
        },
        publish: async () => ({ etherpk: 'published', output: { ok: true }, notes: [], exitCode: 0 }),
        log: (line) => log.push(line),
        announce: (message) => announced.push(message),
        exit: (code) => exits.push(code),
        ...overrides,
    }
    const handle = await runGraphHost(deps)
    cleanup.push(() => handle.stop('the test ended'))
    return { deps, announced, exits, log, stop: handle.stop }
}

/** An MCP session through the host, as a relaying `serve` opens one. */
async function session(endpoint: string, request: { version?: string; noSemantic?: boolean } = {}): Promise<{ client: Client; reply: HostReply }> {
    const { reply, socket } = await hostRequest(endpoint, { etherpk: 'session', protocol: HOST_PROTOCOL, version: request.version ?? '0.10.0', noSemantic: request.noSemantic })
    if (reply.etherpk !== 'ok') {
        socket.destroy()
        return { client: undefined as unknown as Client, reply }
    }
    const client = new Client({ name: 'test-agent', version: '0.0.0' })
    await client.connect(new SocketTransport(socket))
    cleanup.push(() => client.close())
    return { client, reply }
}

function text(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
    const content = (result as { content: Array<{ type: string; text: string }> }).content
    return JSON.parse(content[0].text) as Record<string, unknown>
}

async function environment(): Promise<NodeJS.ProcessEnv> {
    return { XDG_RUNTIME_DIR: await scratch() }
}

describe('a graph host', () => {
    it('serves every session the same graph: what one writes, the other reads at once', async () => {
        const env = await environment()
        const started = await host(join(await scratch(), 'graph'), env)
        const [endpoint] = started.announced as Array<{ endpoint: string }>

        const first = await session(endpoint.endpoint)
        const second = await session(endpoint.endpoint)
        expect(text(await first.client.callTool({ name: 'create_page', arguments: { title: 'Plan', text: '- one' } }))).toEqual({ concept: 'Plan', created: true })
        expect(text(await second.client.callTool({ name: 'read_document', arguments: { concept: 'Plan' } }))).toMatchObject({ text: '- one' })

        const { reply, socket } = await hostRequest(endpoint.endpoint, { etherpk: 'status', protocol: HOST_PROTOCOL })
        socket.destroy()
        expect(reply).toMatchObject({ etherpk: 'status', status: { sessions: 2, graph: { state: 'open' }, version: '0.10.0' } })
    })

    it('records itself in the cache directory, and says where it listens', async () => {
        const env = await environment()
        const cacheDir = join(await scratch(), 'graph')
        const started = await host(cacheDir, env)

        expect(started.announced).toEqual([{ endpoint: hostEndpoint(cacheDir, env), pid: process.pid }])
        expect(await readHostRecord(cacheDir)).toMatchObject({ pid: process.pid, endpoint: hostEndpoint(cacheDir, env), version: '0.10.0' })
    })

    it('answers a session while the graph is still opening, and its tools wait', async () => {
        const env = await environment()
        let open!: (hosted: HostedGraph) => void
        const started = await host(join(await scratch(), 'graph'), env, {
            open: () =>
                new Promise((resolve) => {
                    open = resolve
                }),
        })
        const { endpoint } = started.announced[0] as { endpoint: string }

        const { client, reply } = await session(endpoint)
        expect(reply).toMatchObject({ etherpk: 'ok', status: { graph: { state: 'opening', name: 'Notes' } } })
        expect(client.getInstructions()).toContain('"Notes"')
        const created = client.callTool({ name: 'create_page', arguments: { title: 'Plan', text: '- one' } })
        open({ graph: await loopbackGraph(), wantSemantic: () => {} })
        expect(text(await created)).toEqual({ concept: 'Plan', created: true })
    })

    it('defers to a live host of the same graph, telling its starter where that one listens', async () => {
        const env = await environment()
        const cacheDir = join(await scratch(), 'graph')
        const first = await host(cacheDir, env)
        const secondEndpoint = join(await scratch(), 'other.sock')

        // Another process, as far as the record is concerned: two hosts in one test share one.
        const second = await host(cacheDir, env, { endpoint: secondEndpoint, pid: process.pid + 1_000_000 })

        expect(second.announced).toEqual(first.announced)
        expect(second.exits).toEqual([0])
    })

    it('answers every tool with the reason when its graph cannot open, and a later call opens it', async () => {
        const env = await environment()
        let attempts = 0
        let clock = 1_000_000
        const started = await host(join(await scratch(), 'graph'), env, {
            open: async () => {
                attempts++
                if (attempts === 1) throw new Error('Not logged in on this machine. Run: etherpk-mcp login')
                return { graph: await loopbackGraph(), wantSemantic: () => {} }
            },
            retryOpenMs: 10_000,
            now: () => clock,
        })
        const { endpoint } = started.announced[0] as { endpoint: string }
        await vi.waitFor(() => expect(started.log.join('\n')).toContain('Not logged in'), { timeout: 10_000 })

        const { client, reply } = await session(endpoint)
        expect(reply).toMatchObject({ etherpk: 'ok', status: { graph: { state: 'failed', message: 'Not logged in on this machine. Run: etherpk-mcp login' } } })
        const refused = await client.callTool({ name: 'list_documents', arguments: {} })
        expect(refused.isError).toBe(true)
        expect(text(refused)).toEqual({ error: 'graph_unavailable', message: 'Not logged in on this machine. Run: etherpk-mcp login' })
        expect(attempts).toBe(1)

        clock += 10_000
        expect(text(await client.callTool({ name: 'list_documents', arguments: {} }))).toMatchObject({ total: 0 })
        expect(attempts).toBe(2)
        expect(started.exits).toEqual([])
    })

    it('stops once the last session has been gone for its idle time, flushing the graph and giving up its claim', async () => {
        const env = await environment()
        const cacheDir = join(await scratch(), 'graph')
        const graph = await loopbackGraph()
        const dispose = vi.spyOn(graph, 'dispose')
        const started = await host(cacheDir, env, { idleMs: 50, open: async () => ({ graph, wantSemantic: () => {} }) })
        const { endpoint } = started.announced[0] as { endpoint: string }

        const { client } = await session(endpoint)
        await client.callTool({ name: 'list_documents', arguments: {} })
        await new Promise((resolve) => setTimeout(resolve, 120))
        expect(started.exits).toEqual([])
        await client.close()

        await vi.waitFor(() => expect(started.exits).toEqual([0]), { timeout: 10_000 })
        expect(dispose).toHaveBeenCalledOnce()
        expect(await readHostRecord(cacheDir)).toBeNull()
        if (process.platform !== 'win32') await expect(stat(endpoint)).rejects.toThrow()
    })

    it('flushes and exits when asked to stop, and the asker sees the connection close only then', async () => {
        const env = await environment()
        const cacheDir = join(await scratch(), 'graph')
        const started = await host(cacheDir, env)
        const { endpoint } = started.announced[0] as { endpoint: string }

        const { reply, socket } = await hostRequest(endpoint, { etherpk: 'stop', protocol: HOST_PROTOCOL, reason: 'logout' })
        expect(reply).toEqual({ etherpk: 'stopping' })
        await whenClosed(socket)
        expect(started.exits).toEqual([0])
        expect(await readHostRecord(cacheDir)).toBeNull()
    })

    it('lets a tool call that is running finish before it stops', async () => {
        const env = await environment()
        const graph = await loopbackGraph()
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        let running!: () => void
        const entered = new Promise<void>((resolve) => {
            running = resolve
        })
        const slow: HeadlessGraph = {
            ...graph,
            store: {
                ...graph.store,
                refresh: () => {
                    running()
                    return gate.then(() => graph.store.refresh())
                },
            },
        }
        const started = await host(join(await scratch(), 'graph'), env, { open: async () => ({ graph: slow, wantSemantic: () => {} }) })
        const { endpoint } = started.announced[0] as { endpoint: string }
        const { client } = await session(endpoint)

        const call = client.callTool({ name: 'list_documents', arguments: {} })
        await entered
        const stopped = started.stop('a test asked')
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(started.exits).toEqual([])
        release()

        expect(text(await call)).toMatchObject({ total: 0 })
        await stopped
        expect(started.exits).toEqual([0])
    })

    it('proves itself with the secret in its record, and a client refuses an answer without the proof', async () => {
        const env = await environment()
        const cacheDir = join(await scratch(), 'graph')
        const started = await host(cacheDir, env)
        const { endpoint } = started.announced[0] as { endpoint: string }
        const record = await readHostRecord(cacheDir)
        expect(record?.secret).toMatch(/^[0-9a-f]{64}$/)

        const proved = await hostRequest(endpoint, { etherpk: 'status', protocol: HOST_PROTOCOL }, { secret: record!.secret })
        proved.socket.destroy()
        expect(proved.reply.etherpk).toBe('status')
        await expect(hostRequest(endpoint, { etherpk: 'status', protocol: HOST_PROTOCOL }, { secret: 'ab'.repeat(32) })).rejects.toThrow(HostImpostor)
    })

    it('still answers a status while it stops, so a logout can wait for it', async () => {
        const env = await environment()
        const cacheDir = join(await scratch(), 'graph')
        const graph = await loopbackGraph()
        let release!: () => void
        const flushing = new Promise<void>((resolve) => {
            release = resolve
        })
        const slow: HeadlessGraph = { ...graph, dispose: () => flushing.then(() => graph.dispose()) }
        const started = await host(cacheDir, env, { open: async () => ({ graph: slow, wantSemantic: () => {} }) })
        const { endpoint } = started.announced[0] as { endpoint: string }

        const stopped = started.stop('a test asked')
        const { reply, socket } = await hostRequest(endpoint, { etherpk: 'status', protocol: HOST_PROTOCOL })
        socket.destroy()
        expect(reply).toMatchObject({ etherpk: 'status', status: { stopping: true } })
        const refused = await hostRequest(endpoint, { etherpk: 'session', protocol: HOST_PROTOCOL, version: '0.10.0' })
        refused.socket.destroy()
        expect(refused.reply).toEqual({ etherpk: 'stopping' })

        release()
        await stopped
        expect(started.exits).toEqual([0])
    })

    it('tells a client that speaks another protocol which version it is', async () => {
        const env = await environment()
        const started = await host(join(await scratch(), 'graph'), env)
        const { endpoint } = started.announced[0] as { endpoint: string }

        const socket = await connectEndpoint(endpoint)
        writeJsonLine(socket, { etherpk: 'status', protocol: HOST_PROTOCOL + 1 })
        expect(await readJsonLine(socket)).toEqual({ etherpk: 'unsupported', protocol: HOST_PROTOCOL, version: '0.10.0' })
        socket.destroy()
    })

    it('steps aside when a newer version has connected and its last session leaves', async () => {
        const env = await environment()
        const started = await host(join(await scratch(), 'graph'), env, { idleMs: 60_000 })
        const { endpoint } = started.announced[0] as { endpoint: string }

        const { client } = await session(endpoint, { version: '0.11.0' })
        await client.close()

        await vi.waitFor(() => expect(started.exits).toEqual([0]), { timeout: 10_000 })
        expect(started.log.join('\n')).toContain('0.11.0')
    })

    it.runIf(process.platform !== 'win32')('replaces a socket file a crashed host left behind', async () => {
        const env = await environment()
        const cacheDir = join(await scratch(), 'graph')
        const endpoint = hostEndpoint(cacheDir, env)
        await host(join(await scratch(), 'unrelated'), env) // makes the runtime directory
        await writeFile(endpoint, '')

        const started = await host(cacheDir, env)

        expect(started.announced).toEqual([{ endpoint, pid: process.pid }])
        const { reply, socket } = await hostRequest(endpoint, { etherpk: 'status', protocol: HOST_PROTOCOL })
        socket.destroy()
        expect(reply.etherpk).toBe('status')
    })

    it('runs a publish for the command line and answers with what to print', async () => {
        const env = await environment()
        const publish = vi.fn(async () => ({ etherpk: 'published' as const, output: { ok: true, folder: '/srv/site' }, notes: ['set the folder'], exitCode: 0 }))
        const started = await host(join(await scratch(), 'graph'), env, { publish })
        const { endpoint } = started.announced[0] as { endpoint: string }

        const { reply, socket } = await hostRequest(endpoint, { etherpk: 'publish', protocol: HOST_PROTOCOL, publication: 'docs', out: '/srv/site', env: {} })
        socket.destroy()

        expect(reply).toEqual({ etherpk: 'published', output: { ok: true, folder: '/srv/site' }, notes: ['set the folder'], exitCode: 0 })
        expect(publish).toHaveBeenCalledWith(expect.objectContaining({ graphId: expect.any(String) }), expect.objectContaining({ publication: 'docs', out: '/srv/site' }))
    })
})

describe('a session\'s view of the shared graph', () => {
    it('keeps its own uploads, and refuses semantic search when its agent turned it off', async () => {
        const graph = await loopbackGraph()
        cleanup.push(() => graph.dispose())
        const withAssets = { ...graph, assets: { store: undefined as never, identify: () => null, downloadsDir: '/tmp', uploaded: new Set<string>() } }

        const one = sessionGraph(withAssets, { noSemantic: false })
        const other = sessionGraph(withAssets, { noSemantic: true })
        one.assets?.uploaded.add('asset-1')

        expect(other.assets?.uploaded.has('asset-1')).toBe(false)
        await expect(other.semantic()).rejects.toThrow('--no-semantic')
        expect(one.graphId).toBe(graph.graphId)
    })
})
