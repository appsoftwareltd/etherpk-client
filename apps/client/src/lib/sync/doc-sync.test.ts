import * as Y from 'yjs'
import { describe, expect, it, vi } from 'vitest'
import { bumpEpoch, createGraphKeyring } from '$lib/crypto'
import {
    createDocSync,
    type DocCache,
    type DocCacheState,
    type DurableOutboxOperation,
} from './doc-sync'
import type { RelayClientMessage } from './messages'

function memoryCache(): DocCache {
    let state: DocCacheState | null = null
    const operations: DurableOutboxOperation[] = []

    function replaceState(
        next: DocCacheState,
        options?: {
            dirtyToken?: string
            supersededDirtyToken?: string
            settledDirtyTokens?: readonly string[]
        },
    ): void {
        const dirtyTokens = new Set([...(state?.dirtyTokens ?? []), ...(next.dirtyTokens ?? [])])
        if (options?.supersededDirtyToken) dirtyTokens.delete(options.supersededDirtyToken)
        if (options?.dirtyToken) dirtyTokens.add(options.dirtyToken)
        for (const token of options?.settledDirtyTokens ?? []) dirtyTokens.delete(token)
        const { dirtyTokens: _incoming, ...rest } = next
        state = dirtyTokens.size > 0 ? { ...rest, dirtyTokens: [...dirtyTokens].sort() } : rest
    }

    return {
        load: async () => state,
        save: async (s, options) => {
            replaceState(s, options)
        },
        async enqueue(operation, nextState, options) {
            replaceState(nextState, options)
            operations.push({
                graphId: 'g1',
                docId: 'd1',
                ...operation,
                attemptCount: 0,
                lastAttemptAt: null,
            })
        },
        async pending() {
            return [...operations]
        },
        async markAttempt(outboxId, attemptedAt) {
            const operation = operations.find((candidate) => candidate.outboxId === outboxId)
            if (!operation) return
            operation.attemptCount += 1
            operation.lastAttemptAt = attemptedAt
        },
        async commitAcknowledgement(outboxId, generation, seq, update, lastSyncedStateVector) {
            const index = operations.findIndex((candidate) => candidate.outboxId === outboxId)
            if (index < 0) return false
            const [operation] = operations.splice(index, 1)
            if (operation.kind === 'delete') return false
            replaceState({
                update,
                lastSeq: seq,
                lastSyncedStateVector,
                generation,
                lifecycle: 'active',
            })
            return true
        },
        async commitDeleteAcknowledgement(outboxId) {
            const index = operations.findIndex((candidate) => candidate.outboxId === outboxId)
            if (index < 0 || operations[index].kind !== 'delete') return false
            operations.splice(index, 1)
            state = null
            return true
        },
        async discard(outboxId) {
            const index = operations.findIndex((candidate) => candidate.outboxId === outboxId)
            if (index >= 0) operations.splice(index, 1)
        },
        async compact() {},
        async purge() {
            state = null
            operations.splice(0)
        },
    }
}

function harness(
    keyring = createGraphKeyring('g1'),
    cache = memoryCache(),
    compaction?: { minUpdates?: number; minBytes?: number; idleMs?: number },
) {
    const sent: RelayClientMessage[] = []
    const sync = createDocSync({
        docId: 'd1',
        graphId: 'g1',
        keyring,
        send: (m) => sent.push(m),
        persist: cache,
        debounceMs: 5,
        compaction,
    })
    return { sync, sent, keyring, cache }
}

