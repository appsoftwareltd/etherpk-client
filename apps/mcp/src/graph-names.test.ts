import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'
import { createGraphSync, type TransportSocket } from '$lib/sync/graph-sync'
import { openGraphCache } from '$lib/sync/local-cache'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { fixedSyncToken } from '$lib/sync/sync-token'

import { readGraphName } from './graph-names'

const GRAPH = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10000'
const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10001'

describe('readGraphName', () => {
    it('reads the canonical name from the root document and hands it to publishName', async () => {
        const keyring = createGraphKeyring(GRAPH)
        const relay = createLoopbackRelay()
        const writer = createGraphSync({
            graphId: GRAPH,
            rootDocId: ROOT,
            keyring,
            relayUrl: 'ws://loopback/sync',
            token: fixedSyncToken('t'),
            cache: await openGraphCache(`${GRAPH}-writer`),
            connect: relay.connect,
            debounceMs: 5,
        })
        await writer.ready()
        writer.setMetaName('Physics Notes')
        await writer.flushAll()

        const published: string[] = []
        const name = await readGraphName({
            graphId: GRAPH,
            rootDocId: ROOT,
            keyring,
            relayUrl: 'ws://loopback/sync',
            token: fixedSyncToken('t'),
            connect: relay.connect,
            publishName: (value) => published.push(value),
        })

        expect(name).toBe('Physics Notes')
        expect(published).toEqual(['Physics Notes'])
        writer.dispose()
    })

    it('gives up after the timeout when the relay never answers, publishing nothing', async () => {
        const silent = (): TransportSocket => ({
            send: () => {},
            close: () => {},
            onOpen: (cb) => cb(),
            onMessage: () => {},
            onClose: () => {},
        })
        const publishName = vi.fn()

        const name = await readGraphName({
            graphId: GRAPH,
            rootDocId: ROOT,
            keyring: createGraphKeyring(GRAPH),
            relayUrl: 'ws://silent/sync',
            token: fixedSyncToken('t'),
            connect: silent,
            timeoutMs: 100,
            publishName,
        })

        expect(name).toBeNull()
        expect(publishName).not.toHaveBeenCalled()
    })
})
