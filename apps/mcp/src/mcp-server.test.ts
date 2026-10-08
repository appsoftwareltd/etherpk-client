import { afterEach, describe, expect, it } from 'vitest'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { createGraphKeyring } from '$lib/crypto'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { fixedSyncToken } from '$lib/sync/sync-token'

import { openHeadlessGraph, type HeadlessGraph } from './headless-graph'
import { createMcpServer } from './mcp-server'
import { ToolError } from './tools'

/**
 * The MCP surface end to end in one process: a real client over an in-memory transport pair,
 * the tool registry, argument validation, and the error envelope a refusal travels in.
 */

const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde22000'
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
    // Last in, first out: the client and server close before the graph they used is disposed.
    for (const fn of cleanup.splice(0).reverse()) await fn()
})

/** A synced graph over the loopback relay, disposed after the test. */
async function openTestGraph(): Promise<HeadlessGraph> {
    const relay = createLoopbackRelay()
    const graph = await openHeadlessGraph({
        graphId: `g-mcp-${Math.floor(performance.now() * 1000)}`,
        rootDocId: ROOT,
        keyring: createGraphKeyring('g-mcp'),
        relayUrl: 'ws://loopback/sync',
        token: fixedSyncToken('t'),
        presenceName: 'Agent on test',
        connect: relay.connect,
    })
    cleanup.push(() => graph.dispose())
    return graph
}

async function connected(extra: { credentialsDir?: string } = {}): Promise<{ client: Client; graph: HeadlessGraph }> {
    const graph = await openTestGraph()
    const server = createMcpServer(graph, { graphName: 'Notes', version: '0.0.0-test', ...extra })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    const client = new Client({ name: 'test-agent', version: '0.0.0' })
    await client.connect(clientSide)
    cleanup.push(async () => {
        await client.close()
        await server.close()
    })
    return { client, graph }
}

function text(result: Awaited<ReturnType<Client['callTool']>>): unknown {
    const content = (result as { content: Array<{ type: string; text: string }> }).content
    return JSON.parse(content[0].text)
}

describe('the MCP server', () => {
    it('registers the tools and names the graph in its instructions', async () => {
        const { client } = await connected()
        const { tools } = await client.listTools()
        expect(tools.map((tool) => tool.name).sort()).toEqual([
            'add_task_note',
            'append_document',
            'backlinks',
            'create_page',
            'create_publication',
            'create_theme',
            'customise_publication_theme',
            'delete_theme',
            'delete_theme_file',
            'edit_document',
            'graph_info',
            'graph_insights',
            'graph_path',
            'import_theme_folder',
            'list_assets',
            'list_documents',
            'list_publications',
            'list_themes',
            'plan_rename',
            'preview_theme',
            'publish',
            'read_asset',
            'read_document',
            'read_documents',
            'read_task',
            'read_theme',
            'read_theme_file',
            'rename',
            'search',
            'set_aliases',
            'set_frontmatter',
            'set_task',
            'tasks',
            'update_publication',
            'upload_asset',
            'write_theme_file',
        ])
        expect(client.getInstructions()).toContain('"Notes"')
        expect(client.getInstructions()).toContain('protected')
    })

    // An agent that goes looking for the notes on disk finds the sign-in instead, so the
    // instructions say where the graph is not, and which directory to leave alone.
    it('tells the agent a synced graph has no folder and that its sign-in is not to be read', async () => {
        const { client } = await connected()
        const instructions = client.getInstructions() ?? ''
        expect(instructions).toContain('no folder on this computer')
        expect(instructions).toContain('Never read, print, copy or search ~/.config/etherpk')
    })

    // XDG_CONFIG_HOME and ETHERPK_MCP_CONFIG move the login file, so the folder named is the real one.
    it('names the folder this process keeps its sign-in in, wherever that is', async () => {
        const { client } = await connected({ credentialsDir: '/srv/agent/cfg/etherpk' })
        expect(client.getInstructions()).toContain('Never read, print, copy or search /srv/agent/cfg/etherpk')
    })

    // A graph can take longer to open than a client waits for `initialize` (30 seconds in Claude
    // Code), so the server answers at once and each tool waits for the graph.
    it('answers initialize and lists its tools before the graph has opened, and a tool waits for it', async () => {
        const opened = await openTestGraph()
        let open!: (graph: HeadlessGraph) => void
        const opening = new Promise<HeadlessGraph>((resolve) => {
            open = resolve
        })
        const server = createMcpServer(opening, { graphName: 'Notes', version: '0.0.0-test', backendKind: 'synced' })
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
        await server.connect(serverSide)
        const client = new Client({ name: 'test-agent', version: '0.0.0' })
        cleanup.push(async () => {
            await client.close()
            await server.close()
        })

        await client.connect(clientSide)
        expect(client.getInstructions()).toContain('no folder on this computer')
        expect((await client.listTools()).tools.length).toBeGreaterThan(10)

        let answered = false
        const call = client.callTool({ name: 'create_page', arguments: { title: 'Plan', text: '- one' } }).then((result) => {
            answered = true
            return result
        })
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(answered).toBe(false)
        open(opened)
        expect(text(await call)).toEqual({ concept: 'Plan', created: true })
    })

    it('answers every tool with the reason when the graph could not be opened', async () => {
        const failed = Promise.reject(new ToolError('graph_unavailable', 'Not logged in on this machine.'))
        const server = createMcpServer(failed, { graphName: 'Notes', version: '0.0.0-test', backendKind: 'folder' })
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
        await server.connect(serverSide)
        const client = new Client({ name: 'test-agent', version: '0.0.0' })
        cleanup.push(async () => {
            await client.close()
            await server.close()
        })
        await client.connect(clientSide)

        const result = await client.callTool({ name: 'list_documents', arguments: {} })
        expect(result.isError).toBe(true)
        expect(text(result)).toEqual({ error: 'graph_unavailable', message: 'Not logged in on this machine.' })
    })

    it('creates, reads, edits and lists through the wire', async () => {
        const { client } = await connected()
        expect(text(await client.callTool({ name: 'create_page', arguments: { title: 'Plan', text: '- one' } }))).toEqual({ concept: 'Plan', created: true })
        expect(text(await client.callTool({ name: 'edit_document', arguments: { concept: 'plan', old: '- one', new: '- one\n- two' } }))).toMatchObject({ concept: 'Plan' })
        expect(text(await client.callTool({ name: 'read_document', arguments: { concept: 'Plan' } }))).toMatchObject({ text: '- one\n- two' })
        expect(text(await client.callTool({ name: 'list_documents', arguments: {} }))).toMatchObject({ total: 1 })
        expect(text(await client.callTool({ name: 'set_frontmatter', arguments: { concept: 'Plan', patch: { public: true, publications: ['docs'] } } }))).toMatchObject({ frontmatter: { public: true, publications: ['docs'] } })
        expect(text(await client.callTool({ name: 'read_document', arguments: { concept: 'Plan' } }))).toMatchObject({ text: '- one\n- two', frontmatter: { public: true, publications: ['docs'] } })
    })

    it('returns a refusal as an isError result carrying the code, not a protocol error', async () => {
        const { client } = await connected()
        const result = await client.callTool({ name: 'read_document', arguments: { concept: 'Nope' } })
        expect(result.isError).toBe(true)
        expect(text(result)).toEqual({ error: 'not_found', message: 'No document is named "Nope".' })
    })

    it('offers search a mode, describes when to use each, and reports semantic_unavailable when not set up', async () => {
        const { client } = await connected()
        const { tools } = await client.listTools()
        const search = tools.find((tool) => tool.name === 'search')
        expect(search?.description).toMatch(/mode "semantic"/)
        expect(search?.description).toMatch(/semantic_unavailable/)
        expect(client.getInstructions()).toMatch(/semantic/)
        const result = await client.callTool({ name: 'search', arguments: { query: 'anything', mode: 'semantic' } })
        expect(result.isError).toBe(true)
        expect(text(result)).toMatchObject({ error: 'semantic_unavailable' })
        expect(text(await client.callTool({ name: 'search', arguments: { query: 'anything' } }))).toMatchObject({ mode: 'text', results: [] })
    })

    it('rejects arguments outside the schema before any tool runs', async () => {
        const { client } = await connected()
        const result = await client.callTool({ name: 'list_documents', arguments: { limit: 10_000 } })
        expect(result.isError).toBe(true)
    })
})