describe('doc-sync', () => {
    it('debounces + encrypts a local edit into one append', async () => {
        const { sync, sent } = harness()
        await sync.ready()
        sync.doc.getText('content').insert(0, 'he')
        sync.doc.getText('content').insert(2, 'llo')
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        const append = sent[0]
        expect(append.type).toBe('append')
        // The envelope is ciphertext — the plaintext string never appears in it.
        if (append.type === 'append') expect(atob(append.envelope.replace(/-/g, '+').replace(/_/g, '/'))).not.toContain('hello')
        sync.destroy()
    })

    it('applies a relay update from a peer and does not re-send it', async () => {
        const keyring = createGraphKeyring('g1')
        const a = harness(keyring)
        const b = harness(keyring)
        await a.sync.ready()
        await b.sync.ready()
        a.sync.doc.getText('content').insert(0, 'peer text')
        await vi.waitFor(() => expect(a.sent).toHaveLength(1))
        const append = a.sent[0]
        expect(append.type).toBe('append')
        if (append.type !== 'append') return
        await b.sync.receive({ type: 'update', docId: 'd1', generation: 1, seq: 1, epochId: 1, envelope: append.envelope })
        expect(b.sync.doc.getText('content').toString()).toBe('peer text')
        // B applied it as REMOTE — it must not have queued its own append.
        await new Promise((r) => setTimeout(r, 15))
        expect(b.sent).toHaveLength(0)
        a.sync.destroy()
        b.sync.destroy()
    })

    it('does not turn an already-relayed update into local work on resync', async () => {
        const keyring = createGraphKeyring('g1')
        const producer = harness(keyring)
        const consumer = harness(keyring)
        await producer.sync.ready()
        await consumer.sync.ready()
        producer.sync.doc.getText('content').insert(0, 'from the relay')
        await producer.sync.flush()
        const append = producer.sent.find((message) => message.type === 'append')
        if (append?.type !== 'append') throw new Error('expected append')

        await consumer.sync.receive({
            type: 'update',
            docId: 'd1',
            generation: 1,
            seq: 1,
            epochId: 1,
            envelope: append.envelope,
        })
        consumer.sync.resync()
        await new Promise((resolve) => setTimeout(resolve, 15))

        expect(consumer.sent.filter((message) => message.type === 'append')).toEqual([])
        producer.sync.destroy()
        consumer.sync.destroy()
    })

    it('a contiguous ack advances the watermark; catchup requests after it', async () => {
        const { sync, sent } = harness()
        await sync.ready()
        sync.doc.getText('content').insert(0, 'acked')
        await sync.flush()
        const append = sent.find((message) => message.type === 'append')
        if (append?.type !== 'append') throw new Error('expected append')
        await sync.receive({ type: 'ack', outboxId: append.outboxId, generation: 1, state: 'active', seq: 1 })
        sync.resync()
        const catchup = sent.findLast((m) => m.type === 'catchup')
        expect(catchup).toMatchObject({
            type: 'catchup',
            docId: 'd1',
            generation: 1,
            afterSeq: 1,
            priority: 'background',
        })
        sync.destroy()
    })

    it('does not advance across a missing relay sequence when its local append is acknowledged', async () => {
        const keyring = createGraphKeyring('g1')
        const peer = harness(keyring)
        await peer.sync.ready()
        peer.sync.doc.getText('content').insert(0, 'peer')
        await peer.sync.flush()
        const peerAppend = peer.sent.find((message) => message.type === 'append')
        if (peerAppend?.type !== 'append') throw new Error('expected peer append')

        const local = harness(keyring)
        await local.sync.ready()
        local.sync.doc.getText('content').insert(0, 'local')
        await local.sync.flush()
        const localAppend = local.sent.find((message) => message.type === 'append')
        if (localAppend?.type !== 'append') throw new Error('expected local append')

        // Another connection won sequence 1. This tab sees its own sequence-2 ack first.
        await local.sync.receive({
            type: 'ack',
            outboxId: localAppend.outboxId,
            generation: 1,
            state: 'active',
            seq: 2,
        })
        local.sync.resync()
        expect(local.sent.findLast((message) => message.type === 'catchup')).toMatchObject({
            type: 'catchup',
            afterSeq: 0,
        })

        await local.sync.receive({
            type: 'catchup_batch',
            docId: 'd1',
            generation: 1,
            state: 'active',
            throughSeq: 2,
            hasMore: false,
            updates: [
                { seq: 1, epochId: 1, envelope: peerAppend.envelope },
                { seq: 2, epochId: 1, envelope: localAppend.envelope },
            ],
        })
        expect(local.sync.doc.getText('content').toString()).toContain('peer')
        expect(local.sync.doc.getText('content').toString()).toContain('local')

        peer.sync.destroy()
        local.sync.destroy()
    })

    it('rehydrates from cache on ready', async () => {
        const keyring = createGraphKeyring('g1')
        const cache = memoryCache()
        const first = harness(keyring, cache)
        await first.sync.ready()
        first.sync.doc.getText('content').insert(0, 'persisted')
        await vi.waitFor(() => expect(first.sent).toHaveLength(1))
        first.sync.destroy()

        const second = harness(keyring, cache)
        await second.sync.ready()
        expect(second.sync.doc.getText('content').toString()).toBe('persisted')
        second.sync.destroy()
    })

    it('a catchup_batch applies snapshot then updates in order', async () => {
        const keyring = createGraphKeyring('g1')
        // Build two encrypted updates via a producer doc through its own sync.
        const producer = harness(keyring)
        await producer.sync.ready()
        producer.sync.doc.getText('content').insert(0, 'A')
        await vi.waitFor(() => expect(producer.sent).toHaveLength(1))
        const first = producer.sent[0]
        if (first.type !== 'append') throw new Error('expected append')
        await producer.sync.receive({ type: 'ack', outboxId: first.outboxId, generation: 1, state: 'active', seq: 1 })
        producer.sync.doc.getText('content').insert(1, 'B')
        await vi.waitFor(() =>
            expect(producer.sent.filter((message) => message.type === 'append')).toHaveLength(2),
        )
        const envelopes = producer.sent.filter((m) => m.type === 'append').map((m) => (m.type === 'append' ? m.envelope : ''))
        producer.sync.destroy()

        const consumer = harness(keyring)
        await consumer.sync.ready()
        await consumer.sync.receive({
            type: 'catchup_batch',
            docId: 'd1',
            generation: 1,
            state: 'active',
            throughSeq: 2,
            hasMore: false,
            updates: [
                { seq: 1, epochId: 1, envelope: envelopes[0] },
                { seq: 2, epochId: 1, envelope: envelopes[1] },
            ],
        })
        expect(consumer.sync.doc.getText('content').toString()).toBe('AB')
        consumer.sync.destroy()
    })

    it('does not report a paged catch-up complete before the terminal relay page', async () => {
        const keyring = createGraphKeyring('g1')
        const producer = harness(keyring)
        await producer.sync.ready()
        producer.sync.doc.getText('content').insert(0, 'A')
        await producer.sync.flush()
        const first = producer.sent.find((message) => message.type === 'append')
        if (first?.type !== 'append') throw new Error('expected first append')
        await producer.sync.receive({
            type: 'ack',
            outboxId: first.outboxId,
            generation: 1,
            state: 'active',
            seq: 1,
        })
        producer.sync.doc.getText('content').insert(1, 'B')
        await producer.sync.flush()
        const second = producer.sent.filter((message) => message.type === 'append').at(-1)
        if (second?.type !== 'append') throw new Error('expected second append')

        const consumer = harness(keyring)
        await consumer.sync.ready()
        consumer.sync.resync()
        let caughtUp = false
        const completion = consumer.sync.caughtUp().then(() => {
            caughtUp = true
        })
        const initial = consumer.sent.find((message) => message.type === 'catchup')
        if (initial?.type !== 'catchup') throw new Error('expected initial catch-up request')

        await consumer.sync.receive({
            type: 'catchup_batch',
            requestId: initial.requestId,
            docId: 'd1',
            generation: 1,
            state: 'active',
            throughSeq: 1,
            hasMore: true,
            updates: [{ seq: 1, epochId: 1, envelope: first.envelope }],
        })

        const continuation = consumer.sent.filter((message) => message.type === 'catchup').at(-1)
        expect(continuation).toMatchObject({
            type: 'catchup',
            afterSeq: 1,
        })
        expect(continuation).not.toBe(initial)
        await Promise.resolve()
        expect(caughtUp).toBe(false)

        if (continuation?.type !== 'catchup') throw new Error('expected continuation request')
        await consumer.sync.receive({
            type: 'catchup_batch',
            requestId: continuation.requestId,
            docId: 'd1',
            generation: 1,
            state: 'active',
            throughSeq: 2,
            hasMore: false,
            updates: [{ seq: 2, epochId: 1, envelope: second.envelope }],
        })
        await completion
        expect(caughtUp).toBe(true)
        expect(consumer.sync.doc.getText('content').toString()).toBe('AB')

        producer.sync.destroy()
        consumer.sync.destroy()
    })

    it('reports the first applied page separately from terminal catch-up', async () => {
        const { sync, sent } = harness()
        await sync.ready()

        sync.resync()
        const request = sent.find((message) => message.type === 'catchup')
        if (request?.type !== 'catchup') throw new Error('expected catch-up request')

        let firstPageApplied = false
        let terminalCatchup = false
        const firstPage = sync.firstCatchupPage().then(() => {
            firstPageApplied = true
        })
        void sync.caughtUp().then(() => {
            terminalCatchup = true
        })

        await sync.receive({
            type: 'catchup_batch',
            requestId: request.requestId,
            docId: 'd1',
            generation: 1,
            state: 'active',
            throughSeq: 0,
            hasMore: true,
            updates: [],
        })
        await firstPage

        expect(firstPageApplied).toBe(true)
        expect(terminalCatchup).toBe(false)
        sync.destroy()
    })

    it('waits for the terminal page of each new catch-up cycle', async () => {
        const { sync, sent } = harness()
        await sync.ready()

        sync.resync()
        const firstRequest = sent.find((message) => message.type === 'catchup')
        if (firstRequest?.type !== 'catchup') throw new Error('expected first catch-up request')
        await sync.receive({
            type: 'catchup_batch',
            requestId: firstRequest.requestId,
            docId: 'd1',
            generation: 1,
            state: 'active',
            throughSeq: 0,
            hasMore: false,
            updates: [],
        })
        await sync.caughtUp()

        sync.resync()
        const secondRequest = sent.filter((message) => message.type === 'catchup').at(-1)
        if (secondRequest?.type !== 'catchup') throw new Error('expected second catch-up request')
        expect(secondRequest).not.toBe(firstRequest)

        let secondCycleSettled = false
        const secondCompletion = sync.caughtUp().then(() => {
            secondCycleSettled = true
        })
        await Promise.resolve()
        expect(secondCycleSettled).toBe(false)

        await sync.receive({
            type: 'catchup_batch',
            requestId: secondRequest.requestId,
            docId: 'd1',
            generation: 1,
            state: 'active',
            throughSeq: 0,
            hasMore: false,
            updates: [],
        })
        await secondCompletion
        expect(secondCycleSettled).toBe(true)

        sync.destroy()
    })

    it('rejects catch-up readiness when its page cannot be persisted', async () => {
        const cache = memoryCache()
        const { sync, sent } = harness(createGraphKeyring('g1'), cache)
        await sync.ready()
        cache.save = vi.fn(async () => {
            throw new DOMException('Cache full', 'QuotaExceededError')
        })

        sync.resync()
        const request = sent.find((message) => message.type === 'catchup')
        if (request?.type !== 'catchup') throw new Error('expected catch-up request')
        let firstPageState = 'pending'
        let terminalState = 'pending'
        void sync.firstCatchupPage().then(
            () => (firstPageState = 'resolved'),
            () => (firstPageState = 'rejected'),
        )
        void sync.caughtUp().then(
            () => (terminalState = 'resolved'),
            () => (terminalState = 'rejected'),
        )

        await expect(
            sync.receive({
                type: 'catchup_batch',
                requestId: request.requestId,
                docId: 'd1',
                generation: 1,
                state: 'active',
                throughSeq: 0,
                hasMore: false,
                updates: [],
            }),
        ).rejects.toThrow('Cache full')
        await Promise.resolve()

        // A failed cache write must release presentation and graph reconciliation waiters
        // with the real error, not leave the cross-tab catch-up lock pending forever.
        expect(firstPageState).toBe('rejected')
        expect(terminalState).toBe('rejected')
        sync.destroy()
    })

    it('persists one consolidated cache state for a remote catch-up page', async () => {
        const keyring = createGraphKeyring('g1')
        const producer = harness(keyring)
        await producer.sync.ready()
        producer.sync.doc.getText('content').insert(0, 'A')
        await producer.sync.flush()
        const first = producer.sent.find((message) => message.type === 'append')
        if (first?.type !== 'append') throw new Error('expected first append')
        await producer.sync.receive({
            type: 'ack',
            outboxId: first.outboxId,
            generation: 1,
            state: 'active',
            seq: 1,
        })
        producer.sync.doc.getText('content').insert(1, 'B')
        await producer.sync.flush()
        const second = producer.sent.filter((message) => message.type === 'append').at(-1)
        if (second?.type !== 'append') throw new Error('expected second append')

        const cache = memoryCache()
        const save = vi.spyOn(cache, 'save')
        const consumer = harness(keyring, cache)
        await consumer.sync.ready()
        await consumer.sync.receive({
            type: 'catchup_batch',
            docId: 'd1',
            generation: 1,
            state: 'active',
            throughSeq: 2,
            hasMore: false,
            updates: [
                { seq: 1, epochId: 1, envelope: first.envelope },
                { seq: 2, epochId: 1, envelope: second.envelope },
            ],
        })

        expect(save).toHaveBeenCalledTimes(1)
        expect(consumer.sync.doc.getText('content').toString()).toBe('AB')
        producer.sync.destroy()
        consumer.sync.destroy()
    })

    it('compact uploads one snapshot through the current watermark', async () => {
        const { sync, sent } = harness()
        await sync.ready()
        sync.doc.getText('content').insert(0, 'compact me')
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        await sync.receive({ type: 'ack', outboxId: sent[0].type === 'append' ? sent[0].outboxId : 'x', generation: 1, state: 'active', seq: 1 })
        await sync.compact()
        const snap = sent.find((m) => m.type === 'snapshot_put')
        expect(snap).toBeDefined()
        if (snap?.type === 'snapshot_put') {
            expect(snap.throughSeq).toBe(1)
            // The snapshot is ciphertext too — no plaintext leaks.
            expect(atob(snap.envelope.replace(/-/g, '+').replace(/_/g, '/'))).not.toContain('compact me')
        }
        sync.destroy()
    })

    it('local presence is encrypted and applied by a peer as a remote cursor', async () => {
        const keyring = createGraphKeyring('g1')
        const a = harness(keyring)
        const b = harness(keyring)
        await a.sync.ready()
        await b.sync.ready()
        // A sets its local presence (e.g. a cursor). doc-sync encrypts + emits a 'presence'.
        a.sync.awareness.setLocalStateField('user', { name: 'Alice' })
        await vi.waitFor(() => expect(a.sent.some((m) => m.type === 'presence')).toBe(true))
        const presence = a.sent.find((m) => m.type === 'presence')
        expect(presence?.type).toBe('presence')
        if (presence?.type !== 'presence') return
        // The presence envelope is ciphertext — the name never leaks.
        expect(atob(presence.envelope.replace(/-/g, '+').replace(/_/g, '/'))).not.toContain('Alice')
        // B applies it and sees A in its awareness map.
        await b.sync.receivePresence(presence.envelope)
        const states = [...b.sync.awareness.getStates().values()]
        expect(states.some((s) => (s.user as { name?: string })?.name === 'Alice')).toBe(true)
        a.sync.destroy()
        b.sync.destroy()
    })

    it('advertisePresence re-sends the current state; a cleared state stays silent', async () => {
        // The client half of the late-join handshake: a subscribe carries no presence, so
        // the engine must be able to re-send its state on demand (socket open, re-retain).
        const { sync, sent } = harness()
        await sync.ready()
        sync.awareness.setLocalStateField('user', { name: 'Alice' })
        await vi.waitFor(() => expect(sent.filter((m) => m.type === 'presence')).toHaveLength(1))

        await sync.advertisePresence()
        expect(sent.filter((m) => m.type === 'presence')).toHaveLength(2)

        // After clearPresence the state is a tombstone; advertising nothing is correct.
        await sync.clearPresence()
        const afterClear = sent.filter((m) => m.type === 'presence').length
        await sync.advertisePresence()
        expect(sent.filter((m) => m.type === 'presence')).toHaveLength(afterClear)
        sync.destroy()
    })

    it('compact is a no-op before anything is acked', async () => {
        const { sync, sent } = harness()
        await sync.ready()
        await sync.compact()
        expect(sent.find((m) => m.type === 'snapshot_put')).toBeUndefined()
        sync.destroy()
    })

    it('uploads a compacted snapshot after an acknowledged update becomes idle', async () => {
        vi.useFakeTimers()
        try {
            const { sync, sent } = harness(createGraphKeyring('g1'), memoryCache(), {
                minUpdates: 1,
                minBytes: Number.MAX_SAFE_INTEGER,
                idleMs: 20,
            })
            await sync.ready()
            sync.doc.getText('content').insert(0, 'compact after idle')
            await sync.flush()
            const append = sent.find((message) => message.type === 'append')
            if (append?.type !== 'append') throw new Error('expected append')
            await sync.receive({
                type: 'ack',
                outboxId: append.outboxId,
                generation: 1,
                state: 'active',
                seq: 1,
            })

            expect(sent.some((message) => message.type === 'snapshot_put')).toBe(false)
            await vi.advanceTimersByTimeAsync(20)
            await vi.waitFor(() =>
                expect(sent.some((message) => message.type === 'snapshot_put')).toBe(true),
            )
            sync.destroy()
        } finally {
            vi.useRealTimers()
        }
    })

    it('an undecryptable envelope is skipped, not fatal', async () => {
        const { sync } = harness()
        await sync.ready()
        await expect(
            sync.receive({ type: 'update', docId: 'd1', generation: 1, seq: 1, epochId: 99, envelope: 'AQEAAAA' }),
        ).resolves.toBeUndefined()
        expect(sync.doc.getText('content').toString()).toBe('')
        expect(sync.health()).toBe('ciphertext-corrupt')
        sync.destroy()
    })

    it('durably enqueues before sending and retains the exact operation when send fails', async () => {
        const cache = memoryCache()
        const send = vi.fn(() => {
            throw new Error('socket died')
        })
        const sync = createDocSync({
            docId: 'd1',
            graphId: 'g1',
            keyring: createGraphKeyring('g1'),
            send,
            persist: cache,
            debounceMs: 60_000,
            newOutboxId: () => '018f47a0-7b5d-7cc5-b5c1-f0fbcde31001',
        })
        await sync.ready()
        sync.doc.getText('content').insert(0, 'survive')
        await expect(sync.flush()).rejects.toThrow('socket died')
        expect(await cache.pending()).toEqual([
            expect.objectContaining({
                outboxId: '018f47a0-7b5d-7cc5-b5c1-f0fbcde31001',
                envelope: expect.any(String),
            }),
        ])
        sync.destroy()
    })

    it('replays the same outbox identity and ciphertext after a restart', async () => {
        const cache = memoryCache()
        const first = harness(createGraphKeyring('g1'), cache)
        await first.sync.ready()
        first.sync.doc.getText('content').insert(0, 'survive restart')
        await first.sync.flush()
        const original = first.sent.find((message) => message.type === 'append')
        expect(original?.type).toBe('append')
        first.sync.destroy()

        const replayed: RelayClientMessage[] = []
        const second = createDocSync({
            docId: 'd1',
            graphId: 'g1',
            keyring: first.keyring,
            send: (message) => replayed.push(message),
            persist: cache,
            debounceMs: 5,
        })
        await second.ready()
        second.resync()
        await vi.waitFor(() => expect(replayed.some((message) => message.type === 'append')).toBe(true))
        const replay = replayed.find((message) => message.type === 'append')
        expect(replay).toEqual(original)
        second.destroy()
    })

    it('drains a cached edit after restart even when debounce never created an outbox row', async () => {
        const cache = memoryCache()
        const keyring = createGraphKeyring('g1')
        const first = createDocSync({
            docId: 'd1',
            graphId: 'g1',
            keyring,
            send: vi.fn(),
            persist: cache,
            debounceMs: 60_000,
        })
        await first.ready()
        first.doc.getText('content').insert(0, 'saved before the debounce')
        await vi.waitFor(async () => {
            const cached = await cache.load()
            if (!cached) throw new Error('expected cached document')
            const restored = new Y.Doc()
            try {
                Y.applyUpdate(restored, cached.update)
                expect(restored.getText('content').toString()).toBe('saved before the debounce')
            } finally {
                restored.destroy()
            }
        })
        expect(await cache.pending()).toEqual([])
        first.destroy()

        const sent: RelayClientMessage[] = []
        const restarted = createDocSync({
            docId: 'd1',
            graphId: 'g1',
            keyring,
            send: (message) => sent.push(message),
            persist: cache,
            debounceMs: 5,
        })
        await restarted.ready()
        restarted.resync()

        await vi.waitFor(() =>
            expect(sent.filter((message) => message.type === 'append')).toHaveLength(1),
        )
        restarted.destroy()
    })

    it('drains a deletion-only cached edit after restart without another edit', async () => {
        const cache = memoryCache()
        const keyring = createGraphKeyring('g1')
        const sentBeforeRestart: RelayClientMessage[] = []
        const first = createDocSync({
            docId: 'd1',
            graphId: 'g1',
            keyring,
            send: (message) => sentBeforeRestart.push(message),
            persist: cache,
            debounceMs: 60_000,
        })
        await first.ready()
        first.doc.getText('content').insert(0, 'keep DELETE keep')
        await first.flush()
        const baseline = sentBeforeRestart.find((message) => message.type === 'append')
        if (baseline?.type !== 'append') throw new Error('expected baseline append')
        await first.receive({
            type: 'ack',
            outboxId: baseline.outboxId,
            generation: 1,
            state: 'active',
            seq: 1,
        })

        first.doc.getText('content').delete(5, 7)
        await vi.waitFor(async () => {
            const cached = await cache.load()
            if (!cached) throw new Error('expected cached document')
            const restored = new Y.Doc()
            try {
                Y.applyUpdate(restored, cached.update)
                expect(restored.getText('content').toString()).toBe('keep keep')
            } finally {
                restored.destroy()
            }
        })
        expect(await cache.pending()).toEqual([])
        first.destroy()

        const sentAfterRestart: RelayClientMessage[] = []
        const restarted = createDocSync({
            docId: 'd1',
            graphId: 'g1',
            keyring,
            send: (message) => sentAfterRestart.push(message),
            persist: cache,
            debounceMs: 5,
        })
        await restarted.ready()
        restarted.resync()
        await vi.waitFor(() =>
            expect(sentAfterRestart.filter((message) => message.type === 'append')).toHaveLength(1),
        )
        const deletion = sentAfterRestart.find((message) => message.type === 'append')
        if (deletion?.type !== 'append') throw new Error('expected deletion append')

        const peer = harness(keyring)
        await peer.sync.ready()
        await peer.sync.receive({
            type: 'update',
            docId: 'd1',
            generation: 1,
            seq: 1,
            epochId: 1,
            envelope: baseline.envelope,
        })
        await peer.sync.receive({
            type: 'update',
            docId: 'd1',
            generation: 1,
            seq: 2,
            epochId: 1,
            envelope: deletion.envelope,
        })
        expect(peer.sync.doc.getText('content').toString()).toBe('keep keep')

        restarted.destroy()
        peer.sync.destroy()
    })

    it('drains a cached edit that landed behind a replayed outbox operation', async () => {
        const cache = memoryCache()
        const first = harness(createGraphKeyring('g1'), cache)
        await first.sync.ready()
        first.sync.doc.getText('content').insert(0, 'first')
        await first.sync.flush()
        const original = first.sent.find((message) => message.type === 'append')
        if (original?.type !== 'append') throw new Error('expected original append')

        // The first operation is still in flight. This later edit is saved immediately,
        // but its debounced append has not been allowed onto the durable outbox yet.
        first.sync.doc.getText('content').insert(5, ' second')
        await vi.waitFor(async () => {
            const cached = await cache.load()
            if (!cached) throw new Error('expected cached document')
            const restored = new Y.Doc()
            try {
                Y.applyUpdate(restored, cached.update)
                expect(restored.getText('content').toString()).toBe('first second')
            } finally {
                restored.destroy()
            }
        })
        expect(await cache.pending()).toHaveLength(1)
        first.sync.destroy()

        const replayed: RelayClientMessage[] = []
        const second = createDocSync({
            docId: 'd1',
            graphId: 'g1',
            keyring: first.keyring,
            send: (message) => replayed.push(message),
            persist: cache,
            debounceMs: 5,
        })
        await second.ready()
        expect(second.doc.getText('content').toString()).toBe('first second')
        second.resync()
        await vi.waitFor(() => expect(replayed.filter((message) => message.type === 'append')).toHaveLength(1))

        await second.receive({
            type: 'ack',
            outboxId: original.outboxId,
            generation: 1,
            state: 'active',
            seq: 1,
        })
        await second.flush()

        // A restart must not require another keystroke to reveal the cached edit that was
        // outside the replayed operation's state-vector boundary.
        expect(replayed.filter((message) => message.type === 'append')).toHaveLength(2)
        second.destroy()
    })

    it('allows only one in-flight operation per document and drains later edits after its ack', async () => {
        const { sync, sent } = harness()
        await sync.ready()
        sync.doc.getText('content').insert(0, 'first')
        await sync.flush()
        const first = sent.find((message) => message.type === 'append')
        expect(first?.type).toBe('append')

        sync.doc.getText('content').insert(5, ' second')
        await sync.flush()
        expect(sent.filter((message) => message.type === 'append')).toHaveLength(1)

        if (first?.type !== 'append') return
        await sync.receive({ type: 'ack', outboxId: first.outboxId, generation: 1, state: 'active', seq: 1 })
        await vi.waitFor(() => expect(sent.filter((message) => message.type === 'append')).toHaveLength(2))
        expect(sent).toContainEqual({ type: 'ack_confirm', outboxId: first.outboxId })
        sync.destroy()
    })

    it('does not send when durable enqueue fails and surfaces the failure', async () => {
        const cache = memoryCache()
        cache.enqueue = async () => {
            throw new DOMException('Quota exceeded', 'QuotaExceededError')
        }
        const sent: RelayClientMessage[] = []
        const reported = vi.fn()
        const sync = createDocSync({
            docId: 'd1',
            graphId: 'g1',
            keyring: createGraphKeyring('g1'),
            send: (message) => sent.push(message),
            persist: cache,
            debounceMs: 60_000,
            onError: reported,
        })
        await sync.ready()
        sync.doc.getText('content').insert(0, 'must not disappear')
        await expect(sync.flush()).rejects.toThrow('Quota exceeded')
        expect(sent).toEqual([])
        expect(reported).toHaveBeenCalledWith(expect.objectContaining({ name: 'QuotaExceededError' }))
        sync.destroy()
    })

    // Tearing a workspace down while a cache write is in flight used to surface that write's
    // rejection as a user-visible "could not save" toast over the NEXT graph. graph-sync guards
    // its own reports on `disposed`; the engine's persistence tail did not.
    it('does not report a persistence failure that lands after destroy', async () => {
        const cache = memoryCache()
        let failEnqueue: (() => void) | undefined
        cache.enqueue = () =>
            new Promise((_resolve, reject) => {
                failEnqueue = () => reject(new DOMException('The database connection is closing.', 'InvalidStateError'))
            })
        const reported = vi.fn()
        const sync = createDocSync({
            docId: 'd1',
            graphId: 'g1',
            keyring: createGraphKeyring('g1'),
            send: () => {},
            persist: cache,
            debounceMs: 60_000,
            onError: reported,
        })
        await sync.ready()
        sync.doc.getText('content').insert(0, 'typed just before navigating away')
        const flushing = sync.flush().catch(() => {})
        // Encryption runs before the enqueue, so wait for the write to actually be in flight.
        await vi.waitFor(() => expect(failEnqueue).toBeDefined())

        sync.destroy()
        failEnqueue!()
        await flushing

        expect(reported).not.toHaveBeenCalled()
    })

    it('orders delete and explicit resurrection without a stale content append', async () => {
        const { sync, sent } = harness()
        await sync.ready()
        sync.doc.getText('content').insert(0, 'old body')
        await sync.flush()
        const append = sent.find((message) => message.type === 'append')
        if (append?.type !== 'append') throw new Error('expected append')
        await sync.receive({
            type: 'ack',
            outboxId: append.outboxId,
            generation: 1,
            state: 'active',
            seq: 1,
        })
        sent.splice(0)

        await sync.delete()
        expect(sent).toEqual([
            expect.objectContaining({ type: 'delete', docId: 'd1', generation: 1 }),
        ])
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(sent.some((message) => message.type === 'append')).toBe(false)
        const deletion = sent[0]
        if (deletion.type !== 'delete') throw new Error('expected delete')
        await sync.receive({
            type: 'ack',
            outboxId: deletion.outboxId,
            generation: 2,
            state: 'deleted',
            seq: 0,
        })
        expect(sync.lifecycle()).toBe('deleted')

        sync.doc.getText('content').insert(0, 'restored deliberately')
        await sync.flush()
        const resurrection = sent.find((message) => message.type === 'resurrect')
        expect(resurrection).toMatchObject({ type: 'resurrect', generation: 2 })
        sync.destroy()
    })

    it('buffers N+1, requests the gap, then commits both when N arrives', async () => {
        const keyring = createGraphKeyring('g1')
        const producer = harness(keyring)
        await producer.sync.ready()
        producer.sync.doc.getText('content').insert(0, 'A')
        await producer.sync.flush()
        const first = producer.sent.find((message) => message.type === 'append')
        if (first?.type !== 'append') throw new Error('expected first append')
        await producer.sync.receive({
            type: 'ack',
            outboxId: first.outboxId,
            generation: 1,
            state: 'active',
            seq: 1,
        })
        producer.sync.doc.getText('content').insert(1, 'B')
        await producer.sync.flush()
        const second = producer.sent.filter((message) => message.type === 'append').at(-1)
        if (second?.type !== 'append') throw new Error('expected second append')

        const consumer = harness(keyring)
        await consumer.sync.ready()
        await consumer.sync.receive({
            type: 'update',
            docId: 'd1',
            generation: 1,
            seq: 2,
            epochId: 1,
            envelope: second.envelope,
        })
        expect(consumer.sync.health()).toBe('sequence-gap')
        expect(consumer.sent).toContainEqual(
            expect.objectContaining({
                type: 'catchup',
                docId: 'd1',
                generation: 1,
                afterSeq: 0,
            }),
        )
        await consumer.sync.receive({
            type: 'update',
            docId: 'd1',
            generation: 1,
            seq: 1,
            epochId: 1,
            envelope: first.envelope,
        })
        expect(consumer.sync.doc.getText('content').toString()).toBe('AB')
        expect(consumer.sync.health()).toBe('healthy')
        producer.sync.destroy()
        consumer.sync.destroy()
    })

    it('an acknowledged edit with deletion history drains once, not forever', async () => {
        // Yjs writes the document's ENTIRE delete set into every state-vector difference,
        // so "is the diff empty" judged by byte length is never true once anything was
        // deleted. The ack handler drains again after each acknowledgement, which turned
        // one client into a ~40-appends-per-second self-loop per edited document (live,
        // 2026-07-30: three documents at sequence 660,000+ and rising). Emptiness must be
        // judged by snapshot equality across the state vector AND delete set.
        const { sync, sent } = harness()
        await sync.ready()
        sync.doc.getText('content').insert(0, 'hello world')
        sync.doc.getText('content').delete(2, 3) // deletion history: the trap
        await sync.flush()
        const appends = () => sent.filter((message) => message.type === 'append')
        expect(appends()).toHaveLength(1)
        const first = appends()[0]
        if (first.type !== 'append') throw new Error('expected append')

        await sync.receive({
            type: 'ack',
            outboxId: first.outboxId,
            generation: 1,
            state: 'active',
            seq: 1,
        })
        // The ack-triggered drain runs inside receive(); one more settle for good measure.
        await sync.flush()
        expect(appends()).toHaveLength(1)
        expect(sync.isIdle()).toBe(true)
        sync.destroy()
    })

    it('a pure deletion still drains and reaches the peer', async () => {
        // The snapshot test must SEE deletions: state vectors alone cannot, and skipping a
        // deletion-only edit would leave peers holding deleted text forever.
        const keyring = createGraphKeyring('g1')
        const a = harness(keyring)
        const b = harness(keyring)
        await a.sync.ready()
        await b.sync.ready()
        a.sync.doc.getText('content').insert(0, 'keep DELETE keep')
        await a.sync.flush()
        const appends = () => a.sent.filter((message) => message.type === 'append')
        const first = appends()[0]
        if (first?.type !== 'append') throw new Error('expected first append')
        await a.sync.receive({ type: 'ack', outboxId: first.outboxId, generation: 1, state: 'active', seq: 1 })

        a.sync.doc.getText('content').delete(5, 7) // "DELETE ", nothing inserted
        await a.sync.flush()
        expect(appends()).toHaveLength(2)
        const second = appends()[1]
        if (second.type !== 'append') throw new Error('expected deletion append')
        await a.sync.receive({ type: 'ack', outboxId: second.outboxId, generation: 1, state: 'active', seq: 2 })
        await a.sync.flush()
        expect(appends()).toHaveLength(2) // and the deletion ack does not restart a loop

        await b.sync.receive({ type: 'update', docId: 'd1', generation: 1, seq: 1, epochId: 1, envelope: first.envelope })
        await b.sync.receive({ type: 'update', docId: 'd1', generation: 1, seq: 2, epochId: 1, envelope: second.envelope })
        expect(b.sync.doc.getText('content').toString()).toBe('keep keep')
        a.sync.destroy()
        b.sync.destroy()
    })

    it('a relayed deletion does not echo back from the receiving client on resync', async () => {
        const keyring = createGraphKeyring('g1')
        const a = harness(keyring)
        const b = harness(keyring)
        await a.sync.ready()
        await b.sync.ready()
        a.sync.doc.getText('content').insert(0, 'shared text')
        a.sync.doc.getText('content').delete(0, 7)
        await a.sync.flush()
        const append = a.sent.find((message) => message.type === 'append')
        if (append?.type !== 'append') throw new Error('expected append')

        await b.sync.receive({ type: 'update', docId: 'd1', generation: 1, seq: 1, epochId: 1, envelope: append.envelope })
        b.sync.resync()
        await b.sync.flush()
        expect(b.sent.filter((message) => message.type === 'append')).toHaveLength(0)
        a.sync.destroy()
        b.sync.destroy()
    })

    it('pauses an unknown epoch without advancing, then retries after the keyring changes', async () => {
        const oldKeyring = createGraphKeyring('g1')
        const rotated = bumpEpoch(oldKeyring)
        const producer = harness(rotated)
        await producer.sync.ready()
        producer.sync.doc.getText('content').insert(0, 'new epoch')
        await producer.sync.flush()
        const append = producer.sent.find((message) => message.type === 'append')
        if (append?.type !== 'append') throw new Error('expected append')

        const consumer = harness(oldKeyring)
        await consumer.sync.ready()
        const update = {
            type: 'update' as const,
            docId: 'd1',
            generation: 1,
            seq: 1,
            epochId: 2,
            envelope: append.envelope,
        }
        await consumer.sync.receive(update)
        expect(consumer.sync.health()).toBe('key-unavailable')
        expect(consumer.sync.doc.getText('content').toString()).toBe('')

        oldKeyring.epochs.push(rotated.epochs.at(-1)!)
        await consumer.sync.receive(update)
        expect(consumer.sync.health()).toBe('healthy')
        expect(consumer.sync.doc.getText('content').toString()).toBe('new epoch')
        producer.sync.destroy()
        consumer.sync.destroy()
    })
})

