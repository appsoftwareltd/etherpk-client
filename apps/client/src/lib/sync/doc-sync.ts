/**
 * One encrypted Yjs document sync engine. Local state is written to IndexedDB before
 * transmission, and at most one durable append per document is in flight. A reconnect
 * therefore retries the same outbox ID and ciphertext instead of manufacturing a new
 * operation from volatile state.
 */
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import { contextAad, envelopeEpochId, openSymmetric, sealSymmetric, toBase64Url, fromBase64Url } from '$lib/crypto'
import type { GraphKeyring } from '$lib/crypto'
import { currentEpoch, keyForEpoch } from '$lib/crypto'
import { SYNC_PROTOCOL_LIMITS } from '@appsoftwareltd/etherpk-shared'
import type { RelayClientMessage, RelayServerMessage } from './messages'
import { mergeStateVectors } from './state-vector'

/** Transaction origin marking a change as relay-originated and never independently re-sent. */
export const REMOTE = Symbol('etherpk-remote')
/** Local IndexedDB hydration is restored state, not a new edit or remote delta. */
export const CACHE_SEED = Symbol('etherpk-cache-seed')
/** Structural lifecycle changes which must never be mistaken for a user's edit. */
export const SUPPRESSED = Symbol('etherpk-suppressed')

export interface DocCacheState {
    update: Uint8Array
    lastSeq: number
    lastSyncedStateVector: Uint8Array
    generation?: number
    lifecycle?: 'active' | 'deleted'
    /**
     * Persistence-boundary tokens for local edits present in `update` but not yet covered
     * by a durable outbox operation. A set is required because several tabs can save the
     * same document independently before any one of them reaches its append debounce.
     */
    dirtyTokens?: readonly string[]
}

export interface DocCacheSaveOptions {
    /** Add one local-edit boundary without clearing boundaries written by another tab. */
    dirtyToken?: string
    /** Replace this session's preceding boundary atomically with `dirtyToken`. */
    supersededDirtyToken?: string
    /**
     * Whether this save observed an effective Yjs update. Local Cache uses this O(1) signal
     * for ordinary documents; root documents still compare their registry projection.
     */
    indexContentChanged?: boolean
}

export interface DocCacheEnqueueOptions {
    /** Clear only boundaries represented by this exact encrypted operation. */
    settledDirtyTokens?: readonly string[]
}

interface NewOutboxBase {
    outboxId: string
    generation: number
    createdAt: number
}

export interface NewAppendOperation extends NewOutboxBase {
    kind: 'append' | 'resurrect'
    epochId: number
    envelope: string
    stateVector: Uint8Array
}

export interface NewDeleteOperation extends NewOutboxBase {
    kind: 'delete'
}

export type NewOutboxOperation = NewAppendOperation | NewDeleteOperation

export type DurableOutboxOperation = NewOutboxOperation & {
    graphId: string
    docId: string
    attemptCount: number
    lastAttemptAt: number | null
}

export interface DocCache {
    load(): Promise<DocCacheState | null>
    save(state: DocCacheState, options?: DocCacheSaveOptions): Promise<void>
    /** Store the current document and its exact encrypted operation in one transaction. */
    enqueue(
        operation: NewOutboxOperation,
        state: DocCacheState,
        options?: DocCacheEnqueueOptions,
    ): Promise<void>
    pending(): Promise<DurableOutboxOperation[]>
    /**
     * Rewrite the row's update as a garbage-collected state: the same clocks, the same
     * information about what exists, and nothing about what was deleted. `mergeUpdates`
     * never collects, so a document's original body stays in the unencrypted row for the
     * life of the document otherwise - readable from the profile directory with no key of any
     * kind once the document has been protected (ADR 0057's third adversary).
     */
    compact(): Promise<void>
    markAttempt(outboxId: string, attemptedAt: number): Promise<void>
    /** Advance state and remove the matching operation in one transaction. */
    commitAcknowledgement(
        outboxId: string,
        generation: number,
        seq: number,
        update: Uint8Array,
        lastSyncedStateVector: Uint8Array,
    ): Promise<boolean>
    commitDeleteAcknowledgement(outboxId: string, generation: number): Promise<boolean>
    discard(outboxId: string): Promise<void>
    purge(): Promise<void>
}