/**
 * A Headless Client whose membership or token is revoked stops syncing, and every tool says why
 * rather than answering from its cache.
 */
describe('the MCP server after access ends', () => {
    async function withRelayControl() {
        const relay = createLoopbackRelay()
        let closeWith: ((code: number) => void) | undefined
        const losses: unknown[] = []
        const connect = (url: string) => {
            const inner = relay.connect(url)
            return {
                send: (data: string) => inner.send(data),
                close: () => inner.close(),
                onOpen: (cb: () => void) => inner.onOpen(cb),
                onMessage: (cb: (data: string) => void) => inner.onMessage(cb),
                onClose: (cb: (event?: { code: number; reason: string }) => void) => {
                    closeWith = (code) => cb({ code, reason: '' })
                    inner.onClose(() => cb())
                },
            }
        }
        const graph = await openHeadlessGraph({
            graphId: `g-mcp-lost-${Math.floor(performance.now() * 1000)}`,
            rootDocId: ROOT,
            keyring: createGraphKeyring('g-mcp-lost'),
            relayUrl: 'ws://loopback/sync',
            token: fixedSyncToken('t'),
            presenceName: 'Agent on test',
            connect,
            onAccessLost: (loss) => losses.push(loss),
        })
        const server = createMcpServer(graph, { graphName: 'Notes', version: '0.0.0-test' })
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
        await server.connect(serverSide)
        const client = new Client({ name: 'test-agent', version: '0.0.0' })
        await client.connect(clientSide)
        cleanup.push(async () => {
            await client.close()
            await server.close()
            await graph.dispose()
        })
        return { client, losses, close: (code: number) => closeWith!(code) }
    }

    it('refuses every tool with access_removed once the relay says the membership ended', async () => {
        const { client, losses, close } = await withRelayControl()
        close(4403)

        const result = await client.callTool({ name: 'list_documents', arguments: {} })
        expect(result.isError).toBe(true)
        expect(text(result)).toMatchObject({ error: 'access_removed' })
        expect(losses).toEqual([{ kind: 'membership' }])
    })
})

