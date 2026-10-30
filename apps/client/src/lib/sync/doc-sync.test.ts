import * as Y from 'yjs'
import { describe, expect, it, vi } from 'vitest'
import {
    bumpEpoch,
    contextAad,
    createGraphKeyring,
    currentEpoch,
    fromBase64Url,
    keyForEpoch,
    openSymmetric,
    sealSymmetric,
    toBase64Url,
} from '$lib/crypto'
import {
    contentBlocked,
    createDocSync,
    type DocCache,
    type DocSync,
    type DocSyncDeps,
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

    // A resync can queue a resend of the head operation behind its acknowledgement's commit. By the
    // time the resend goes, the ack has been confirmed and the relay has dropped the operation's
    // receipt, so the relay would store the same operation a second time.
    it('does not resend an operation acknowledged while its resend waited', async () => {
        const cache = memoryCache()
        const commit = cache.commitAcknowledgement.bind(cache)
        let commitStarted!: () => void
        const started = new Promise<void>((resolve) => { commitStarted = resolve })
        let releaseCommit!: () => void
        const gate = new Promise<void>((resolve) => { releaseCommit = resolve })
        cache.commitAcknowledgement = async (...args) => {
            commitStarted()
            await gate
            return commit(...args)
        }
        const { sync, sent } = harness(undefined, cache)
        await sync.ready()
        sync.doc.getText('content').insert(0, 'once')
        await sync.flush()
        const append = sent.find((message) => message.type === 'append')
        if (append?.type !== 'append') throw new Error('expected append')

        const acked = sync.receive({ type: 'ack', outboxId: append.outboxId, generation: 1, state: 'active', seq: 1 })
        await started
        sync.resync() // its resend queues behind the commit
        releaseCommit()
        await acked
        await new Promise((resolve) => setTimeout(resolve, 15))

        const sends = sent.filter((message) => message.type === 'append' && message.outboxId === append.outboxId)
        expect(sends).toHaveLength(1)
        expect(sent.some((message) => message.type === 'ack_confirm')).toBe(true)
        sync.destroy()
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

describe('Graph Key epochs (ADR 0127)', () => {
    /** An engine over a keyring the test can move to a new epoch, as a collected key does. */
    function rotatable(cache = memoryCache()) {
        const original = createGraphKeyring('g1')
        let current = original
        const sent: RelayClientMessage[] = []
        const missing: number[] = []
        const sync = createDocSync({
            docId: 'd1',
            graphId: 'g1',
            keyring: () => current,
            onMissingKey: (epochId) => missing.push(epochId),
            send: (m) => sent.push(m),
            persist: cache,
            debounceMs: 5,
        })
        return {
            sync,
            sent,
            missing,
            cache,
            original,
            rotate: () => {
                current = bumpEpoch(current)
                return current
            },
            /** The keyring this device holds from now on, as one collected from the owner. */
            use: (next: ReturnType<typeof createGraphKeyring>) => {
                current = next
            },
        }
    }

    const appends = (sent: RelayClientMessage[]) =>
        sent.filter((m): m is Extract<RelayClientMessage, { type: 'append' }> => m.type === 'append')

    async function plaintextOf(envelope: string, keyring: ReturnType<typeof createGraphKeyring>): Promise<Uint8Array> {
        const { openSymmetric, contextAad, fromBase64Url, keyForEpoch } = await import('$lib/crypto')
        return (await openSymmetric({ keyForEpoch: (id) => keyForEpoch(keyring, id), envelope: fromBase64Url(envelope), aad: contextAad('update', 'graph:g1', 'doc:d1') })).plaintext
    }

    it('seals a write the relay refused again, under the new epoch and with a new outbox id', async () => {
        const engine = rotatable()
        await engine.sync.ready()
        engine.sync.doc.getText('content').insert(0, 'water the beans')
        await engine.sync.flush()
        const [refused] = appends(engine.sent)
        expect(refused.epochId).toBe(1)

        engine.sync.staleEpoch(refused.outboxId)
        const rotated = engine.rotate()
        await engine.sync.keysChanged()

        const resent = appends(engine.sent).at(-1)!
        expect(resent.outboxId).not.toBe(refused.outboxId)
        expect(resent.epochId).toBe(2)
        expect(await plaintextOf(resent.envelope, rotated)).toEqual(await plaintextOf(refused.envelope, rotated))
        // Only the new operation is waiting, durably.
        expect((await engine.cache.pending()).map((op) => op.outboxId)).toEqual([resent.outboxId])
        engine.sync.destroy()
    })

    it('leaves the write in flight alone until the relay answers it: it may already be stored', async () => {
        const engine = rotatable()
        await engine.sync.ready()
        engine.sync.doc.getText('content').insert(0, 'water the beans')
        await engine.sync.flush()
        const [inFlight] = appends(engine.sent)

        engine.rotate()
        await engine.sync.keysChanged()

        expect(appends(engine.sent)).toHaveLength(1)
        expect((await engine.cache.pending()).map((op) => op.outboxId)).toEqual([inFlight.outboxId])
        engine.sync.destroy()
    })

    it('seals again an operation queued behind the head, which was never sent', async () => {
        const { sealSymmetric, contextAad, toBase64Url } = await import('$lib/crypto')
        const cache = memoryCache()
        const engine = rotatable(cache)
        // What an earlier session left: two operations, both under epoch 1.
        const queue = async (outboxId: string, text: string, createdAt: number) => {
            const doc = new Y.Doc()
            doc.getText('content').insert(0, text)
            const plaintext = Y.encodeStateAsUpdate(doc)
            const envelope = toBase64Url(
                await sealSymmetric({ key: engine.original.epochs[0].key, epochId: 1, plaintext, aad: contextAad('update', 'graph:g1', 'doc:d1') }),
            )
            await cache.enqueue(
                { outboxId, kind: 'append', generation: 1, epochId: 1, envelope, stateVector: Y.encodeStateVector(doc), createdAt },
                { update: Y.encodeStateAsUpdate(doc), lastSeq: 0, lastSyncedStateVector: Y.encodeStateVector(new Y.Doc()) },
            )
        }
        await queue('018f47a0-7b5d-7cc5-b5c1-0000000000a1', 'Garden', 1)
        await queue('018f47a0-7b5d-7cc5-b5c1-0000000000a2', 'Kitchen', 2)
        await engine.sync.ready()

        engine.rotate()
        await engine.sync.keysChanged()

        const pending = await cache.pending()
        expect(pending[0]).toMatchObject({ outboxId: '018f47a0-7b5d-7cc5-b5c1-0000000000a1', epochId: 1 })
        expect(pending[1]).toMatchObject({ epochId: 2 })
        expect(pending[1].outboxId).not.toBe('018f47a0-7b5d-7cc5-b5c1-0000000000a2')
        engine.sync.destroy()
    })

    it('reports an update under an epoch it lacks once, stops asking for it, and asks again when the key arrives', async () => {
        const producer = rotatable()
        const rotated = producer.rotate()
        await producer.sync.ready()
        // A member of the same graph: it holds epoch 1 only, until the owner's copy arrives.
        const consumer = rotatable()
        consumer.use({ graphId: 'g1', epochs: rotated.epochs.slice(0, 1) })
        producer.sync.doc.getText('content').insert(0, 'new epoch')
        await producer.sync.flush()
        const [append] = appends(producer.sent)

        await consumer.sync.ready()
        const update = (seq: number) => ({ type: 'update' as const, docId: 'd1', generation: 1, seq, epochId: 2, envelope: append.envelope })
        await consumer.sync.receive(update(1))
        await consumer.sync.receive(update(2))

        expect(consumer.missing).toEqual([2])
        expect(consumer.sync.health()).toBe('key-unavailable')
        // The gap behind the blocked update does not set off a catch-up that would only meet it again.
        expect(consumer.sent.filter((m) => m.type === 'catchup')).toHaveLength(0)

        consumer.use(rotated)
        await consumer.sync.keysChanged()
        expect(consumer.sent.filter((m) => m.type === 'catchup')).toEqual([expect.objectContaining({ afterSeq: 0 })])
        producer.sync.destroy()
        consumer.sync.destroy()
    })

    it('declares the epoch of its presence', async () => {
        const engine = rotatable()
        await engine.sync.ready()
        engine.rotate()

        await engine.sync.advertisePresence()
        engine.sync.awareness.setLocalState({ user: { name: 'Calm Owl' } })

        await vi.waitFor(() => expect(engine.sent.some((m) => m.type === 'presence')).toBe(true))
        expect(engine.sent.find((m) => m.type === 'presence')).toMatchObject({ epochId: 2 })
        engine.sync.destroy()
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

describe('answers from the relay that change no content', () => {
    /** An envelope carrying `text` as a fresh peer's first edit, sealed under `keyring`. */
    async function envelopeOf(keyring: ReturnType<typeof createGraphKeyring>, text: string): Promise<string> {
        const producer = harness(keyring)
        await producer.sync.ready()
        producer.sync.doc.getText('content').insert(0, text)
        await vi.waitFor(() => expect(producer.sent.some((message) => message.type === 'append')).toBe(true))
        producer.sync.destroy()
        const append = producer.sent.find((message) => message.type === 'append')
        if (append?.type !== 'append') throw new Error('expected append')
        return append.envelope
    }

    /** A synced document whose one local edit, `text`, is in flight and not yet acknowledged. */
    async function withOneEditInFlight(text = 'local') {
        const h = harness()
        await h.sync.ready()
        h.sync.doc.getText('content').insert(0, text)
        await h.sync.flush()
        const append = h.sent.find((message) => message.type === 'append')
        if (append?.type !== 'append') throw new Error('expected append')
        return { ...h, append }
    }

    it('ignores an ack for an operation other than the one in flight', async () => {
        const { sync, sent } = await withOneEditInFlight()
        const before = sent.length

        await sync.receive({ type: 'ack', outboxId: 'not-ours', generation: 1, state: 'active', seq: 1 })

        expect(sent.slice(before).some((message) => message.type === 'ack_confirm')).toBe(false)
        expect(sync.unsentOperations()).toBe(1)
        sync.destroy()
    })

    it('confirms nothing when the acknowledgement could not be stored', async () => {
        const cache = memoryCache()
        cache.commitAcknowledgement = vi.fn(async () => false)
        const { sync, sent } = harness(undefined, cache)
        await sync.ready()
        sync.doc.getText('content').insert(0, 'local')
        await sync.flush()
        const append = sent.find((message) => message.type === 'append')
        if (append?.type !== 'append') throw new Error('expected append')

        await sync.receive({ type: 'ack', outboxId: append.outboxId, generation: 1, state: 'active', seq: 1 })

        expect(sent.some((message) => message.type === 'ack_confirm')).toBe(false)
        expect(sync.unsentOperations()).toBe(1)
        sync.destroy()
    })

    it('keeps its watermark and health for an ack behind a sequence it already holds', async () => {
        const keyring = createGraphKeyring('g1')
        const { sync, sent, append } = await (async () => {
            const h = harness(keyring)
            await h.sync.ready()
            h.sync.doc.getText('content').insert(0, 'local')
            await h.sync.flush()
            const found = h.sent.find((message) => message.type === 'append')
            if (found?.type !== 'append') throw new Error('expected append')
            return { ...h, append: found }
        })()
        // A peer's update reached this device first at seq 1 and 2; the relay then answers the
        // local append with the seq it was stored at before them.
        const peer = await envelopeOf(keyring, 'peer')
        await sync.receive({ type: 'update', docId: 'd1', generation: 1, seq: 1, epochId: 1, envelope: peer })
        await sync.receive({ type: 'update', docId: 'd1', generation: 1, seq: 2, epochId: 1, envelope: peer })

        await sync.receive({ type: 'ack', outboxId: append.outboxId, generation: 1, state: 'active', seq: 1 })

        expect(sync.health()).toBe('healthy')
        sync.resync()
        expect(sent.findLast((message) => message.type === 'catchup')).toMatchObject({ afterSeq: 2 })
        sync.destroy()
    })

    it('ignores a catch-up page from an older generation', async () => {
        const keyring = createGraphKeyring('g1')
        const { sync } = harness(keyring)
        await sync.ready()
        await sync.staleGeneration(3)
        const before = sync.generation()

        await sync.receive({
            type: 'catchup_batch', docId: 'd1', generation: 1, state: 'active', throughSeq: 1, hasMore: false,
            updates: [{ seq: 1, epochId: 1, envelope: await envelopeOf(keyring, 'old generation') }],
        })

        expect(sync.doc.getText('content').toString()).not.toContain('old generation')
        expect(sync.generation()).toBe(before)
        sync.destroy()
    })

    it('empties the document and its outbox when catch-up says the generation was deleted, and stays deleted', async () => {
        const cache = memoryCache()
        const purge = vi.spyOn(cache, 'purge')
        const { sync, sent } = harness(undefined, cache)
        await sync.ready()
        sync.doc.getText('content').insert(0, 'about to go')
        await sync.flush()

        await sync.receive({ type: 'catchup_batch', docId: 'd1', generation: 1, state: 'deleted', throughSeq: 0, hasMore: false, updates: [] })
        await sync.caughtUp()

        expect(sync.doc.getText('content').toString()).toBe('')
        expect(sync.lifecycle()).toBe('deleted')
        expect(sync.unsentOperations()).toBe(0)
        expect(purge).toHaveBeenCalled()
        // The emptied document is the shared baseline: a reconnect sends nothing back.
        sent.splice(0)
        sync.resync()
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(sent.some((message) => message.type === 'append' || message.type === 'resurrect')).toBe(false)
        sync.destroy()
    })

    it('keeps what was written after a deletion this device already holds, when catch-up repeats it', async () => {
        const { sync, sent } = harness()
        await sync.ready()
        await sync.delete()
        const deletion = sent.find((message) => message.type === 'delete')
        if (deletion?.type !== 'delete') throw new Error('expected delete')
        await sync.receive({ type: 'ack', outboxId: deletion.outboxId, generation: 2, state: 'deleted', seq: 0 })
        sync.doc.getText('content').insert(0, 'written after')

        await sync.receive({ type: 'catchup_batch', docId: 'd1', generation: 2, state: 'deleted', throughSeq: 0, hasMore: false, updates: [] })

        expect(sync.doc.getText('content').toString()).toBe('written after')
        sync.destroy()
    })

    it('replaces an older generation’s content with the newer generation the relay holds', async () => {
        const keyring = createGraphKeyring('g1')
        const { sync } = harness(keyring)
        await sync.ready()
        await sync.receive({ type: 'catchup_batch', docId: 'd1', generation: 1, state: 'active', throughSeq: 1, hasMore: false, updates: [{ seq: 1, epochId: 1, envelope: await envelopeOf(keyring, 'first life') }] })
        expect(sync.doc.getText('content').toString()).toBe('first life')

        await sync.receive({ type: 'catchup_batch', docId: 'd1', generation: 2, state: 'active', throughSeq: 1, hasMore: false, updates: [{ seq: 1, epochId: 1, envelope: await envelopeOf(keyring, 'second life') }] })

        expect(sync.doc.getText('content').toString()).toBe('second life')
        expect(sync.generation()).toBe(2)
        sync.destroy()
    })

    it('tells the cache whether a relay answer changed what the search index reads', async () => {
        const keyring = createGraphKeyring('g1')
        const cache = memoryCache()
        const save = vi.spyOn(cache, 'save')
        const { sync } = harness(keyring, cache)
        await sync.ready()
        const envelope = await envelopeOf(keyring, 'indexed words')

        await sync.receive({ type: 'update', docId: 'd1', generation: 1, seq: 1, epochId: 1, envelope })
        expect(save.mock.calls.at(-1)?.[1]).toMatchObject({ indexContentChanged: true })

        await sync.receive({ type: 'catchup_batch', docId: 'd1', generation: 1, state: 'active', throughSeq: 1, hasMore: false, updates: [] })
        expect(save.mock.calls.at(-1)?.[1]).toMatchObject({ indexContentChanged: false })
        sync.destroy()
    })
})

describe('sync engine contracts', () => {
    type Keyring = ReturnType<typeof createGraphKeyring>
    const updateAad = contextAad('update', 'graph:g1', 'doc:d1')

    /** An engine that records what it sends, the errors it reports and the queue size at each change. */
    function engine(overrides: Partial<DocSyncDeps> = {}) {
        const sent: RelayClientMessage[] = []
        const errors: Error[] = []
        const queueSizes: number[] = []
        const keyring = (overrides.keyring ?? createGraphKeyring('g1')) as Keyring
        const cache = overrides.persist ?? memoryCache()
        const sync: DocSync = createDocSync({
            docId: 'd1',
            graphId: 'g1',
            keyring,
            send: (message) => sent.push(message),
            persist: cache,
            debounceMs: 5,
            onError: (error) => errors.push(error),
            onQueueChange: () => queueSizes.push(sync.unsentOperations()),
            ...overrides,
        })
        const ofType = <T extends RelayClientMessage['type']>(type: T) =>
            sent.filter((message): message is Extract<RelayClientMessage, { type: T }> => message.type === type)
        return { sync, sent, errors, queueSizes, keyring, cache, ofType }
    }

    async function seal(keyring: Keyring, plaintext: Uint8Array): Promise<string> {
        const epoch = currentEpoch(keyring)
        return toBase64Url(await sealSymmetric({ key: epoch.key, epochId: epoch.epochId, plaintext, aad: updateAad }))
    }

    /** An envelope carrying `text` as a fresh peer's whole document, optionally with a deletion in its history. */
    async function peerEnvelope(keyring: Keyring, text: string, deleted = ''): Promise<string> {
        const doc = new Y.Doc()
        const content = doc.getText('content')
        content.insert(0, text + deleted)
        if (deleted) content.delete(text.length, deleted.length)
        return seal(keyring, Y.encodeStateAsUpdate(doc))
    }

    /** The text an envelope holds when applied to an empty document. */
    async function textOf(keyring: Keyring, envelope: string): Promise<string> {
        const { plaintext } = await openSymmetric({
            keyForEpoch: (id) => keyForEpoch(keyring, id),
            envelope: fromBase64Url(envelope),
            aad: updateAad,
        })
        const doc = new Y.Doc()
        Y.applyUpdate(doc, plaintext)
        return doc.getText('content').toString()
    }

    const update = (seq: number, envelope: string, generation = 1) =>
        ({ type: 'update', docId: 'd1', generation, seq, epochId: 1, envelope }) as const
    const ack = (outboxId: string, seq: number, generation = 1, state: 'active' | 'deleted' = 'active') =>
        ({ type: 'ack', outboxId, generation, state, seq }) as const
    const page = (
        generation: number,
        state: 'active' | 'deleted',
        updates: { seq: number; epochId: number; envelope: string }[] = [],
    ) =>
        ({
            type: 'catchup_batch',
            docId: 'd1',
            generation,
            state,
            throughSeq: updates.at(-1)?.seq ?? 0,
            hasMore: false,
            updates,
        }) as const

    /** Whether a promise settles within `ms`, and how. Real timers only. */
    function settlement(promise: Promise<unknown>, ms = 50): Promise<'resolved' | 'rejected' | 'pending'> {
        return Promise.race([
            promise.then(
                () => 'resolved' as const,
                () => 'rejected' as const,
            ),
            new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms)),
        ])
    }

    /** Insert `text` at the end, flush it, and return the append that carried it. */
    async function edit(h: ReturnType<typeof engine>, text: string) {
        const content = h.sync.doc.getText('content')
        content.insert(content.length, text)
        await h.sync.flush()
        const append = h.ofType('append').at(-1)
        if (!append) throw new Error('expected append')
        return append
    }

    /** Store an operation an earlier session left in the outbox, sealed under epoch 1. */
    async function queued(cache: DocCache, keyring: Keyring, outboxId: string, text: string, createdAt: number) {
        const doc = new Y.Doc()
        doc.getText('content').insert(0, text)
        await cache.enqueue(
            {
                outboxId,
                kind: 'append',
                generation: 1,
                epochId: 1,
                envelope: await seal(keyring, Y.encodeStateAsUpdate(doc)),
                stateVector: Y.encodeStateVector(doc),
                createdAt,
            },
            { update: Y.encodeStateAsUpdate(doc), lastSeq: 0, lastSyncedStateVector: Y.encodeStateVector(new Y.Doc()) },
        )
    }

    describe('health', () => {
        it('blocks content only when the bytes are not this document’s', () => {
            expect(contentBlocked('key-unavailable')).toBe(true)
            expect(contentBlocked('ciphertext-corrupt')).toBe(true)
            expect(contentBlocked('healthy')).toBe(false)
            expect(contentBlocked('generation-stale')).toBe(false)
            expect(contentBlocked('sequence-gap')).toBe(false)
        })
    })

    describe('catch-up cycles', () => {
        it('starts a fresh catch-up cycle after one whose page could not be stored', async () => {
            const cache = memoryCache()
            const save = cache.save.bind(cache)
            let failing = true
            cache.save = async (state, options) => {
                if (failing) throw new Error('disk full')
                return save(state, options)
            }
            const h = engine({ persist: cache })
            await h.sync.ready()
            h.sync.resync()
            await expect(h.sync.receive(page(1, 'active'))).rejects.toThrow('disk full')
            await expect(h.sync.caughtUp()).rejects.toThrow('disk full')

            failing = false
            h.sync.resync()
            await h.sync.receive(page(1, 'active'))

            await expect(h.sync.caughtUp()).resolves.toBeUndefined()
            h.sync.destroy()
        })

        it('reports a page that changed the text to the search index', async () => {
            const keyring = createGraphKeyring('g1')
            const cache = memoryCache()
            const save = vi.spyOn(cache, 'save')
            const h = engine({ keyring, persist: cache })
            await h.sync.ready()

            await h.sync.receive(page(1, 'active', [{ seq: 1, epochId: 1, envelope: await peerEnvelope(keyring, 'Garden') }]))

            expect(save.mock.calls.at(-1)?.[1]).toMatchObject({ indexContentChanged: true })
            h.sync.destroy()
        })

        it('ends every catch-up wait when the engine is destroyed', async () => {
            const h = engine()
            await h.sync.ready()
            h.sync.resync()
            h.sync.destroy()
            expect(await settlement(h.sync.firstCatchupPage())).toBe('resolved')
            expect(await settlement(h.sync.caughtUp())).toBe('resolved')
        })

        it('adopts a deletion at a newer generation than the one it already holds deleted', async () => {
            const h = engine()
            await h.sync.ready()
            await h.sync.delete()
            await h.sync.receive(ack(h.ofType('delete')[0].outboxId, 0, 2, 'deleted'))

            await h.sync.receive(page(4, 'deleted'))

            expect(h.sync.generation()).toBe(4)
            expect(h.sync.lifecycle()).toBe('deleted')
            h.sync.destroy()
        })

        it('keeps a resurrection in flight when catch-up repeats the deletion, and finishes the catch-up', async () => {
            const h = engine()
            await h.sync.ready()
            await h.sync.delete()
            await h.sync.receive(ack(h.ofType('delete')[0].outboxId, 0, 2, 'deleted'))
            h.sync.doc.getText('content').insert(0, 'water the beans')
            await h.sync.flush()
            expect(h.ofType('resurrect')).toHaveLength(1)
            expect(h.sync.lifecycle()).toBe('resurrecting')

            await h.sync.receive(page(2, 'deleted'))

            expect(h.sync.doc.getText('content').toString()).toBe('water the beans')
            expect(await settlement(h.sync.caughtUp())).toBe('resolved')
            h.sync.destroy()
        })

        it('drops updates held for a gap in an older generation when a newer one arrives', async () => {
            const keyring = createGraphKeyring('g1')
            const h = engine({ keyring })
            await h.sync.ready()
            h.sync.doc.getText('content').insert(0, 'Garden')
            await h.sync.flush()
            // Held for the missing sequence 1 of generation 1.
            await h.sync.receive(update(2, await peerEnvelope(keyring, 'stale')))
            expect(h.sync.health()).toBe('sequence-gap')

            await h.sync.receive(page(2, 'active', [{ seq: 1, epochId: 1, envelope: await peerEnvelope(keyring, 'Kitchen') }]))

            expect(h.sync.doc.getText('content').toString()).toBe('Kitchen')
            expect(h.sync.health()).toBe('healthy')
            // Clearing the old generation is not an edit of this device's.
            expect((await h.cache.load())?.dirtyTokens).toBeUndefined()
            h.sync.destroy()
        })

        it('sends an edit made after a newer generation replaced the old one', async () => {
            const keyring = createGraphKeyring('g1')
            const h = engine({ keyring })
            await h.sync.ready()
            await h.sync.receive(page(1, 'active', [{ seq: 1, epochId: 1, envelope: await peerEnvelope(keyring, 'Garden') }]))
            await h.sync.receive(page(2, 'active', [{ seq: 1, epochId: 1, envelope: await peerEnvelope(keyring, 'Kitchen') }]))

            h.sync.doc.getText('content').insert(0, '- ')

            await vi.waitFor(() => expect(h.ofType('append')).toHaveLength(1))
            expect(h.ofType('append')[0].generation).toBe(2)
            h.sync.destroy()
        })

        it('empties a relay-deleted document without leaving an edit behind, then follows a peer’s resurrection', async () => {
            const keyring = createGraphKeyring('g1')
            const h = engine({ keyring })
            await h.sync.ready()
            h.sync.doc.getText('content').insert(0, 'Garden')
            await h.sync.flush()
            await h.sync.receive(update(2, await peerEnvelope(keyring, 'stale')))

            await h.sync.receive(page(2, 'deleted'))

            expect(h.queueSizes.at(-1)).toBe(0)
            expect(await h.cache.load()).toBeNull()
            await h.sync.receive(update(1, await peerEnvelope(keyring, 'Kitchen'), 3))
            expect(h.sync.doc.getText('content').toString()).toBe('Kitchen')
            expect(h.sync.health()).toBe('healthy')
            expect(h.sync.lifecycle()).toBe('active')
            h.sync.destroy()
        })
    })

    describe('text this device created (ADR 0157)', () => {
        it('sends created text again, whole, into the generation the relay moved to, once', async () => {
            const keyring = createGraphKeyring('g1')
            const h = engine({ keyring })
            await h.sync.ready()
            h.sync.claimCreation()
            await edit(h, 'Garden')
            expect((await h.cache.pending())[0]).toMatchObject({ creates: true })

            await h.sync.staleGeneration(3)
            await h.sync.receive(page(3, 'active', [{ seq: 1, epochId: 1, envelope: await peerEnvelope(keyring, 'Kitchen') }]))
            const resent = await edit(h, '')

            expect(h.sync.doc.getText('content').toString()).toContain('Garden')
            expect(h.sync.doc.getText('content').toString()).toContain('Kitchen')
            expect(resent.generation).toBe(3)
            expect(await textOf(keyring, resent.envelope)).toBe('Garden')

            // Acknowledged: a later catch-up is an ordinary one and writes nothing again.
            await h.sync.receive(ack(resent.outboxId, 2, 3))
            const before = h.ofType('append').length
            h.sync.resync()
            await h.sync.receive(page(3, 'active'))
            await h.sync.flush()
            expect(h.ofType('append')).toHaveLength(before)
            h.sync.destroy()
        })

        it('keeps created text when the relay holds the document deleted, and resurrects it', async () => {
            const keyring = createGraphKeyring('g1')
            const cache = memoryCache()
            const save = vi.spyOn(cache, 'save')
            const h = engine({ keyring, persist: cache })
            await h.sync.ready()
            h.sync.claimCreation()
            await edit(h, 'Garden')
            await h.sync.staleGeneration(3)

            await h.sync.receive(page(3, 'deleted'))

            expect(save.mock.calls.at(-1)?.[1]).toEqual({ indexContentChanged: true })
            expect((await cache.load())?.lifecycle).toBe('deleted')
            expect(h.sync.lifecycle()).toBe('deleted')
            expect(await settlement(h.sync.caughtUp())).toBe('resolved')
            await h.sync.flush()
            const resurrection = h.ofType('resurrect').at(-1)
            expect(resurrection).toMatchObject({ generation: 3 })
            expect(await textOf(keyring, resurrection!.envelope)).toBe('Garden')
            h.sync.destroy()
        })

        it('keeps created text through a reload before the relay answered it', async () => {
            const keyring = createGraphKeyring('g1')
            const cache = memoryCache()
            const first = engine({ keyring, persist: cache })
            await first.sync.ready()
            first.sync.claimCreation()
            await edit(first, 'Garden')
            first.sync.destroy()

            const second = engine({ keyring, persist: cache })
            await second.sync.ready()
            await second.sync.staleGeneration(3)
            await second.sync.receive(page(3, 'active'))

            expect(second.sync.doc.getText('content').toString()).toBe('Garden')
            const resent = await edit(second, '')
            expect(resent.generation).toBe(3)
            second.sync.destroy()
        })

        it('clears an earlier session’s ordinary edit when the relay moved past its generation', async () => {
            const cache = memoryCache()
            const keyring = createGraphKeyring('g1')
            const first = engine({ keyring, persist: cache })
            await first.sync.ready()
            await edit(first, 'Garden')
            first.sync.destroy()

            const second = engine({ keyring, persist: cache })
            await second.sync.ready()
            await second.sync.staleGeneration(3)

            expect(second.sync.doc.getText('content').toString()).toBe('')
            expect(second.queueSizes.at(-1)).toBe(0)
            second.sync.destroy()
        })

        it('keeps an ordinary edit when the relay names the generation it already has', async () => {
            const h = engine()
            await h.sync.ready()
            await edit(h, 'Garden')

            await h.sync.staleGeneration(1)

            expect(h.sync.doc.getText('content').toString()).toBe('Garden')
            h.sync.destroy()
        })

        it('treats created text as ordinary once the relay acknowledged it', async () => {
            const h = engine()
            await h.sync.ready()
            h.sync.claimCreation()
            const append = await edit(h, 'Garden')
            await h.sync.receive(ack(append.outboxId, 1))

            await h.sync.staleGeneration(3)

            expect(h.sync.doc.getText('content').toString()).toBe('')
            h.sync.destroy()
        })

        it('sends a resurrection again into the generation the relay moved to', async () => {
            const keyring = createGraphKeyring('g1')
            const h = engine({ keyring })
            await h.sync.ready()
            await h.sync.delete()
            await h.sync.receive(ack(h.ofType('delete')[0].outboxId, 0, 2, 'deleted'))
            h.sync.doc.getText('content').insert(0, 'Kitchen')
            await h.sync.flush()

            await h.sync.staleGeneration(4)
            await h.sync.receive(page(4, 'deleted'))
            await h.sync.flush()

            const resurrection = h.ofType('resurrect').at(-1)
            expect(resurrection).toMatchObject({ generation: 4 })
            expect(await textOf(keyring, resurrection!.envelope)).toBe('Kitchen')
            h.sync.destroy()
        })

        it('resurrects with the whole document, not a difference from the deleted generation', async () => {
            const keyring = createGraphKeyring('g1')
            const h = engine({ keyring })
            await h.sync.ready()
            const append = await edit(h, 'Garden')
            await h.sync.receive(ack(append.outboxId, 1))
            await h.sync.receive(page(2, 'deleted'))

            h.sync.doc.getText('content').insert(0, 'Kitchen')
            await h.sync.flush()

            const resurrection = h.ofType('resurrect').at(-1)
            expect(resurrection).toBeDefined()
            expect(await textOf(keyring, resurrection!.envelope)).toBe('Kitchen')
            h.sync.destroy()
        })
    })

    describe('acknowledgements', () => {
        it('stores the last contiguous sequence, not an acknowledged one beyond a gap', async () => {
            const h = engine()
            await h.sync.ready()
            const append = await edit(h, 'Garden')

            await h.sync.receive(ack(append.outboxId, 2))

            expect((await h.cache.load())?.lastSeq).toBe(0)
            h.sync.destroy()
        })

        it('stays healthy for an ack at the sequence it already holds', async () => {
            const keyring = createGraphKeyring('g1')
            const h = engine({ keyring })
            await h.sync.ready()
            const append = await edit(h, 'Garden')
            await h.sync.receive(update(1, await peerEnvelope(keyring, 'Kitchen')))
            const catchups = h.ofType('catchup').length

            await h.sync.receive(ack(append.outboxId, 1))

            expect(h.sync.health()).toBe('healthy')
            expect(h.ofType('catchup')).toHaveLength(catchups)
            h.sync.destroy()
        })

        it('ignores an ack when nothing is in flight', async () => {
            const h = engine()
            await h.sync.ready()
            await expect(h.sync.receive(ack('018f47a0-7b5d-7cc5-b5c1-0000000000b1', 1))).resolves.toBeUndefined()
            expect(h.ofType('ack_confirm')).toHaveLength(0)
            h.sync.destroy()
        })

        it('sends the next queued operation once the head is acknowledged', async () => {
            const keyring = createGraphKeyring('g1')
            const cache = memoryCache()
            await queued(cache, keyring, '018f47a0-7b5d-7cc5-b5c1-0000000000a1', 'Garden', 1)
            await queued(cache, keyring, '018f47a0-7b5d-7cc5-b5c1-0000000000a2', 'Kitchen', 2)
            const h = engine({ keyring, persist: cache })
            await h.sync.ready()
            h.sync.retryUnsent()
            await vi.waitFor(() => expect(h.ofType('append')).toHaveLength(1))

            await h.sync.receive(ack('018f47a0-7b5d-7cc5-b5c1-0000000000a1', 1))

            await vi.waitFor(() => expect(h.ofType('append')).toHaveLength(2))
            expect(h.ofType('append')[1].outboxId).toBe('018f47a0-7b5d-7cc5-b5c1-0000000000a2')
            h.sync.destroy()
        })

        it('sends an earlier session’s operations oldest first, and by id when they were made together', async () => {
            const keyring = createGraphKeyring('g1')
            const cache = memoryCache()
            await queued(cache, keyring, '018f47a0-7b5d-7cc5-b5c1-0000000000c3', 'Kitchen', 5)
            await queued(cache, keyring, '018f47a0-7b5d-7cc5-b5c1-0000000000c2', 'Garden', 2)
            await queued(cache, keyring, '018f47a0-7b5d-7cc5-b5c1-0000000000c1', 'Shed', 5)
            const h = engine({ keyring, persist: cache })
            await h.sync.ready()

            // Each acknowledgement sends the next operation in the queue.
            const order: string[] = []
            h.sync.retryUnsent()
            for (let index = 0; index < 3; index++) {
                await vi.waitFor(() => expect(h.ofType('append')).toHaveLength(index + 1))
                const head = h.ofType('append')[index]
                order.push(head.outboxId)
                await h.sync.receive(ack(head.outboxId, index + 1))
            }

            expect(order).toEqual([
                '018f47a0-7b5d-7cc5-b5c1-0000000000c2',
                '018f47a0-7b5d-7cc5-b5c1-0000000000c1',
                '018f47a0-7b5d-7cc5-b5c1-0000000000c3',
            ])
            h.sync.destroy()
        })
    })

    describe('the durable outbox', () => {
        it('records each send attempt against the stored operation', async () => {
            const h = engine({ now: () => 1234 })
            await h.sync.ready()
            await edit(h, 'Garden')

            expect((await h.cache.pending())[0]).toMatchObject({ attemptCount: 1, lastAttemptAt: 1234 })
            h.sync.destroy()
        })

        it('clears the edit boundaries an operation carries', async () => {
            const h = engine({ debounceMs: 60_000 })
            await h.sync.ready()
            h.sync.doc.getText('content').insert(0, 'Garden')
            await vi.waitFor(async () => expect((await h.cache.load())?.dirtyTokens).toHaveLength(1))

            await h.sync.flush()

            expect((await h.cache.load())?.dirtyTokens).toBeUndefined()
            h.sync.destroy()
        })

        it('clears the edit boundaries on the retry after an enqueue failed', async () => {
            const cache = memoryCache()
            const enqueue = cache.enqueue.bind(cache)
            let failures = 1
            cache.enqueue = async (...args) => {
                if (failures-- > 0) throw new Error('disk full')
                return enqueue(...args)
            }
            const h = engine({ persist: cache })
            await h.sync.ready()
            h.sync.doc.getText('content').insert(0, 'Garden')
            await expect(h.sync.flush()).rejects.toThrow('disk full')

            await h.sync.flush()

            expect(h.ofType('append')).toHaveLength(1)
            expect((await cache.load())?.dirtyTokens).toBeUndefined()
            h.sync.destroy()
        })

        it('reports a failed save once, fails the next flush, and recovers after a save succeeds', async () => {
            const cache = memoryCache()
            const save = cache.save.bind(cache)
            let failing = false
            cache.save = async (state, options) => {
                if (failing) throw new Error('disk full')
                return save(state, options)
            }
            const h = engine({ persist: cache })
            await h.sync.ready()
            await edit(h, 'Garden')

            failing = true
            h.sync.doc.getText('content').insert(0, '- ')
            await expect(h.sync.flush()).rejects.toThrow('disk full')
            expect(h.errors.map((error) => error.message)).toEqual(['disk full'])

            failing = false
            h.sync.doc.getText('content').insert(0, '- ')
            await expect(h.sync.flush()).resolves.toBeUndefined()
            h.sync.destroy()
        })

        it('reports a send that fails on retry', async () => {
            let failing = false
            const h = engine({
                send: (message) => {
                    if (failing) throw new Error('socket closed')
                    h.sent.push(message)
                },
            })
            await h.sync.ready()
            await edit(h, 'Garden')

            failing = true
            h.sync.retryUnsent()

            await vi.waitFor(() => expect(h.errors.map((error) => error.message)).toEqual(['socket closed']))
            h.sync.destroy()
        })

        it('reports nothing when a resend finds its operation already acknowledged', async () => {
            const cache = memoryCache()
            const commit = cache.commitAcknowledgement.bind(cache)
            let commitStarted!: () => void
            const started = new Promise<void>((resolve) => {
                commitStarted = resolve
            })
            let releaseCommit!: () => void
            const gate = new Promise<void>((resolve) => {
                releaseCommit = resolve
            })
            cache.commitAcknowledgement = async (...args) => {
                commitStarted()
                await gate
                return commit(...args)
            }
            const h = engine({ persist: cache })
            await h.sync.ready()
            const append = await edit(h, 'Garden')
            const acked = h.sync.receive(ack(append.outboxId, 1))
            await started
            h.sync.retryUnsent()
            releaseCommit()
            await acked
            await new Promise((resolve) => setTimeout(resolve, 15))

            expect(h.errors).toEqual([])
            h.sync.destroy()
        })

        it('collects the cache row once while the document keeps reading as wanted', async () => {
            const cache = memoryCache()
            let collected = 0
            cache.compact = async () => {
                collected += 1
            }
            const h = engine({ persist: cache, collectRowWhen: () => true })
            await h.sync.ready()

            await edit(h, 'Garden')
            await edit(h, ' Kitchen')

            expect(collected).toBe(1)
            h.sync.destroy()
        })

        it('sends unqueued local work on retry', async () => {
            const h = engine({ debounceMs: 60_000 })
            await h.sync.ready()
            h.sync.doc.getText('content').insert(0, 'Garden')

            h.sync.retryUnsent()

            await vi.waitFor(() => expect(h.ofType('append')).toHaveLength(1))
            h.sync.destroy()
        })

        it('does nothing on retry after the engine is destroyed, or when nothing is queued', async () => {
            const h = engine()
            await h.sync.ready()
            h.sync.retryUnsent()
            await new Promise((resolve) => setTimeout(resolve, 15))
            expect(h.errors).toEqual([])

            await edit(h, 'Garden')
            h.sync.destroy()
            h.sync.retryUnsent()
            await new Promise((resolve) => setTimeout(resolve, 15))
            expect(h.ofType('append')).toHaveLength(1)
        })
    })

    describe('relay updates', () => {
        it('refuses an update from another generation of an active document', async () => {
            const keyring = createGraphKeyring('g1')
            const h = engine({ keyring })
            await h.sync.ready()

            await h.sync.receive(update(1, await peerEnvelope(keyring, 'Garden'), 2))

            expect(h.sync.doc.getText('content').toString()).toBe('')
            expect(h.sync.health()).toBe('generation-stale')
            expect(h.sync.generation()).toBe(1)
            h.sync.destroy()
        })

        it('follows a peer’s resurrection only as the first update of the next generation', async () => {
            const keyring = createGraphKeyring('g1')
            const deletedAt2 = async () => {
                const h = engine({ keyring })
                await h.sync.ready()
                await h.sync.delete()
                await h.sync.receive(ack(h.ofType('delete')[0].outboxId, 0, 2, 'deleted'))
                return h
            }
            const envelope = await peerEnvelope(keyring, 'Garden')

            const skipped = await deletedAt2()
            await skipped.sync.receive(update(1, envelope, 4))
            expect(skipped.sync.health()).toBe('generation-stale')
            skipped.sync.destroy()

            const later = await deletedAt2()
            await later.sync.receive(update(2, envelope, 3))
            expect(later.sync.health()).toBe('generation-stale')
            later.sync.destroy()

            const first = await deletedAt2()
            await first.sync.receive(update(1, envelope, 3))
            expect(first.sync.doc.getText('content').toString()).toBe('Garden')
            expect(first.sync.lifecycle()).toBe('active')
            expect(first.sync.generation()).toBe(3)
            first.sync.destroy()
        })

        it('treats a repeated update as applied, without a catch-up or an index change', async () => {
            const keyring = createGraphKeyring('g1')
            const cache = memoryCache()
            const save = vi.spyOn(cache, 'save')
            const h = engine({ keyring, persist: cache })
            await h.sync.ready()
            const envelope = await peerEnvelope(keyring, 'Garden')
            await h.sync.receive(update(1, envelope))

            await h.sync.receive(update(1, envelope))

            expect(h.sync.health()).toBe('healthy')
            expect(h.ofType('catchup')).toHaveLength(0)
            expect(save.mock.calls.at(-1)?.[1]).toMatchObject({ indexContentChanged: false })
            h.sync.destroy()
        })

        it('stores nothing for an update it could not apply', async () => {
            const keyring = createGraphKeyring('g1')
            const cache = memoryCache()
            const save = vi.spyOn(cache, 'save')
            const h = engine({ keyring, persist: cache })
            await h.sync.ready()

            await h.sync.receive(update(2, await peerEnvelope(keyring, 'Garden')))
            await h.sync.receive(update(1, await peerEnvelope(keyring, 'Garden'), 2))
            await h.sync.receive({ type: 'update', docId: 'd1', generation: 1, seq: 1, epochId: 99, envelope: 'AQEAAAA' })

            expect(save).not.toHaveBeenCalled()
            h.sync.destroy()
        })

        it('reports a missing key once however often the update arrives, and a newer one again', async () => {
            const owner = bumpEpoch(bumpEpoch(createGraphKeyring('g1')))
            const missing: number[] = []
            const cache = memoryCache()
            const save = vi.spyOn(cache, 'save')
            const h = engine({ keyring: { graphId: 'g1', epochs: owner.epochs.slice(0, 1) }, persist: cache, onMissingKey: (epochId) => missing.push(epochId) })
            await h.sync.ready()
            const underEpoch2 = await peerEnvelope({ graphId: 'g1', epochs: owner.epochs.slice(0, 2) }, 'Garden')
            const underEpoch3 = await peerEnvelope(owner, 'Garden')

            await h.sync.receive({ ...update(1, underEpoch2), epochId: 2 })
            await h.sync.receive({ ...update(1, underEpoch2), epochId: 2 })
            await h.sync.receive({ ...update(3, underEpoch2), epochId: 2 })
            expect(missing).toEqual([2])
            await h.sync.receive({ ...update(1, underEpoch3), epochId: 3 })
            expect(missing).toEqual([2, 3])
            expect(save).not.toHaveBeenCalled()

            // The keyring changed, but not to one holding the key: nothing is asked for again.
            await h.sync.keysChanged()
            expect(h.sync.health()).toBe('key-unavailable')
            expect(h.ofType('catchup')).toHaveLength(0)
            h.sync.destroy()
        })

        it('still sends a local edit that a relay update overtook before the debounce fired', async () => {
            const keyring = createGraphKeyring('g1')
            const h = engine({ keyring, debounceMs: 60_000 })
            await h.sync.ready()
            h.sync.doc.getText('content').insert(0, 'Garden')

            await h.sync.receive(update(1, await peerEnvelope(keyring, 'Kitchen')))
            await h.sync.flush()

            const append = h.ofType('append').at(-1)
            expect(append).toBeDefined()
            expect(await textOf(keyring, append!.envelope)).toBe('Garden')
            h.sync.destroy()
        })

        it('does not send back a relay update that arrived while the cache was loading', async () => {
            const keyring = createGraphKeyring('g1')
            const cache = memoryCache()
            const load = cache.load.bind(cache)
            let release!: () => void
            const gate = new Promise<void>((resolve) => {
                release = resolve
            })
            cache.load = async () => {
                const state = await load()
                await gate
                return state
            }
            const h = engine({ keyring, persist: cache })
            const ready = h.sync.ready()
            // A deletion in its history makes any difference from it non-empty.
            await h.sync.receive(update(1, await peerEnvelope(keyring, 'Garden', 's')))
            release()
            await ready

            await h.sync.flush()

            expect(h.ofType('append')).toHaveLength(0)
            h.sync.destroy()
        })
    })

    describe('loading the cache', () => {
        it('takes the generation and lifecycle the cache holds', async () => {
            const cache = memoryCache()
            await cache.save({ update: Y.encodeStateAsUpdate(new Y.Doc()), lastSeq: 0, lastSyncedStateVector: Y.encodeStateVector(new Y.Doc()), generation: 3, lifecycle: 'deleted' })
            const h = engine({ persist: cache })

            await h.sync.ready()

            expect(h.sync.generation()).toBe(3)
            expect(h.sync.lifecycle()).toBe('deleted')
            h.sync.destroy()
        })

        it('is active and reports its queue once ready with an empty cache', async () => {
            const h = engine()
            await h.sync.ready()
            expect(h.sync.lifecycle()).toBe('active')
            expect(h.queueSizes).toEqual([0])
            h.sync.destroy()
        })

        it('sends nothing for a cached document the relay already holds, deletions included', async () => {
            const doc = new Y.Doc()
            doc.getText('content').insert(0, 'Gardens')
            doc.getText('content').delete(6, 1)
            const cache = memoryCache()
            await cache.save({ update: Y.encodeStateAsUpdate(doc), lastSeq: 1, lastSyncedStateVector: Y.encodeStateVector(doc), generation: 1, lifecycle: 'active' })
            const h = engine({ persist: cache })
            await h.sync.ready()

            await h.sync.flush()

            expect(h.ofType('append')).toHaveLength(0)
            h.sync.destroy()
        })

        it('sends nothing for an edit boundary whose edit the relay already holds', async () => {
            const doc = new Y.Doc()
            doc.getText('content').insert(0, 'Garden')
            const cache = memoryCache()
            await cache.save(
                { update: Y.encodeStateAsUpdate(doc), lastSeq: 1, lastSyncedStateVector: Y.encodeStateVector(doc), generation: 1, lifecycle: 'active' },
                { dirtyToken: 'earlier-session:1' },
            )
            const h = engine({ persist: cache })
            await h.sync.ready()

            await h.sync.flush()

            expect(h.ofType('append')).toHaveLength(0)
            h.sync.destroy()
        })

        it('settles an earlier session’s edit boundaries with a delete', async () => {
            const cache = memoryCache()
            const first = engine({ persist: cache, debounceMs: 60_000 })
            await first.sync.ready()
            first.sync.doc.getText('content').insert(0, 'Garden')
            await vi.waitFor(async () => expect((await cache.load())?.dirtyTokens).toHaveLength(1))
            first.sync.destroy()

            const second = engine({ persist: cache })
            await second.sync.ready()
            await second.sync.delete()

            expect((await cache.load())?.dirtyTokens).toBeUndefined()
            second.sync.destroy()
        })

        it('sends an edit cached behind a replayed operation once that operation is acknowledged', async () => {
            const keyring = createGraphKeyring('g1')
            const cache = memoryCache()
            const first = engine({ keyring, persist: cache })
            await first.sync.ready()
            const append = await edit(first, 'Garden')
            first.sync.doc.getText('content').insert(6, ' Kitchen')
            await vi.waitFor(async () => expect((await cache.load())?.dirtyTokens).toHaveLength(1))
            first.sync.destroy()
            // Without the edit's boundary, only the replayed operation says the cache is ahead.
            const load = cache.load.bind(cache)
            cache.load = async () => {
                const state = await load()
                return state && { ...state, dirtyTokens: undefined }
            }

            const second = engine({ keyring, persist: cache })
            await second.sync.ready()
            await second.sync.receive(ack(append.outboxId, 1))

            await vi.waitFor(() => expect(second.ofType('append')).toHaveLength(1))
            second.sync.destroy()
        })
    })

    describe('deleting', () => {
        it('empties the document, settles its edit boundaries and sends one delete', async () => {
            const h = engine()
            await h.sync.ready()
            await edit(h, 'Garden')
            h.sync.doc.getText('content').insert(0, '- ')

            await h.sync.delete()
            await h.sync.delete()

            expect(h.sync.doc.getText('content').toString()).toBe('')
            expect((await h.cache.load())?.dirtyTokens).toBeUndefined()
            expect(h.queueSizes.slice(-2)).toEqual([0, 1])
            expect(h.ofType('delete')).toHaveLength(1)
            expect(h.ofType('delete')[0]).toStrictEqual({
                type: 'delete',
                docId: 'd1',
                outboxId: h.ofType('delete')[0].outboxId,
                generation: 1,
            })
            await h.sync.receive(ack(h.ofType('delete')[0].outboxId, 0, 2, 'deleted'))
            await h.sync.delete()
            expect(h.ofType('delete')).toHaveLength(1)
            h.sync.destroy()
        })

        it('sends an edit made after the deletion settled without a flush', async () => {
            const h = engine()
            await h.sync.ready()
            h.sync.doc.getText('content').insert(0, 'Garden')
            await h.sync.flush()
            await h.sync.delete()
            await h.sync.receive(ack(h.ofType('delete')[0].outboxId, 0, 2, 'deleted'))

            h.sync.doc.getText('content').insert(0, 'Kitchen')

            await vi.waitFor(() => expect(h.ofType('resurrect')).toHaveLength(1))
            h.sync.destroy()
        })
    })

    describe('Graph Key epochs', () => {
        it('keeps a refused delete as it is when the keyring changes', async () => {
            let keyring: Keyring = createGraphKeyring('g1')
            const h = engine({ keyring: () => keyring })
            await h.sync.ready()
            await h.sync.delete()
            h.sync.staleEpoch(h.ofType('delete')[0].outboxId)
            keyring = bumpEpoch(keyring)

            await expect(h.sync.keysChanged()).resolves.toBeUndefined()

            expect(h.sync.unsentOperations()).toBe(1)
            expect((await h.cache.pending())[0].outboxId).toBe(h.ofType('delete')[0].outboxId)
            h.sync.destroy()
        })

        it('does not seal again a refused write already under the newest epoch', async () => {
            const h = engine()
            await h.sync.ready()
            const append = await edit(h, 'Garden')
            h.sync.staleEpoch(append.outboxId)

            await h.sync.keysChanged()

            expect(h.ofType('append')).toHaveLength(1)
            expect((await h.cache.pending())[0].outboxId).toBe(append.outboxId)
            h.sync.destroy()
        })

        it('sends nothing more once a write sealed again is acknowledged', async () => {
            let keyring: Keyring = createGraphKeyring('g1')
            const h = engine({ keyring: () => keyring })
            await h.sync.ready()
            const content = h.sync.doc.getText('content')
            content.insert(0, 'Gardens')
            content.delete(6, 1)
            await h.sync.flush()
            const [refused] = h.ofType('append')
            h.sync.staleEpoch(refused.outboxId)
            keyring = bumpEpoch(keyring)
            await h.sync.keysChanged()
            const resealed = h.ofType('append').at(-1)!
            expect(resealed.outboxId).not.toBe(refused.outboxId)

            await h.sync.receive(ack(resealed.outboxId, 1))
            await h.sync.flush()

            expect(h.ofType('append')).toHaveLength(2)
            h.sync.destroy()
        })

        it('does not resend the head when only an operation behind it was sealed again', async () => {
            let keyring: Keyring = createGraphKeyring('g1')
            const cache = memoryCache()
            await queued(cache, keyring, '018f47a0-7b5d-7cc5-b5c1-0000000000a1', 'Garden', 1)
            await queued(cache, keyring, '018f47a0-7b5d-7cc5-b5c1-0000000000a2', 'Kitchen', 2)
            const h = engine({ keyring: () => keyring, persist: cache })
            await h.sync.ready()
            keyring = bumpEpoch(keyring)

            await h.sync.keysChanged()

            expect(h.ofType('append')).toHaveLength(0)
            h.sync.destroy()
        })

        it('asks for nothing when the keyring changes while no update waits for a key', async () => {
            let keyring: Keyring = createGraphKeyring('g1')
            const h = engine({ keyring: () => keyring })
            await h.sync.ready()
            keyring = bumpEpoch(keyring)

            await h.sync.keysChanged()

            expect(h.sync.health()).toBe('healthy')
            expect(h.ofType('catchup')).toHaveLength(0)
            h.sync.destroy()
        })
    })

    describe('snapshots', () => {
        async function ackedEdit(h: ReturnType<typeof engine>, text: string, seq = 1) {
            const append = await edit(h, text)
            await h.sync.receive(ack(append.outboxId, seq))
        }

        it('uploads no snapshot while an operation is in flight, behind a gap, or after destroy', async () => {
            const keyring = createGraphKeyring('g1')
            const inFlight = engine({ keyring })
            await inFlight.sync.ready()
            await ackedEdit(inFlight, 'Garden')
            await edit(inFlight, ' Kitchen')
            await inFlight.sync.compact()
            expect(inFlight.ofType('snapshot_put')).toHaveLength(0)
            inFlight.sync.destroy()

            const gap = engine({ keyring })
            await gap.sync.ready()
            await ackedEdit(gap, 'Garden')
            await gap.sync.receive(update(3, await peerEnvelope(keyring, 'Kitchen')))
            await gap.sync.compact()
            expect(gap.ofType('snapshot_put')).toHaveLength(0)
            gap.sync.destroy()

            const destroyed = engine({ keyring })
            await destroyed.sync.ready()
            await ackedEdit(destroyed, 'Garden')
            const compacting = destroyed.sync.compact()
            destroyed.sync.destroy()
            await compacting
            expect(destroyed.ofType('snapshot_put')).toHaveLength(0)
        })

        it('ignores a read-back with no snapshot in flight, from another generation, or after destroy', async () => {
            const h = engine()
            await h.sync.ready()
            await expect(
                h.sync.receive({ type: 'snapshot_data', docId: 'd1', generation: 1, throughSeq: 1, epochId: 1, envelope: 'AAAA' }),
            ).resolves.toBeUndefined()
            await ackedEdit(h, 'Garden')
            await h.sync.compact()
            const put = h.ofType('snapshot_put')[0]
            await h.sync.receive({ type: 'snapshot_data', docId: 'd1', generation: 2, throughSeq: 1, epochId: put.epochId, envelope: put.envelope })
            expect(h.ofType('snapshot_verified')).toHaveLength(0)

            const reading = h.sync.receive({ type: 'snapshot_data', docId: 'd1', generation: 1, throughSeq: 1, epochId: put.epochId, envelope: put.envelope })
            h.sync.destroy()
            await reading
            expect(h.ofType('snapshot_verified')).toHaveLength(0)
        })

        const idle = () => new Promise((resolve) => setTimeout(resolve, 40))

        it('does not compact a short tail under the default byte floor', async () => {
            const h = engine({ compaction: { idleMs: 5 } })
            await h.sync.ready()
            await ackedEdit(h, 'Garden')
            await idle()
            expect(h.ofType('snapshot_put')).toHaveLength(0)
            h.sync.destroy()
        })

        it('counts relay updates towards compaction, by number and by size', async () => {
            const keyring = createGraphKeyring('g1')
            const byCount = engine({ keyring, compaction: { minUpdates: 2, minBytes: Number.MAX_SAFE_INTEGER, idleMs: 5 } })
            await byCount.sync.ready()
            await byCount.sync.receive(update(1, await peerEnvelope(keyring, 'Garden')))
            await byCount.sync.receive(update(2, await peerEnvelope(keyring, 'Kitchen')))
            await vi.waitFor(() => expect(byCount.ofType('snapshot_put')).toHaveLength(1))
            byCount.sync.destroy()

            const bySize = engine({ keyring, compaction: { minUpdates: Number.MAX_SAFE_INTEGER, minBytes: 1, idleMs: 5 } })
            await bySize.sync.ready()
            await bySize.sync.receive(update(1, await peerEnvelope(keyring, 'Garden')))
            await vi.waitFor(() => expect(bySize.ofType('snapshot_put')).toHaveLength(1))
            bySize.sync.destroy()
        })

        it('uploads a fresh snapshot at the next idle after a read-back fails or the snapshot is refused', async () => {
            const h = engine({ compaction: { minUpdates: 1, minBytes: Number.MAX_SAFE_INTEGER, idleMs: 5 } })
            await h.sync.ready()
            await ackedEdit(h, 'Garden')
            await vi.waitFor(() => expect(h.ofType('snapshot_put')).toHaveLength(1))

            await h.sync.receive({ type: 'snapshot_ack', docId: 'd1', generation: 1, throughSeq: 1 })
            await h.sync.receive({ type: 'snapshot_data', docId: 'd1', generation: 1, throughSeq: 1, epochId: 1, envelope: 'AAECAwQFBgcICQ' })
            expect(h.ofType('snapshot_verified')).toHaveLength(0)
            await vi.waitFor(() => expect(h.ofType('snapshot_put')).toHaveLength(2))

            h.sync.staleEpoch()
            await vi.waitFor(() => expect(h.ofType('snapshot_put')).toHaveLength(3))
            await idle()
            expect(h.ofType('snapshot_put')).toHaveLength(3)
            h.sync.destroy()
        })
    })

    describe('presence', () => {
        it('sends one tombstone a peer applies, then sends later states again', async () => {
            const keyring = createGraphKeyring('g1')
            const a = engine({ keyring })
            const b = engine({ keyring })
            await a.sync.ready()
            await b.sync.ready()
            a.sync.awareness.setLocalStateField('user', { name: 'Calm Owl' })
            await vi.waitFor(() => expect(a.ofType('presence')).toHaveLength(1))
            await b.sync.receivePresence(a.ofType('presence')[0].envelope)
            expect(b.sync.awareness.getStates().has(a.sync.doc.clientID)).toBe(true)
            // A peer's state is applied, never sent back.
            await new Promise((resolve) => setTimeout(resolve, 15))
            expect(b.ofType('presence')).toHaveLength(0)

            await a.sync.clearPresence()
            await new Promise((resolve) => setTimeout(resolve, 15))
            expect(a.ofType('presence')).toHaveLength(2)
            await b.sync.receivePresence(a.ofType('presence')[1].envelope)
            expect(b.sync.awareness.getStates().has(a.sync.doc.clientID)).toBe(false)

            await a.sync.clearPresence()
            expect(a.ofType('presence')).toHaveLength(2)

            a.sync.awareness.setLocalState({ user: { name: 'Calm Owl' } })
            await vi.waitFor(() => expect(a.ofType('presence')).toHaveLength(3))
            a.sync.destroy()
            b.sync.destroy()
        })
    })
})

describe('deleting a document with an edit still waiting to be sent', () => {
    it('is idle again once the deletion settles, so its engine can be released', async () => {
        const { sync, sent } = harness()
        await sync.ready()
        sync.doc.getText('content').insert(0, 'water the beans')

        // Before the debounce fires.
        await sync.delete()
        const deletion = sent.find((message) => message.type === 'delete')
        if (deletion?.type !== 'delete') throw new Error('expected delete')
        await sync.receive({ type: 'ack', outboxId: deletion.outboxId, generation: 2, state: 'deleted', seq: 0 })

        expect(sync.lifecycle()).toBe('deleted')
        expect(sync.isIdle()).toBe(true)
        sync.destroy()
    })
})
