import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'

import { createGraphSync, type TransportSocket } from './graph-sync'
import { openGraphCache } from './local-cache'
import { createLoopbackRelay } from './loopback-relay'
import { addQuickNoteOverSession } from './quick-note-session'
import { fixedSyncToken } from './sync-token'

const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10000'
const note = { id: 'n1', text: 'Ring the dentist', createdAt: 1_700_000_000_000 }

let counter = 0
/** A graph id no other test has a cache under. */
const freshGraph = () => `g-share-${Math.floor(performance.now() * 1000)}-${counter++}`

/** A relay that accepts the connection attempt and never opens the socket. */
function neverOpens(): TransportSocket {
    return { send() {}, close() {}, onOpen() {}, onMessage() {}, onClose() {} }
}

/** What a second device sees of the graph: its quick notes after catching up with the relay. */
async function notesOnAnotherDevice(relay: ReturnType<typeof createLoopbackRelay>, graphId: string, keyring: ReturnType<typeof createGraphKeyring>) {
    const cache = await openGraphCache(`${graphId}-other`)
    const other = createGraphSync({ graphId, rootDocId: ROOT, keyring, relayUrl: 'ws://loopback/sync', token: fixedSyncToken('t'), cache, connect: relay.connect, debounceMs: 5 })
    try {
        await other.ready()
        await other.connected()
        await other.rootCaughtUp()
        return other.quickNotes().list()
    } finally {
        other.dispose()
        cache.dispose()
    }
}

describe('addQuickNoteOverSession', () => {
    it('writes the note into the root doc, gets it acknowledged, and another device reads it back', async () => {
        const relay = createLoopbackRelay()
        const graphId = freshGraph()
        const keyring = createGraphKeyring(graphId)
        const seen: string[] = []

        const result = await addQuickNoteOverSession(
            { graphId, rootDocId: ROOT, keyring, relayUrl: 'ws://loopback/sync', token: fixedSyncToken('t'), connect: relay.connect, debounceMs: 5 },
            note,
            { onSaved: () => seen.push('saved') },
        )

        expect(result).toEqual({ synced: true })
        // "Saved" was reported before the ack came back, not after.
        expect(seen).toEqual(['saved'])
        expect(await notesOnAnotherDevice(relay, graphId, keyring)).toEqual([note])
        // The relay only ever saw ciphertext.
        expect(relay.allEnvelopes().some((e) => e.includes('dentist'))).toBe(false)
    })

    it('reports saved-but-not-synced when the relay never opens, within the connect timeout, and the note replays on the next session', async () => {
        const graphId = freshGraph()
        const keyring = createGraphKeyring(graphId)
        const started = performance.now()

        const result = await addQuickNoteOverSession(
            { graphId, rootDocId: ROOT, keyring, relayUrl: 'ws://never/sync', token: fixedSyncToken('t'), connect: neverOpens, connectTimeoutMs: 100, debounceMs: 5 },
            note,
        )

        expect(result).toEqual({ synced: false })
        expect(performance.now() - started).toBeLessThan(2_000)

        // The durable outbox holds it: a later engine over the same cache, against a relay that
        // does open, ships it without being asked - what the workspace's next open does.
        const relay = createLoopbackRelay()
        const cache = await openGraphCache(graphId)
        const later = createGraphSync({ graphId, rootDocId: ROOT, keyring, relayUrl: 'ws://loopback/sync', token: fixedSyncToken('t'), cache, connect: relay.connect, debounceMs: 5 })
        try {
            await later.ready()
            await later.connected()
            await expect(later.awaitAcked({ stallMs: 2_000 })).resolves.toEqual({ settled: true, outstanding: 0 })
        } finally {
            later.dispose()
            cache.dispose()
        }
        expect(await notesOnAnotherDevice(relay, graphId, keyring)).toEqual([note])
    })

    it('reports saved-but-not-synced when the relay stores the append but never acknowledges it', async () => {
        const relay = createLoopbackRelay({ ackAppends: false })
        const graphId = freshGraph()
        const keyring = createGraphKeyring(graphId)

        const result = await addQuickNoteOverSession(
            { graphId, rootDocId: ROOT, keyring, relayUrl: 'ws://loopback/sync', token: fixedSyncToken('t'), connect: relay.connect, ackStallMs: 150, debounceMs: 5 },
            note,
        )

        expect(result).toEqual({ synced: false })
    })
})

describe('addQuickNoteOverSession: cancelling the wait', () => {
    it('stops waiting for the relay when the signal aborts, keeps the note durable, and reports it unsynced', async () => {
        const graphId = freshGraph()
        const keyring = createGraphKeyring(graphId)
        const controller = new AbortController()
        const started = performance.now()

        const pending = addQuickNoteOverSession(
            { graphId, rootDocId: ROOT, keyring, relayUrl: 'ws://never/sync', token: fixedSyncToken('t'), connect: neverOpens, connectTimeoutMs: 10_000, debounceMs: 5, signal: controller.signal },
            note,
            { onSaved: () => controller.abort() },
        )

        expect(await pending).toEqual({ synced: false })
        // Well inside the ten-second connect timeout: the abort ended the wait, not the clock.
        expect(performance.now() - started).toBeLessThan(2_000)

        const relay = createLoopbackRelay()
        expect(await notesOnAnotherDevice(relay, graphId, keyring)).toEqual([])
        const cache = await openGraphCache(graphId)
        const later = createGraphSync({ graphId, rootDocId: ROOT, keyring, relayUrl: 'ws://loopback/sync', token: fixedSyncToken('t'), cache, connect: relay.connect, debounceMs: 5 })
        try {
            await later.ready()
            await later.connected()
            await expect(later.awaitAcked({ stallMs: 2_000 })).resolves.toEqual({ settled: true, outstanding: 0 })
        } finally {
            later.dispose()
            cache.dispose()
        }
        expect(await notesOnAnotherDevice(relay, graphId, keyring)).toEqual([note])
    })
})