describe('collecting the cache row', () => {
    const FENCE = '```etherpk-cipher\nAAAA\n```'

    it('collects once after a relay update makes the document read as wanted, and again after it stops and resumes', async () => {
        const keyring = createGraphKeyring('g1')
        const producer = harness(keyring)
        const cache = memoryCache()
        let collected = 0
        cache.compact = async () => {
            collected += 1
        }
        const consumer = createDocSync({
            docId: 'd1',
            graphId: 'g1',
            keyring,
            send: () => {},
            persist: cache,
            debounceMs: 5,
            collectRowWhen: (doc) => doc.getText('content').toString() === FENCE,
        })
        await producer.sync.ready()
        await consumer.ready()

        const deliver = async (seq: number) => {
            await producer.sync.flush()
            // The append is sent after the persist `flush` waits on; wait for it to be there.
            const appends = () => producer.sent.filter((m) => m.type === 'append')
            await vi.waitFor(() => expect(appends().length).toBeGreaterThanOrEqual(seq))
            const append = appends()[seq - 1]
            if (append?.type !== 'append') throw new Error('expected append')
            // The relay acknowledges before the producer sends its next append.
            await producer.sync.receive({ type: 'ack', outboxId: append.outboxId, generation: 1, state: 'active', seq })
            await consumer.receive({ type: 'update', docId: 'd1', generation: 1, seq, epochId: 1, envelope: append.envelope })
        }
        producer.sync.doc.getText('content').insert(0, 'plain body')
        await deliver(1)
        await vi.waitFor(() => expect(consumer.doc.getText('content').toString()).toBe('plain body'))
        expect(collected).toBe(0)

        producer.sync.doc.getText('content').delete(0, 'plain body'.length)
        producer.sync.doc.getText('content').insert(0, FENCE)
        await deliver(2)
        await vi.waitFor(() => expect(consumer.doc.getText('content').toString()).toBe(FENCE))
        await vi.waitFor(() => expect(collected).toBe(1))

        // Still wanted: no second collection for an unrelated persist.
        producer.sync.doc.getText('content').insert(0, '')
        await new Promise((r) => setTimeout(r, 20))
        expect(collected).toBe(1)

        // Stops being wanted, then is again: collected again.
        producer.sync.doc.getText('content').insert(0, 'x')
        await deliver(3)
        await vi.waitFor(() => expect(consumer.doc.getText('content').toString()).toBe('x' + FENCE))
        producer.sync.doc.getText('content').delete(0, 1)
        await deliver(4)
        await vi.waitFor(() => expect(collected).toBe(2))
        producer.sync.destroy()
        consumer.destroy()
    })
})

