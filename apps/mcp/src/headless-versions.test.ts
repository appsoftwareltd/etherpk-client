import { afterEach, describe, expect, it, vi } from 'vitest'

import { createGraphKeyring } from '#lib/crypto/index.js'
import { createLoopbackRelay } from '#lib/sync/loopback-relay.js'
import { fixedSyncToken } from '#lib/sync/sync-token.js'
import type { GraphVersions } from '#lib/sync/version-history/graph-versions.js'

import { openHeadlessGraph, type HeadlessGraph } from './headless-graph'
import { headlessVersions, type HeadlessVersions } from './headless-versions'
import { createPage, editDocument, listVersions, readVersion } from './tools'

const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde23000'
const open: HeadlessGraph[] = []
afterEach(async () => {
    await Promise.all(open.splice(0).map((g) => g.dispose()))
})

async function syncedGraph(id: string): Promise<HeadlessGraph> {
    const graphId = `${id}-${Math.floor(performance.now() * 1000)}`
    const graph = await openHeadlessGraph({
        graphId,
        rootDocId: ROOT,
        keyring: createGraphKeyring(id),
        relayUrl: 'ws://loopback/sync',
        token: fixedSyncToken('t'),
        presenceName: 'Agent',
        connect: createLoopbackRelay().connect,
        localCacheName: `${graphId}/agent`,
    })
    open.push(graph)
    return graph
}

/** A GraphVersions whose recorder only notes what it is asked to record. */
function recordingVersions() {
    const record = vi.fn(async () => 'queued' as const)
    const versions = {
        recorder: { record, flush: vi.fn(async () => {}) },
        history: {
            list: vi.fn(async () => ({
                versions: [{ versionId: '33333333-3333-4333-8333-333333333333', createdAt: '2026-11-11T09:00:00.000Z', reason: 'before_agent_write' as const, bytes: 10, epochId: 1 }],
                policy: { retentionDays: 30, reduction: null, removalPaused: false },
            })),
            read: vi.fn(async () => ({ v: 1 as const, identity: { kind: 'page' as const, title: 'Garden', aliases: [] }, text: '- water the beans' })),
        },
    } as unknown as GraphVersions
    return { versions, record }
}

describe('Version History in the Headless Client (ADR 0184)', () => {
    it('makes one version of a document before a session’s first write to it, and none after', async () => {
        const graph = await syncedGraph('g-agent-versions')
        await createPage(graph, { title: 'Garden', text: '- water the beans' })
        const { versions, record } = recordingVersions()
        const docId = 'doc-garden'
        const history: HeadlessVersions = headlessVersions(versions, (concept) => (concept === 'Garden' ? docId : undefined))
        const session = { ...graph, versions: history.forSession() }

        await editDocument(session, { concept: 'Garden', old: '- water the beans', new: '- water the peas' })
        await editDocument(session, { concept: 'Garden', old: '- water the peas', new: '- water the leeks' })
        expect(record).toHaveBeenCalledTimes(1)
        expect(record).toHaveBeenCalledWith(docId, 'before_agent_write', { wait: true })

        // Another session is another agent: its first write makes its own version.
        const other = { ...graph, versions: history.forSession() }
        await editDocument(other, { concept: 'Garden', old: '- water the leeks', new: '- water the kale' })
        expect(record).toHaveBeenCalledTimes(2)
    })

    it('lists and reads versions, and says a graph opened without the HTTP API keeps none', async () => {
        const graph = await syncedGraph('g-agent-list')
        await createPage(graph, { title: 'Garden', text: '- water the beans' })
        const { versions } = recordingVersions()
        const session = { ...graph, versions: headlessVersions(versions, () => 'doc-garden') }

        const listed = await listVersions(session, 'Garden')
        expect(listed).toEqual({
            concept: 'Garden',
            versions: [{ version: '33333333-3333-4333-8333-333333333333', createdAt: '2026-11-11T09:00:00.000Z', madeBy: 'Before an agent’s edit' }],
            keptDays: 30,
        })
        const read = await readVersion(session, 'Garden', '33333333-3333-4333-8333-333333333333')
        expect(read).toMatchObject({ concept: 'Garden', nameThen: 'Garden', text: '- water the beans', truncated: false })

        // Opened without the Sync Server's HTTP API, as this test's graph is.
        await expect(listVersions(graph, 'Garden')).rejects.toMatchObject({ code: 'versions_unavailable' })
    })
})
