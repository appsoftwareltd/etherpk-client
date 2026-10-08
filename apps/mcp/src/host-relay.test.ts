import { afterEach, describe, expect, it, vi } from 'vitest'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

import { createGraphKeyring } from '$lib/crypto'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { fixedSyncToken } from '$lib/sync/sync-token'

import { openHeadlessGraph, type HeadlessGraph } from './headless-graph'
import { HOST_LOST_MESSAGE, createRelay, type Backend } from './host-relay'
import { createMcpServer } from './mcp-server'
import { ToolError } from './tools'

const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde22000'
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function openTestGraph(): Promise<HeadlessGraph> {
    const relay = createLoopbackRelay()
    const graph = await openHeadlessGraph({
        graphId: `g-relay-${Math.floor(performance.now() * 1000)}`,
        rootDocId: ROOT,
        keyring: createGraphKeyring('g-relay'),
        relayUrl: 'ws://loopback/sync',
        token: fixedSyncToken('t'),
        presenceName: 'Agent on test',
        connect: relay.connect,
    })
    cleanup.push(() => graph.dispose())
    return graph
}

/** A host's session in this process: an MCP server over `graph`, with what it received and a way to end it. */
async function hostSession(graph: HeadlessGraph | Promise<HeadlessGraph>, kind: Backend['kind'] = 'host') {
    const server = createMcpServer(graph, { graphName: 'Notes', version: '0.0.0-test', backendKind: 'synced' })
    const [relaySide, hostSide] = InMemoryTransport.createLinkedPair()
    const received: JSONRPCMessage[] = []
    hostSide.onmessage = (message) => received.push(message)
    const closed = new Promise<void>((resolve) => {
        server.server.onclose = () => resolve()
    })
    await server.connect(hostSide)
    cleanup.push(() => server.close())
    return { backend: { transport: relaySide, kind } satisfies Backend, received, closed, end: () => server.close() }
}

/** An agent connected through a relay whose `connect` hands out `backends` in turn. */
async function agentThrough(backends: Array<() => Promise<Backend>>, options: { retryUnavailableMs?: number; now?: () => number } = {}) {
    const connects = vi.fn(async () => {
        const next = backends.shift()
        if (!next) throw new Error('no more backends in this test')
        return next()
    })
    const [agentSide, relaySide] = InMemoryTransport.createLinkedPair()
    const log: string[] = []
    const relay = createRelay({ agent: relaySide, connect: connects, log: (line) => log.push(line), retryUnavailableMs: options.retryUnavailableMs, now: options.now })
    await relay.start()
    const client = new Client({ name: 'test-agent', version: '0.0.0' })
    await client.connect(agentSide)
    cleanup.push(async () => {
        await client.close()
        await relay.close()
    })
    return { client, relay, connects, log }
}

function text(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
    const content = (result as { content: Array<{ type: string; text: string }> }).content
    return JSON.parse(content[0].text) as Record<string, unknown>
}