describe('snapshot read-back verification and retention (ADR 0025, amended 2026-09-12)', () => {
    /** Append `text` at the end, flush it, and acknowledge it as the next sequence. */
    async function ackedEdit(h: ReturnType<typeof harness>, text: string): Promise<void> {
        const before = h.sent.filter((m) => m.type === 'append').length
        const content = h.sync.doc.getText('content')
        content.insert(content.length, text)
        await h.sync.flush()
        const appends = h.sent.filter((m) => m.type === 'append')
        expect(appends).toHaveLength(before + 1)
        const append = appends.at(-1)
        if (append?.type !== 'append') throw new Error('expected append')
        await h.sync.receive({ type: 'ack', outboxId: append.outboxId, generation: 1, state: 'active', seq: appends.length })
    }

    function lastSnapshotPut(h: ReturnType<typeof harness>) {
        const put = h.sent.filter((m) => m.type === 'snapshot_put').at(-1)
        if (put?.type !== 'snapshot_put') throw new Error('expected snapshot_put')
        return put
    }

    it('reads an acknowledged snapshot back and verifies it before telling the relay', async () => {
        const h = harness()
        await h.sync.ready()
        await ackedEdit(h, 'verify me')
        await h.sync.compact()
        const put = lastSnapshotPut(h)
        expect(put.throughSeq).toBe(1)
        // Nothing is read back until the relay says the snapshot landed.
        expect(h.sent.some((m) => m.type === 'snapshot_get')).toBe(false)

        await h.sync.receive({ type: 'snapshot_ack', docId: 'd1', generation: 1, throughSeq: 1 })
        expect(h.sent.filter((m) => m.type === 'snapshot_get')).toEqual([
            { type: 'snapshot_get', docId: 'd1', generation: 1, throughSeq: 1 },
        ])
        expect(h.sent.some((m) => m.type === 'snapshot_verified')).toBe(false)

        await h.sync.receive({
            type: 'snapshot_data',
            docId: 'd1',
            generation: 1,
            throughSeq: 1,
            epochId: put.epochId,
            envelope: put.envelope,
        })
        expect(h.sent.filter((m) => m.type === 'snapshot_verified')).toEqual([
            { type: 'snapshot_verified', docId: 'd1', generation: 1, throughSeq: 1 },
        ])
        h.sync.destroy()
    })

    it('does not verify a read-back that decodes to a different state, or one that does not decode', async () => {
        const keyring = createGraphKeyring('g1')
        const h = harness(keyring)
        await h.sync.ready()
        await ackedEdit(h, 'the real content')
        await h.sync.compact()
        const put = lastSnapshotPut(h)
        // Another engine on the same keyring produces a valid, decryptable snapshot of OTHER
        // content: exactly what a mis-stored or mis-served snapshot would look like.
        const other = harness(keyring)
        await other.sync.ready()
        await ackedEdit(other, 'something else entirely')
        await other.sync.compact()
        const foreign = lastSnapshotPut(other)

        await h.sync.receive({ type: 'snapshot_ack', docId: 'd1', generation: 1, throughSeq: 1 })
        await h.sync.receive({
            type: 'snapshot_data',
            docId: 'd1',
            generation: 1,
            throughSeq: 1,
            epochId: foreign.epochId,
            envelope: foreign.envelope,
        })
        expect(h.sent.some((m) => m.type === 'snapshot_verified')).toBe(false)

        // Corrupt bytes are refused the same way, without throwing.
        await h.sync.compact()
        await h.sync.receive({ type: 'snapshot_ack', docId: 'd1', generation: 1, throughSeq: 1 })
        await h.sync.receive({
            type: 'snapshot_data',
            docId: 'd1',
            generation: 1,
            throughSeq: 1,
            epochId: put.epochId,
            envelope: 'AAECAwQFBgcICQ',
        })
        expect(h.sent.some((m) => m.type === 'snapshot_verified')).toBe(false)
        expect(h.sync.health()).toBe('healthy')
        h.sync.destroy()
        other.sync.destroy()
    })

    it('ignores a snapshot acknowledgement or read-back that names a different snapshot', async () => {
        const h = harness()
        await h.sync.ready()
        await ackedEdit(h, 'x')
        await h.sync.compact()
        const put = lastSnapshotPut(h)
        await h.sync.receive({ type: 'snapshot_ack', docId: 'd1', generation: 1, throughSeq: 7 })
        await h.sync.receive({ type: 'snapshot_ack', docId: 'd1', generation: 2, throughSeq: 1 })
        expect(h.sent.some((m) => m.type === 'snapshot_get')).toBe(false)
        await h.sync.receive({ type: 'snapshot_ack', docId: 'd1', generation: 1, throughSeq: 1 })
        await h.sync.receive({
            type: 'snapshot_data',
            docId: 'd1',
            generation: 1,
            throughSeq: 7,
            epochId: put.epochId,
            envelope: put.envelope,
        })
        expect(h.sent.some((m) => m.type === 'snapshot_verified')).toBe(false)
        h.sync.destroy()
    })

    it('a catch-up answered from below the pruned floor adopts the snapshot watermark', async () => {
        const keyring = createGraphKeyring('g1')
        const producer = harness(keyring)
        await producer.sync.ready()
        for (const letter of ['A', 'B', 'C', 'D', 'E']) await ackedEdit(producer, letter)
        await producer.sync.compact()
        const snapshot = lastSnapshotPut(producer)
        expect(snapshot.throughSeq).toBe(5)
        await ackedEdit(producer, 'F')
        await ackedEdit(producer, 'G')
        const appends = producer.sent.filter((m) => m.type === 'append')
        const envelope = (seq: number) => {
            const m = appends[seq - 1]
            if (m?.type !== 'append') throw new Error(`expected append ${seq}`)
            return m.envelope
        }

        const consumer = harness(keyring)
        await consumer.sync.ready()
        await consumer.sync.receive({
            type: 'catchup_batch',
            docId: 'd1',
            generation: 1,
            state: 'active',
            throughSeq: 2,
            hasMore: false,
            updates: [
                { seq: 1, epochId: 1, envelope: envelope(1) },
                { seq: 2, epochId: 1, envelope: envelope(2) },
            ],
        })
        expect(consumer.sync.doc.getText('content').toString()).toBe('AB')
        // A live update far ahead is held while the gap is requested...
        await consumer.sync.receive({ type: 'update', docId: 'd1', generation: 1, seq: 7, epochId: 1, envelope: envelope(7) })
        expect(consumer.sync.health()).toBe('sequence-gap')
        // ...and the relay answers the gap with the snapshot, because rows 1..5 are gone.
        await consumer.sync.receive({
            type: 'catchup_batch',
            docId: 'd1',
            generation: 1,
            state: 'active',
            throughSeq: 6,
            hasMore: false,
            updates: [{ seq: 6, epochId: 1, envelope: envelope(6) }],
            snapshot: { throughSeq: 5, epochId: snapshot.epochId, envelope: snapshot.envelope },
        })
        expect(consumer.sync.doc.getText('content').toString()).toBe('ABCDEFG')
        expect(consumer.sync.health()).toBe('healthy')
        producer.sync.destroy()
        consumer.sync.destroy()
    })

    /** Real-timer settle for the NEGATIVE checks: the idle timer fires at 20 ms and the
     *  encrypt behind it is WebCrypto, which fake timers cannot flush deterministically. */
    const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    it('compacts after the row floor even when the tail is tiny', async () => {
        const h = harness(createGraphKeyring('g1'), memoryCache(), {
            minUpdates: 3,
            minBytes: Number.MAX_SAFE_INTEGER,
            idleMs: 20,
        })
        await h.sync.ready()
        await ackedEdit(h, 'a')
        await ackedEdit(h, 'b')
        await settle(150)
        expect(h.sent.some((m) => m.type === 'snapshot_put')).toBe(false)
        await ackedEdit(h, 'c')
        await vi.waitFor(() => expect(h.sent.some((m) => m.type === 'snapshot_put')).toBe(true))
        h.sync.destroy()
    })

    it('compacts once the unsnapshotted tail outweighs the document by the byte floor, and not before', async () => {
        const h = harness(createGraphKeyring('g1'), memoryCache(), {
            minUpdates: 1000,
            minBytes: 150,
            idleMs: 20,
        })
        await h.sync.ready()
        // One big edit: the tail is one envelope of roughly the document's own size, so
        // pruning it would save nothing worth a snapshot.
        await ackedEdit(h, 'x'.repeat(300))
        await settle(150)
        expect(h.sent.some((m) => m.type === 'snapshot_put')).toBe(false)
        // Deleting it all keeps the document tiny while the log still holds the 300
        // characters and the delete: now the tail outweighs the document.
        h.sync.doc.getText('content').delete(0, 300)
        await h.sync.flush()
        const appends = h.sent.filter((m) => m.type === 'append')
        const last = appends.at(-1)
        if (last?.type !== 'append') throw new Error('expected append')
        await h.sync.receive({ type: 'ack', outboxId: last.outboxId, generation: 1, state: 'active', seq: appends.length })
        await vi.waitFor(() => expect(h.sent.some((m) => m.type === 'snapshot_put')).toBe(true))
        h.sync.destroy()
    })

    it('a snapshot applied from catch-up resets the tail counters', async () => {
        const keyring = createGraphKeyring('g1')
        const producer = harness(keyring)
        await producer.sync.ready()
        await ackedEdit(producer, 'y'.repeat(400))
        await producer.sync.compact()
        const snapshot = lastSnapshotPut(producer)

        // A consumer whose only history IS the snapshot has nothing worth compacting, even
        // with a policy that would otherwise fire on a single row.
        const consumer = harness(keyring, memoryCache(), { minUpdates: 1, minBytes: 1, idleMs: 20 })
        await consumer.sync.ready()
        await consumer.sync.receive({
            type: 'catchup_batch',
            docId: 'd1',
            generation: 1,
            state: 'active',
            throughSeq: 1,
            hasMore: false,
            updates: [],
            snapshot: { throughSeq: 1, epochId: snapshot.epochId, envelope: snapshot.envelope },
        })
        await settle(150)
        expect(consumer.sent.some((m) => m.type === 'snapshot_put')).toBe(false)
        producer.sync.destroy()
        consumer.sync.destroy()
    })
})
