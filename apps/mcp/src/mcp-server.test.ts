import { afterEach, describe, expect, it } from 'vitest'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { createGraphKeyring } from '$lib/crypto'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { fixedSyncToken } from '$lib/sync/sync-token'

import { openHeadlessGraph, type HeadlessGraph } from './headless-graph'
import { createMcpServer } from './mcp-server'

/**
 * The MCP surface end to end in one process: a real client over an in-memory transport pair,
 * the tool registry, argument validation, and the error envelope a refusal travels in.
 */

const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde22000'
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn()
})

async function connected(): Promise<{ client: Client; graph: HeadlessGraph }> {
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