export interface DocSyncDeps {
    docId: string
    graphId: string
    keyring: GraphKeyring
    send(message: RelayClientMessage): void
    persist: DocCache
    debounceMs?: number
    now?: () => number
    generation?: number
    newOutboxId?: () => string
    /** Cache and transport failures are user-visible diagnostics, not swallowed promises. */
    onError?: (error: Error) => void
    /** Lets the graph release an unretained engine once its durable work has settled. */
    onIdle?: () => void
    /**
     * When true of the document, its cache row is rewritten as a garbage-collected state
     * after the next persist, once per stretch of being true. For a [[Protected Document]]:
     * the row otherwise keeps the pre-protection body merged in for ever, on every device that
     * receives the protect, not only the one that did it.
     */
    collectRowWhen?: (doc: Y.Doc) => boolean
    /** Foreground views overtake background hydration at the graph scheduler. */
    catchupPriority?: () => 'foreground' | 'background'
    /**
     * When an idle document uploads a consolidated snapshot (ADR 0025, amended 2026-09-12):
     * once the unsnapshotted tail reaches `minUpdates` rows, or holds `minBytes` more than
     * the document's own encoded state, after `idleMs` without a local edit.
     */
    compaction?: {
        minUpdates?: number
        minBytes?: number
        idleMs?: number
    }
}

export interface DocSync {
    readonly doc: Y.Doc
    readonly awareness: Awareness
    ready(): Promise<void>
    receive(message: RelayServerMessage): Promise<void>
    receivePresence(envelope: string): Promise<void>
    /** Resolves once this engine's first relay catch-up page has been applied and persisted. */
    firstCatchupPage(): Promise<void>
    /** Resolves only when the current catch-up cycle reaches a terminal relay page. */
    caughtUp(): Promise<void>
    resync(): void
    compact(): Promise<void>
    flush(): Promise<void>
    delete(): Promise<void>
    lifecycle(): 'seeding' | 'active' | 'deleting' | 'deleted' | 'resurrecting'
    health(): SyncHealth
    staleGeneration(currentGeneration: number): Promise<void>
    /** Relay an awareness tombstone before the graph drops this document subscription. */
    clearPresence(): Promise<void>
    /**
     * Re-send the current local awareness state. A subscribe carries no presence, and a
     * state set while the socket was closed (or before a reconnect) was dropped — this is
     * the client half of the late-join handshake: advertise right after subscribing so the
     * relay can store the envelope and replay it to whoever subscribes next.
     */
    advertisePresence(): Promise<void>
    /** True only when destroying the engine cannot strand a locally queued operation. */
    isIdle(): boolean
    destroy(): void
}

export type SyncHealth = 'healthy' | 'key-unavailable' | 'ciphertext-corrupt' | 'generation-stale' | 'sequence-gap'

interface SyncCompletion {
    readonly promise: Promise<void>
    readonly settled: boolean
    resolve(): void
    reject(error: Error): void
}

function newSyncCompletion(): SyncCompletion {
    let resolvePromise!: () => void
    let rejectPromise!: (error: Error) => void
    let settled = false
    const promise = new Promise<void>((resolve, reject) => {
        resolvePromise = resolve
        rejectPromise = reject
    })
    // A document can be used without both readiness milestones being observed. Attach a
    // rejection handler here so a cache failure is still available to callers without
    // becoming an unrelated global unhandled-rejection event.
    void promise.catch(() => undefined)
    return {
        promise,
        get settled() {
            return settled
        },
        resolve() {
            if (settled) return
            settled = true
            resolvePromise()
        },
        reject(error) {
            if (settled) return
            settled = true
            rejectPromise(error)
        },
    }
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error))
}