describe('the relay between an agent and its graph\'s host', () => {
    it('carries the session both ways', async () => {
        const graph = await openTestGraph()
        const host = await hostSession(graph)
        const { client } = await agentThrough([async () => host.backend])

        expect(client.getInstructions()).toContain('"Notes"')
        expect(text(await client.callTool({ name: 'create_page', arguments: { title: 'Plan', text: '- one' } }))).toEqual({ concept: 'Plan', created: true })
        expect(host.received.map((message) => ('method' in message ? message.method : 'answer'))).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
    })

    it('starts the next host on the session the agent began, without the agent seeing it twice', async () => {
        const graph = await openTestGraph()
        const first = await hostSession(graph)
        const second = await hostSession(graph)
        const { client, connects, log } = await agentThrough([async () => first.backend, async () => second.backend])
        await client.callTool({ name: 'create_page', arguments: { title: 'Plan', text: '- one' } })

        await first.end()
        await vi.waitFor(() => expect(log.join('\n')).toContain('went away'))
        // Not until the agent asks for something: a stopped host stays stopped while its agents are idle.
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(connects).toHaveBeenCalledOnce()

        expect(text(await client.callTool({ name: 'read_document', arguments: { concept: 'Plan' } }))).toMatchObject({ text: '- one' })
        expect(connects).toHaveBeenCalledTimes(2)
        expect(second.received.map((message) => ('method' in message ? message.method : 'answer'))).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
    })

    it('answers a tool call the host left unanswered with an error, and does not send it again', async () => {
        const graph = await openTestGraph()
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        cleanup.push(() => release())
        const slow: HeadlessGraph = { ...graph, store: { ...graph.store, refresh: () => gate.then(() => graph.store.refresh()) } }
        const first = await hostSession(slow)
        const second = await hostSession(graph)
        const { client } = await agentThrough([async () => first.backend, async () => second.backend])

        const call = client.callTool({ name: 'create_page', arguments: { title: 'Plan', text: '- one' } })
        await vi.waitFor(() => expect(first.received.some((message) => 'method' in message && message.method === 'tools/call')).toBe(true))
        await first.end()

        await expect(call).rejects.toThrow(HOST_LOST_MESSAGE)
        // The next call reaches the next host, and the call the first one took is not sent again.
        expect(text(await client.callTool({ name: 'list_documents', arguments: {} }))).toMatchObject({ total: 0 })
        const calls = second.received.filter((message) => 'method' in message && message.method === 'tools/call') as unknown as Array<{ params: { name: string } }>
        expect(calls.map((message) => message.params.name)).toEqual(['list_documents'])
    })

    it('sends a call the host never received to the next host', async () => {
        const graph = await openTestGraph()
        const first = await hostSession(graph)
        // The first host's connection has gone by the time the call is written to it.
        first.backend.transport.send = async (message) => {
            if ('method' in message && message.method === 'tools/call') {
                void first.end()
                throw new Error('write EPIPE')
            }
            return InMemoryTransport.prototype.send.call(first.backend.transport, message)
        }
        const second = await hostSession(graph)
        const { client } = await agentThrough([async () => first.backend, async () => second.backend])

        expect(text(await client.callTool({ name: 'create_page', arguments: { title: 'Plan', text: '- one' } }))).toEqual({ concept: 'Plan', created: true })
        expect(second.received.filter((message) => 'method' in message && message.method === 'tools/call')).toHaveLength(1)
    })

    it('asks the next host again for a listing the last one left unanswered', async () => {
        const graph = await openTestGraph()
        const first = await hostSession(graph)
        // The first host takes the listing and goes before it answers.
        first.backend.transport.send = async (message) => {
            if ('method' in message && message.method === 'tools/list') {
                void first.end()
                return
            }
            return InMemoryTransport.prototype.send.call(first.backend.transport, message)
        }
        const second = await hostSession(graph)
        const { client } = await agentThrough([async () => first.backend, async () => second.backend])

        const { tools } = await client.listTools()

        expect(tools.length).toBeGreaterThan(10)
    })

    it('answers with the reason while there is no host, and tries again on a later call', async () => {
        const graph = await openTestGraph()
        const reason = Promise.reject(new ToolError('graph_unavailable', 'Not logged in on this machine. Run: etherpk-mcp login'))
        const standIn = await hostSession(reason, 'unavailable')
        const host = await hostSession(graph)
        let clock = 1_000_000
        const { client, connects } = await agentThrough([async () => standIn.backend, async () => host.backend], { retryUnavailableMs: 10_000, now: () => clock })

        const refused = await client.callTool({ name: 'list_documents', arguments: {} })
        expect(refused.isError).toBe(true)
        expect(text(refused)).toEqual({ error: 'graph_unavailable', message: 'Not logged in on this machine. Run: etherpk-mcp login' })
        expect(connects).toHaveBeenCalledTimes(1)

        clock += 10_000
        expect(text(await client.callTool({ name: 'list_documents', arguments: {} }))).toMatchObject({ total: 0 })
        expect(connects).toHaveBeenCalledTimes(2)
        expect(host.received.map((message) => ('method' in message ? message.method : 'answer')).slice(0, 2)).toEqual(['initialize', 'notifications/initialized'])
    })

    it('holds what the agent says until the host is found, and delivers it in order', async () => {
        const graph = await openTestGraph()
        const host = await hostSession(graph)
        let found!: () => void
        const finding = new Promise<void>((resolve) => {
            found = resolve
        })
        const connected = agentThrough([
            async () => {
                await finding
                return host.backend
            },
        ])
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(host.received).toEqual([])
        found()

        const { client } = await connected
        expect(text(await client.callTool({ name: 'list_documents', arguments: {} }))).toMatchObject({ total: 0 })
        expect(host.received.map((message) => ('method' in message ? message.method : 'answer'))).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
    })

    it('refuses the waiting calls when every host closes the connection as the session starts', async () => {
        const closing = (): Backend => {
            const transport: Backend['transport'] = {
                start: async () => transport.onclose?.(),
                send: async () => {},
                close: async () => {},
            }
            return { transport, kind: 'host' }
        }
        const [agentSide, relaySide] = InMemoryTransport.createLinkedPair()
        const log: string[] = []
        const connects = vi.fn(async () => closing())
        const relay = createRelay({ agent: relaySide, connect: connects, log: (line) => log.push(line) })
        cleanup.push(() => relay.close())
        await relay.start()
        const client = new Client({ name: 'test-agent', version: '0.0.0' })

        await expect(client.connect(agentSide)).rejects.toThrow('kept closing the connection')
        expect(connects).toHaveBeenCalledTimes(5)
    })

    it('ends the host\'s session when the agent leaves', async () => {
        const graph = await openTestGraph()
        const host = await hostSession(graph)
        const { client } = await agentThrough([async () => host.backend])

        await client.close()

        await host.closed
    })
})
