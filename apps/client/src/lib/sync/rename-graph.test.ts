import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'

import type { TransportSocket } from './graph-sync'
import { openSyncedGraphMetaSession } from './rename-graph'
import { fixedSyncToken } from './sync-token'

const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10000'

/** A relay that accepts the connection attempt and never opens the socket. */
function neverOpens(): TransportSocket {
    return { send() {}, close() {}, onOpen() {}, onMessage() {}, onClose() {} }
}

describe('openSyncedGraphMetaSession', () => {
    it('gives up on a relay that never opens the socket, so a rename or a name read cannot hang', async () => {
        const graphId = `g-meta-timeout-${Math.floor(performance.now() * 1000)}`

        await expect(
            openSyncedGraphMetaSession({
                graphId,
                rootDocId: ROOT,
                keyring: createGraphKeyring(graphId),
                relayUrl: 'ws://never/sync',
                token: fixedSyncToken('t'),
                connect: neverOpens,
                connectTimeoutMs: 50,
            }),
        ).rejects.toThrow(/could not reach/i)
    })
})