export function createDocSync(deps: DocSyncDeps): DocSync {
    const { docId, graphId, keyring, send, persist } = deps
    const debounceMs = deps.debounceMs ?? 300
    const now = deps.now ?? Date.now
    const generation = deps.generation ?? 1
    const newOutboxId = deps.newOutboxId ?? (() => crypto.randomUUID())
    const aad = contextAad('update', `graph:${graphId}`, `doc:${docId}`)
    const presenceAad = contextAad('presence', `graph:${graphId}`, `doc:${docId}`)
    const doc = new Y.Doc()
    const awareness = new Awareness(doc)

    // Presentation and reconciliation have deliberately different readiness boundaries.
    // A cold editor can render after one page, but cache/index reconciliation must retain
    // its cross-tab lock until every continuation page in the current cycle has landed.
    const firstCatchupPage = newSyncCompletion()
    let catchupCompletion = newSyncCompletion()
    let catchupActive = false
    let lastSeq = 0
    let documentGeneration = generation
    let lifecycleState: ReturnType<DocSync['lifecycle']> = 'seeding'
    let syncHealth: SyncHealth = 'healthy'
    let lastSyncedStateVector = Y.encodeStateVector(doc)
    /**
     * The document state (state vector AND delete set) the relay is known to hold, advanced
     * at acknowledgement boundaries. Session-local: it seeds from the cached document, whose
     * deletions are either relay-originated or replayed by the durable outbox. Snapshot
     * equality is the drain's "nothing to send" test. State vectors alone cannot see
     * deletions, and diff length cannot ignore them.
     */
    let lastSyncedSnapshot: Y.Snapshot | undefined
    /** Boundary snapshots captured when each in-flight operation's diff was encoded. */
    const boundarySnapshots = new Map<string, Y.Snapshot>()
    let durableQueue: DurableOutboxOperation[] = []
    let debounceTimer: ReturnType<typeof setTimeout> | undefined
    let drainPromise: Promise<void> | undefined
    const futureUpdates = new Map<number, { envelope: string; generation: number }>()
    let persistenceTail = Promise.resolve()
    let lastPersistenceError: Error | undefined
    let seeding = false
    /** Incremented only when Yjs says an update changed this live document. */
    let indexMutationVersion = 0
    /** A local edit landed before the cache seed finished, so the live doc is ahead of it. */
    let localEditsBeforeSeed = false
    /** Dirty boundaries loaded from a prior tab/session and not yet moved into the outbox. */
    const recoveredDirtyTokens = new Set<string>()
    const dirtySessionId = crypto.randomUUID()
    let dirtyBoundary = 0
    let activeDirtyToken: string | undefined
    let destroyed = false
    let updatesSinceSnapshot = 0
    let bytesSinceSnapshot = 0
    let compactionTimer: ReturnType<typeof setTimeout> | undefined
    const compactionPolicy = {
        minUpdates: deps.compaction?.minUpdates ?? 32,
        minBytes: deps.compaction?.minBytes ?? 4 * 1024,
        idleMs: deps.compaction?.idleMs ?? 30_000,
    }
    /** The snapshot uploaded and not yet read back, with the exact state it encoded. */
    let pendingSnapshot: { generation: number; throughSeq: number; state: Y.Snapshot } | undefined
    /** A read-back failed: the next idle uploads a fresh snapshot whatever the tail size. */
    let snapshotRetryWanted = false

    function requestCatchup(afterSeq: number): void {
        if (!catchupActive) {
            // The first cycle owns the completion created with the engine, so callers may
            // safely start waiting before the socket opens. Every later resync receives a
            // fresh pending completion instead of reusing an already-resolved promise.
            if (catchupCompletion.settled) catchupCompletion = newSyncCompletion()
            catchupActive = true
        }
        send({
            type: 'catchup',
            requestId: newOutboxId(),
            docId,
            generation: documentGeneration,
            afterSeq,
            priority: deps.catchupPriority?.() ?? 'background',
            maxRows: SYNC_PROTOCOL_LIMITS.maxCatchupRows,
            maxBytes: SYNC_PROTOCOL_LIMITS.maxCatchupBytes,
        })
    }

    function completeCatchup(): void {
        firstCatchupPage.resolve()
        catchupActive = false
        catchupCompletion.resolve()
    }

    function failCatchup(error: unknown): Error {
        const reported = asError(error)
        firstCatchupPage.reject(reported)
        catchupActive = false
        catchupCompletion.reject(reported)
        return reported
    }

    const encrypt = (update: Uint8Array) =>
        sealSymmetric({
            key: currentEpoch(keyring).key,
            epochId: currentEpoch(keyring).epochId,
            plaintext: update,
            aad,
        })

    function stateSnapshot(): DocCacheState {
        return {
            update: Y.encodeStateAsUpdate(doc),
            lastSeq,
            lastSyncedStateVector,
            generation: documentGeneration,
            lifecycle: lifecycleState === 'deleted' ? 'deleted' : 'active',
        }
    }

    /**
     * Serialising cache work prevents an older background save from landing after an
     * acknowledgement transaction and regressing its watermark or state vector.
     */
    function persistTask<T>(work: () => Promise<T>): Promise<T> {
        const result = persistenceTail.then(work)
        persistenceTail = result.then(
            () => {
                lastPersistenceError = undefined
            },
            (error: unknown) => {
                lastPersistenceError = asError(error)
                // A write still in flight when the workspace was torn down rejects here, and
                // used to surface as a "could not save" notice over whatever opened next.
                if (!destroyed) deps.onError?.(lastPersistenceError)
            },
        )
        return result
    }

    function detached(work: Promise<unknown>): void {
        void work.catch((error: unknown) => {
            const reported = asError(error)
            if (!destroyed && reported !== lastPersistenceError) deps.onError?.(reported)
        })
    }

    function saveCurrent(options?: DocCacheSaveOptions): Promise<void> {
        const state = stateSnapshot()
        return persistTask(() => persist.save(state, options)).then(collectRowIfWanted)
    }

    /**
     * Collect the cache row after a persist that made the document read as wanted - chained
     * on the persistence tail, so it runs over the row that already holds the persisted state.
     * Once per stretch: a document that stops reading as wanted and later reads so again is
     * collected again.
     */
    let rowCollected = false
    function collectRowIfWanted(): Promise<void> {
        if (!deps.collectRowWhen) return Promise.resolve()
        if (!deps.collectRowWhen(doc)) {
            rowCollected = false
            return Promise.resolve()
        }
        if (rowCollected) return Promise.resolve()
        rowCollected = true
        return persistTask(() => persist.compact())
    }

    async function transmit(operation: DurableOutboxOperation): Promise<void> {
        await persistTask(() => persist.markAttempt(operation.outboxId, now()))
        if (operation.kind === 'delete') {
            send({
                type: 'delete',
                docId,
                outboxId: operation.outboxId,
                generation: operation.generation,
            })
            return
        }
        send({
            type: operation.kind,
            docId,
            outboxId: operation.outboxId,
            generation: operation.generation,
            epochId: operation.epochId,
            envelope: operation.envelope,
        })
    }

    async function drainCurrentDiff(): Promise<void> {
        await persistenceTail
        if (destroyed || durableQueue.length > 0) return
        // "Nothing to send" must be judged by SNAPSHOT equality (state vector + delete
        // set), never by the encoded diff's length: Yjs writes the document's ENTIRE
        // delete set into every state-vector difference, so a document with any deletion
        // history always produces a non-empty diff. With the ack handler draining again
        // after each acknowledgement, that byte-length test self-looped one client into
        // ~40 appends per second per document (live, 2026-07-30: three documents at
        // sequence 660,000+, every open degraded, the index churning in every tab).
        const currentSnapshot = Y.snapshot(doc)
        if (lastSyncedSnapshot && Y.equalSnapshots(currentSnapshot, lastSyncedSnapshot)) return
        const diff = Y.encodeStateAsUpdate(doc, lastSyncedStateVector)
        // Yjs encodes an empty state-vector difference as two bytes.
        if (diff.length <= 2) return
        // Capture the boundary synchronously with the diff. Encryption yields to the event
        // loop; a later keystroke must not be included in this operation's acknowledged
        // vector when it is absent from this operation's plaintext.
        const operationStateVector = Y.encodeStateVector(doc)
        const settledDirtyTokens = [...recoveredDirtyTokens]
        if (activeDirtyToken) settledDirtyTokens.push(activeDirtyToken)
        // Rotate before encryption yields. A local edit made while encryption is running
        // receives a new token and cannot be cleared by this older operation boundary.
        activeDirtyToken = undefined

        let operation: NewOutboxOperation
        try {
            const epoch = currentEpoch(keyring)
            const kind = lifecycleState === 'deleted' ? 'resurrect' : 'append'
            // Resurrection starts a fresh server generation, so it must be independently
            // materialisable. A state-vector difference can depend on structs deleted with
            // the old generation and would decode as an empty document on another client.
            const plaintext = kind === 'resurrect' ? Y.encodeStateAsUpdate(doc) : diff
            operation = {
                outboxId: newOutboxId(),
                kind,
                generation: documentGeneration,
                epochId: epoch.epochId,
                envelope: toBase64Url(await encrypt(plaintext)),
                stateVector: operationStateVector,
                createdAt: now(),
            }
            const state = stateSnapshot()
            await persistTask(() =>
                persist.enqueue(operation, state, { settledDirtyTokens }),
            )
            await collectRowIfWanted()
        } catch (error) {
            // The cache still carries these tokens. Retain them in memory too so a retry in
            // this session can settle the same durable boundaries without another edit.
            for (const token of settledDirtyTokens) recoveredDirtyTokens.add(token)
            throw error
        }
        for (const token of settledDirtyTokens) recoveredDirtyTokens.delete(token)
        boundarySnapshots.set(operation.outboxId, currentSnapshot)
        const durable: DurableOutboxOperation = {
            graphId,
            docId,
            ...operation,
            attemptCount: 0,
            lastAttemptAt: null,
        }
        durableQueue.push(durable)
        if (operation.kind === 'resurrect') lifecycleState = 'resurrecting'
        await transmit(durable)
    }

    function requestDrain(): Promise<void> {
        if (!drainPromise) {
            drainPromise = drainCurrentDiff().finally(() => {
                drainPromise = undefined
                deps.onIdle?.()
            })
        }
        return drainPromise
    }

    function scheduleDrain(): void {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
            debounceTimer = undefined
            detached(requestDrain())
        }, debounceMs)
    }

    /**
     * Whether the unsnapshotted tail is worth collapsing (ADR 0025, amended 2026-09-12).
     * Either the tail has reached the row floor - a cold load replays that many envelopes -
     * or the log holds at least `minBytes` more than the document's own encoded state, which
     * is what pruning behind a snapshot would actually free. Judged only when the idle timer
     * fires, because the state size is an O(document) encode. A failed read-back forces the
     * next attempt regardless.
     */
    function compactionDue(): boolean {
        if (snapshotRetryWanted) return true
        if (updatesSinceSnapshot === 0) return false
        if (updatesSinceSnapshot >= compactionPolicy.minUpdates) return true
        return bytesSinceSnapshot - Y.encodeStateAsUpdate(doc).byteLength >= compactionPolicy.minBytes
    }

    function scheduleAutomaticCompaction(): void {
        if (destroyed || (updatesSinceSnapshot === 0 && !snapshotRetryWanted)) return
        if (compactionTimer) clearTimeout(compactionTimer)
        compactionTimer = setTimeout(() => {
            compactionTimer = undefined
            if (!compactionDue()) return
            detached(
                uploadSnapshot().then((uploaded) => {
                    if (!uploaded) scheduleAutomaticCompaction()
                }),
            )
        }, compactionPolicy.idleMs)
    }

    const onUpdate = (_update: Uint8Array, origin: unknown) => {
        if (destroyed || seeding) return
        indexMutationVersion += 1
        if (lifecycleState === 'seeding' && origin !== REMOTE) localEditsBeforeSeed = true
        if (compactionTimer) {
            clearTimeout(compactionTimer)
            compactionTimer = undefined
        }
        // Persist local edits immediately, including edits made while an operation is in
        // flight. Relay handlers persist once after an update or whole catch-up page has
        // applied; saving here as well rewrites the complete merged document for every
        // envelope in that page.
        if (origin !== REMOTE) {
            const supersededDirtyToken = activeDirtyToken
            activeDirtyToken = `${dirtySessionId}:${++dirtyBoundary}`
            detached(
                saveCurrent({
                    dirtyToken: activeDirtyToken,
                    supersededDirtyToken,
                    indexContentChanged: true,
                }),
            )
        }
        if (origin !== REMOTE && origin !== SUPPRESSED) scheduleDrain()
    }
    doc.on('update', onUpdate)

    let suppressAutomaticAwareness = false

    async function sendAwareness(changed: number[]): Promise<void> {
        const update = encodeAwarenessUpdate(awareness, changed)
        const envelope = toBase64Url(
            await sealSymmetric({
                key: currentEpoch(keyring).key,
                epochId: currentEpoch(keyring).epochId,
                plaintext: update,
                aad: presenceAad,
            }),
        )
        send({ type: 'presence', docId, envelope })
    }

    const onAwareness = (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
    ) => {
        if (destroyed || origin === REMOTE || suppressAutomaticAwareness) return
        const changed = [...added, ...updated, ...removed]
        detached(sendAwareness(changed))
    }
    awareness.on('update', onAwareness)

    let skippedUpdates = 0

    async function applyEnvelope(envelope: string, seq: number, incomingGeneration = documentGeneration): Promise<boolean> {
        if (incomingGeneration !== documentGeneration) {
            if (
                lifecycleState === 'deleted' &&
                incomingGeneration === documentGeneration + 1 &&
                seq === 1
            ) {
                // A peer's explicit resurrection is broadcast as the complete first update
                // of the new generation.
                documentGeneration = incomingGeneration
                lifecycleState = 'active'
                lastSeq = 0
            } else {
                syncHealth = 'generation-stale'
                return false
            }
        }
        if (seq <= lastSeq) return true
        if (seq !== lastSeq + 1) {
            syncHealth = 'sequence-gap'
            if (futureUpdates.size < 256) {
                futureUpdates.set(seq, { envelope, generation: incomingGeneration })
            }
            requestCatchup(lastSeq)
            return false
        }
        try {
            const bytes = fromBase64Url(envelope)
            const epochId = envelopeEpochId(bytes)
            if (!keyForEpoch(keyring, epochId)) {
                syncHealth = 'key-unavailable'
                return false
            }
            const { plaintext } = await openSymmetric({
                keyForEpoch: (id) => keyForEpoch(keyring, id),
                envelope: bytes,
                aad,
            })
            Y.applyUpdate(doc, plaintext, REMOTE)
            // A relay update is server-confirmed state. Retain it in the baseline even when
            // a local operation is in flight, otherwise its later acknowledgement replaces
            // this knowledge and requestDrain() relays the peer's update back as a new append.
            lastSyncedStateVector = mergeStateVectors(
                lastSyncedStateVector,
                Y.encodeStateVectorFromUpdate(plaintext),
            )
            // With no local work in any stage (queued, draining, or debounced), the doc is
            // exactly baseline-plus-relay-updates: all relay-known, delete sets included.
            if (durableQueue.length === 0 && !debounceTimer && !drainPromise) {
                lastSyncedSnapshot = Y.snapshot(doc)
            }
        } catch (error) {
            syncHealth = 'ciphertext-corrupt'
            skippedUpdates += 1
            if (skippedUpdates <= 3 || skippedUpdates % 50 === 0) {
                console.warn(`[sync] update seq ${seq} for doc ${docId} skipped (${skippedUpdates} so far):`, error)
            }
            return false
        }
        if (seq > lastSeq) lastSeq = seq
        updatesSinceSnapshot += 1
        bytesSinceSnapshot += fromBase64Url(envelope).byteLength
        scheduleAutomaticCompaction()
        syncHealth = 'healthy'
        const next = futureUpdates.get(lastSeq + 1)
        if (next) {
            futureUpdates.delete(lastSeq + 1)
            await applyEnvelope(next.envelope, lastSeq + 1, next.generation)
        }
        return true
    }

    async function uploadSnapshot(): Promise<boolean> {
        if (
            lastSeq === 0 ||
            durableQueue.length > 0 ||
            syncHealth !== 'healthy' ||
            lifecycleState !== 'active'
        ) {
            return false
        }
        // Capture the encoded state and its Y.Snapshot together, before encryption yields:
        // the read-back is compared against exactly what was encoded, not against whatever
        // the document holds by the time the relay answers.
        const consolidated = Y.encodeStateAsUpdate(doc)
        const captured = Y.snapshot(doc)
        const throughSeq = lastSeq
        const snapshotGeneration = documentGeneration
        const epochId = currentEpoch(keyring).epochId
        const envelope = toBase64Url(await encrypt(consolidated))
        if (destroyed) return false
        pendingSnapshot = { generation: snapshotGeneration, throughSeq, state: captured }
        snapshotRetryWanted = false
        send({
            type: 'snapshot_put',
            docId,
            generation: snapshotGeneration,
            throughSeq,
            epochId,
            envelope,
        })
        updatesSinceSnapshot = 0
        bytesSinceSnapshot = 0
        return true
    }

    /**
     * The relay stored the snapshot. Read it straight back: the blind server cannot check a
     * snapshot, so the client that produced it proves the stored bytes decode to the state
     * it captured, and only then may the server prune behind it (ADR 0025, amended
     * 2026-09-12). Anything naming a snapshot other than the one in flight is ignored.
     */
    function onSnapshotAck(message: { generation: number; throughSeq: number }): void {
        const pending = pendingSnapshot
        if (!pending || pending.generation !== message.generation || pending.throughSeq !== message.throughSeq) return
        send({ type: 'snapshot_get', docId, generation: pending.generation, throughSeq: pending.throughSeq })
    }

    async function onSnapshotData(message: { generation: number; throughSeq: number; envelope: string }): Promise<void> {
        const pending = pendingSnapshot
        if (!pending || pending.generation !== message.generation || pending.throughSeq !== message.throughSeq) return
        pendingSnapshot = undefined
        let verified = false
        const scratch = new Y.Doc()
        try {
            const { plaintext } = await openSymmetric({
                keyForEpoch: (id) => keyForEpoch(keyring, id),
                envelope: fromBase64Url(message.envelope),
                aad,
            })
            Y.applyUpdate(scratch, plaintext)
            // State vector AND delete set, the same equality the drain uses: a snapshot that
            // dropped a deletion would still match on state vector alone.
            verified = Y.equalSnapshots(Y.snapshot(scratch), pending.state)
        } catch {
            verified = false
        } finally {
            scratch.destroy()
        }
        if (destroyed) return
        if (!verified) {
            // The relay keeps the log, so nothing is lost; a fresh snapshot goes up at the
            // next idle and gets its own read-back.
            console.warn(`[sync] snapshot ${pending.throughSeq} for doc ${docId} did not read back as stored; left unverified`)
            snapshotRetryWanted = true
            scheduleAutomaticCompaction()
            return
        }
        send({ type: 'snapshot_verified', docId, generation: pending.generation, throughSeq: pending.throughSeq })
    }

    return {
        doc,
        awareness,
        async receivePresence(envelope: string) {
            try {
                const { plaintext } = await openSymmetric({
                    keyForEpoch: (id) => keyForEpoch(keyring, id),
                    envelope: fromBase64Url(envelope),
                    aad: presenceAad,
                })
                applyAwarenessUpdate(awareness, plaintext, REMOTE)
            } catch {
                // Presence is ephemeral. An unknown epoch is safely ignored.
            }
        },
        async compact() {
            await uploadSnapshot()
        },
        async ready() {
            const [cached, pending] = await Promise.all([persist.load(), persist.pending()])
            seeding = true
            try {
                if (cached) {
                    Y.applyUpdate(doc, cached.update, CACHE_SEED)
                    lastSeq = cached.lastSeq
                    lastSyncedStateVector = cached.lastSyncedStateVector
                    documentGeneration = cached.generation ?? generation
                    lifecycleState = cached.lifecycle ?? 'active'
                    for (const token of cached.dirtyTokens ?? []) recoveredDirtyTokens.add(token)
                }
                durableQueue = pending.sort(
                    (a, b) => a.createdAt - b.createdAt || a.outboxId.localeCompare(b.outboxId),
                )
            } finally {
                seeding = false
            }
            // A cached document can be ahead of a replayed outbox operation. For example,
            // an edit made while the first operation is in flight is saved immediately but
            // cannot enter the outbox until that operation is acknowledged. Treating the
            // whole cached document as relay-known after restart would silently strand that
            // later edit. Without a session-local operation boundary, leave the snapshot
            // unknown: the acknowledged state vector will still suppress known structs, and
            // at worst a deletion set is sent once more before the new boundary is captured.
            const hasPendingContent = durableQueue.some((operation) => operation.kind !== 'delete')
            if (hasPendingContent || recoveredDirtyTokens.size > 0) {
                lastSyncedSnapshot = undefined
            } else if (localEditsBeforeSeed) {
                // A local edit can also land while the cache read is in flight. Rebuild the
                // baseline from cached bytes so that live-only work remains drainable.
                const baseline = new Y.Doc()
                if (cached) Y.applyUpdate(baseline, cached.update)
                lastSyncedSnapshot = Y.snapshot(baseline)
                baseline.destroy()
            } else {
                lastSyncedSnapshot = Y.snapshot(doc)
            }
            if (lifecycleState === 'seeding') lifecycleState = 'active'
        },
        async receive(message) {
            switch (message.type) {
                case 'ack': {
                    const operation = durableQueue[0]
                    if (!operation || operation.outboxId !== message.outboxId) return
                    let committed: boolean
                    if (operation.kind === 'delete') {
                        committed = await persistTask(() =>
                            persist.commitDeleteAcknowledgement(message.outboxId, message.generation),
                        )
                    } else {
                        // An ack proves that this local operation occupies `message.seq`; it
                        // does not prove that this tab has applied every earlier relay update.
                        // Only move the catch-up watermark when the ack is the next contiguous
                        // sequence. Otherwise catch up from the last sequence actually known.
                        const acknowledgedSeq =
                            message.seq === lastSeq + 1 ? message.seq : lastSeq
                        const acknowledgedStateVector = mergeStateVectors(
                            lastSyncedStateVector,
                            operation.stateVector,
                        )
                        committed = await persistTask(() =>
                            persist.commitAcknowledgement(
                                message.outboxId,
                                message.generation,
                                acknowledgedSeq,
                                Y.encodeStateAsUpdate(doc),
                                acknowledgedStateVector,
                            ),
                        )
                    }
                    if (!committed) return
                    documentGeneration = message.generation
                    // The relay now holds everything this operation's diff represented,
                    // including its delete set. A replayed outbox operation has no captured
                    // boundary; leaving the last snapshot unchanged is conservative and
                    // costs at most one redundant, idempotent append.
                    const boundary = boundarySnapshots.get(message.outboxId)
                    boundarySnapshots.delete(message.outboxId)
                    if (boundary && operation.kind !== 'delete') lastSyncedSnapshot = boundary
                    if (operation.kind === 'delete') {
                        lastSeq = 0
                        lastSyncedStateVector = Y.encodeStateVector(new Y.Doc())
                        lifecycleState = 'deleted'
                    } else {
                        if (message.seq === lastSeq + 1) {
                            lastSeq = message.seq
                        } else if (message.seq > lastSeq + 1) {
                            syncHealth = 'sequence-gap'
                            requestCatchup(lastSeq)
                        }
                        lastSyncedStateVector = mergeStateVectors(
                            lastSyncedStateVector,
                            operation.stateVector,
                        )
                        lifecycleState = 'active'
                        updatesSinceSnapshot += 1
                        bytesSinceSnapshot += fromBase64Url(operation.envelope).byteLength
                        scheduleAutomaticCompaction()
                    }
                    durableQueue.shift()
                    send({ type: 'ack_confirm', outboxId: message.outboxId })
                    if (durableQueue[0]) await transmit(durableQueue[0])
                    else if (operation.kind !== 'delete') await requestDrain()
                    break
                }
                case 'update': {
                    const beforeUpdate = indexMutationVersion
                    if (
                        await applyEnvelope(
                            message.envelope,
                            message.seq,
                            message.generation,
                        )
                    ) {
                        await saveCurrent({
                            indexContentChanged: indexMutationVersion !== beforeUpdate,
                        })
                    }
                    break
                }
                case 'catchup_batch': {
                    try {
                        const beforeBatch = indexMutationVersion
                        if (message.generation < documentGeneration) break
                        if (message.state === 'deleted') {
                            documentGeneration = message.generation
                            lifecycleState = 'deleted'
                            lastSeq = 0
                            seeding = true
                            try {
                                const content = doc.getText('content')
                                if (content.length > 0) {
                                    doc.transact(() => content.delete(0, content.length), SUPPRESSED)
                                }
                            } finally {
                                seeding = false
                            }
                            await persist.purge()
                            durableQueue = []
                            boundarySnapshots.clear()
                            recoveredDirtyTokens.clear()
                            activeDirtyToken = undefined
                            // The relay declared this generation deleted; the emptied document
                            // is the shared baseline. Without this, the delete-set left by the
                            // content clear reads as unsent local work and a reconnect drain
                            // would resurrect the document.
                            lastSyncedSnapshot = Y.snapshot(doc)
                            futureUpdates.clear()
                            completeCatchup()
                            break
                        }
                        documentGeneration = message.generation
                        lifecycleState = 'active'
                        if (message.snapshot) {
                            // A snapshot establishes its own contiguous watermark, and it
                            // covers everything before it: an update held for a gap the
                            // snapshot has closed is stale, and the tail counters start again.
                            lastSeq = message.snapshot.throughSeq - 1
                            for (const seq of [...futureUpdates.keys()]) {
                                if (seq <= message.snapshot.throughSeq) futureUpdates.delete(seq)
                            }
                            await applyEnvelope(message.snapshot.envelope, message.snapshot.throughSeq)
                            updatesSinceSnapshot = 0
                            bytesSinceSnapshot = 0
                        }
                        for (const update of message.updates) {
                            await applyEnvelope(update.envelope, update.seq)
                        }
                        await saveCurrent({
                            indexContentChanged: indexMutationVersion !== beforeBatch,
                        })
                        if (message.hasMore) {
                            firstCatchupPage.resolve()
                            requestCatchup(lastSeq)
                        } else {
                            completeCatchup()
                        }
                    } catch (error) {
                        throw failCatchup(error)
                    }
                    break
                }
                case 'snapshot_ack':
                    onSnapshotAck(message)
                    break
                case 'snapshot_data':
                    await onSnapshotData(message)
                    break
                default:
                    break
            }
        },
        firstCatchupPage: () => firstCatchupPage.promise,
        caughtUp: () => catchupCompletion.promise,
        resync() {
            requestCatchup(lastSeq)
            if (durableQueue[0]) detached(transmit(durableQueue[0]))
            else detached(requestDrain())
        },
        async flush() {
            if (debounceTimer) {
                clearTimeout(debounceTimer)
                debounceTimer = undefined
            }
            await persistenceTail
            await requestDrain()
            if (lastPersistenceError) throw lastPersistenceError
        },
        async delete() {
            if (lifecycleState === 'deleted' || lifecycleState === 'deleting') return
            await persistenceTail
            lifecycleState = 'deleting'
            if (debounceTimer) clearTimeout(debounceTimer)
            const content = doc.getText('content')
            seeding = true
            try {
                if (content.length > 0) doc.transact(() => content.delete(0, content.length), SUPPRESSED)
            } finally {
                seeding = false
            }
            for (const operation of durableQueue.splice(0)) await persist.discard(operation.outboxId)
            boundarySnapshots.clear()
            // The cleared document is the baseline while the delete settles; only a real
            // edit (resurrection) should ever drain from here.
            lastSyncedSnapshot = Y.snapshot(doc)
            const operation: NewDeleteOperation = {
                outboxId: newOutboxId(),
                kind: 'delete',
                generation: documentGeneration,
                createdAt: now(),
            }
            const settledDirtyTokens = [...recoveredDirtyTokens]
            if (activeDirtyToken) settledDirtyTokens.push(activeDirtyToken)
            activeDirtyToken = undefined
            try {
                await persistTask(() =>
                    persist.enqueue(operation, stateSnapshot(), { settledDirtyTokens }),
                )
            } catch (error) {
                for (const token of settledDirtyTokens) recoveredDirtyTokens.add(token)
                throw error
            }
            for (const token of settledDirtyTokens) recoveredDirtyTokens.delete(token)
            durableQueue.push({
                graphId,
                docId,
                ...operation,
                attemptCount: 0,
                lastAttemptAt: null,
            })
            await transmit(durableQueue[0])
        },
        lifecycle: () => lifecycleState,
        health: () => syncHealth,
        async staleGeneration(currentGeneration) {
            syncHealth = 'generation-stale'
            for (const operation of durableQueue.splice(0)) await persist.discard(operation.outboxId)
            boundarySnapshots.clear()
            documentGeneration = currentGeneration
            lastSeq = 0
            requestCatchup(0)
        },
        async advertisePresence() {
            if (destroyed || awareness.getLocalState() === null) return
            await sendAwareness([doc.clientID])
        },
        async clearPresence() {
            if (destroyed || awareness.getLocalState() === null) return
            suppressAutomaticAwareness = true
            try {
                awareness.setLocalState(null)
            } finally {
                suppressAutomaticAwareness = false
            }
            await sendAwareness([doc.clientID])
        },
        isIdle: () => durableQueue.length === 0 && !debounceTimer && !drainPromise,
        destroy() {
            destroyed = true
            boundarySnapshots.clear()
            // A background persisted-index catch-up may be waiting while the browser is
            // offline. Ending the engine also ends that wait, so workspace disposal cannot
            // retain a detached graph session indefinitely.
            firstCatchupPage.resolve()
            completeCatchup()
            if (debounceTimer) clearTimeout(debounceTimer)
            if (compactionTimer) clearTimeout(compactionTimer)
            doc.off('update', onUpdate)
            awareness.off('update', onAwareness)
            removeAwarenessStates(awareness, [doc.clientID], REMOTE)
            awareness.destroy()
            doc.destroy()
        },
    }
}
