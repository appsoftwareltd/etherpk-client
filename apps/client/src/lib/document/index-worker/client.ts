/**
 * The tab's half of the [[Derived Index]] (ADR 0041).
 *
 * It owns everything that needs the documents — which change, when to coalesce, and pulling
 * their text out of the store — because the worker cannot read them. It owns nothing about
 * SQL.
 *
 * The two reads the editor makes constantly (`conceptExists` on every keystroke for
 * missing-link styling, `allConcepts` for wikilink completion and Quick Find) are answered
 * from the snapshot the worker pushes after each ingest, so they stay synchronous and never
 * cross a message boundary. `backlinks` is a real round trip; its two callers tolerate it.
 */

import type {
    AssetUsage,
    ConceptCandidate,
    DbBacklinkGroup,
    IndexDoc,
    SearchDocumentGroup,
    TaskHit,
    TaskQuery,
} from '../index-db'
import type { EmbeddingRow, PendingPassage, SemanticDocumentGroup, SemanticStatus } from '../semantic/embedding-db'
import { conceptKey } from '../backlinks/backlink-index'
import type {
    IndexChangeCheckpoint,
    IndexSource,
    IndexProgress,
    StoreChange,
} from '../backlinks/live-index'
import { INDEX_DISCARDED_PREFIX } from './core'
import type { IndexRequest, IndexResponse } from './protocol'
import { performanceRecorder } from '$lib/diagnostics/performance'

/**
 * Dirty documents above which replacing the whole index is cheaper than re-indexing each.
 * Bulk import and external reconciliation can report hundreds of named changes together.
 */
const INCREMENTAL_LIMIT = 200

/** Documents per rebuild postMessage — bounds each structured clone to a few hundred KB. */
const REBUILD_SEND_CHUNK = 150

/** One cold full derivation per graph across every tab in this browser profile. */
const REBUILD_LOCK_PREFIX = 'etherpk-index-rebuild:'

/** One persisted-history reconciliation per graph across every tab in this browser profile. */
const CATCH_UP_LOCK_PREFIX = 'etherpk-index-catch-up:'

/** A connection to an index server, wherever it runs. */
export interface IndexTransport {
    send(request: IndexRequest): void
    onMessage(listener: (response: IndexResponse) => void): void
    close(): void
}

/**
 * The transport could not get an index `open` accepted or completed. The workspace may retry
 * this specific failure inline; source/rebuild failures are deliberately not this type, because
 * repeating the same graph walk on the main thread only duplicates work and hides the real error.
 */
export class IndexTransportOpenError extends Error {
    override name = 'IndexTransportOpenError'
}

export interface RemoteGraphIndex {
    /** Synchronous — from the pushed snapshot; safe on every keystroke. */
    conceptExists(concept: string): boolean
    /** Synchronous — likewise pushed, never a query. */
    allConcepts(): readonly ConceptCandidate[]
    /**
     * One concept's candidate row, by name or alias - the flags a listing wears (`protected`,
     * `includeOf`) without opening anything. Synchronous and O(1), so a tab renderer can ask
     * on every repaint; undefined for a name the index does not know.
     */
    candidate(concept: string): ConceptCandidate | undefined
    /** A round trip to the index server. */
    backlinks(concept: string): Promise<DbBacklinkGroup[]>
    /**
     * [[Search]]'s text group: one page of matching documents. A round trip, like
     * `backlinks` — which is exactly why Search runs it separately from the name group,
     * whose answers come from the synchronous snapshot above and always land first.
     */
    searchText(query: string, offset: number, limit: number): Promise<SearchTextResult>
    /** How many documents match, capped. Issued in parallel; never blocks the rows. */
    searchTextCount(query: string): Promise<SearchCountResult>
    /**
     * Which documents reference an [[Asset]], and how many times. A round trip, issued once
     * when the user asks to delete one — never speculatively. See ADR 0054 for why the count
     * comes from here rather than from a walk of every document.
     */
    assetUsage(needles: readonly string[]): Promise<AssetUsage>
    /**
     * One page of the [[Tasks View]]'s list, with its total. A round trip like `backlinks` —
     * the Tasks View re-issues it when a filter changes or the index updates, never per
     * keystroke: the Name Filter's typeahead reads the synchronous `allConcepts` snapshot.
     */
    tasks(query: TaskQuery, offset: number, limit: number): Promise<TaskPageResult>
    /**
     * [[Semantic Search]]'s store and scan, as round trips (ADR 0076). The index holds vectors
     * and answers nearest-passage queries; it knows no model, so the caller embeds. A
     * `SemanticIndex` (semantic/semantic-index.ts) is the thing to use; this is what it uses.
     */
    semantic: SemanticIndexPort
    /**
     * Start the transport/worker open without reading the source. `refresh()` consumes this
     * prepared result, so store hydration and a delayed cross-tab attachment can overlap.
     * Failures remain attached to the prepared result and surface from `refresh()`.
     */
    prepare(): Promise<void>
    /**
     * Open on a persisted generation immediately, then let the source catch up genuine
     * changes in the background. A cold index dispatches a staged full stream before it
     * has results to show.
     */
    refresh(): Promise<void>
    /**
     * Discard and re-derive the whole index from the source, on request. The one thing a
     * user can do when they doubt it: the index is never authoritative and always
     * rebuildable (CONTEXT.md → Derived Index), and until this there was no way to invoke that
     * rule short of clearing site data. Streams through a staged generation and swaps at the
     * end, so queries keep answering from the old one meanwhile; resolves once the swap has
     * been confirmed and the snapshot pushed. A rebuild already in flight is awaited, not
     * doubled.
     */
    rebuild(): Promise<void>
    onUpdated(listener: (update: IndexUpdate) => void): () => void
    /**
     * Resolves once every source change observed so far has been through the ingest pipeline -
     * the debounce fired and the rebuild it queued finished - whether or not it changed the
     * index. `onUpdated` cannot say this: an ingest of a document whose indexed text is unchanged
     * (a frontmatter-only edit on a synced graph, an edit typed and reverted) emits nothing, so
     * a caller waiting for an update would wait out its bound every time.
     */
    settled?(): Promise<void>
    /** True when this index survives a reload; false means it was rebuilt from scratch. */
    isPersisted(): boolean
    /**
     * Why persistence is unavailable, when known: 'held' means another live context (typically
     * a stale window) holds this graph's pool, which the user can act on; 'unsupported' means
     * this environment cannot persist at all.
     */
    persistenceBlocked(): 'held' | 'unsupported' | undefined
    /** Observe failover between a temporary and persisted worker after the initial open. */
    onPersistenceChanged(listener: (status: IndexPersistenceStatus) => void): () => void
    /**
     * True while the INITIAL build is still deriving the graph (cold open, nothing
     * persisted). Consumers with an empty snapshot can say "loading" instead of showing
     * nothing — the wikilink completion's empty popover read as a hang (live, 2026-07-29).
     */
    isBuilding(): boolean
    dispose(): void
}

export interface SearchTextResult {
    groups: SearchDocumentGroup[]
    hasMore: boolean
}

export interface SearchCountResult {
    total: number
    /** True when there are more matches than were counted — rendered as `1000+`. */
    capped: boolean
}

export interface TaskPageResult {
    hits: TaskHit[]
    hasMore: boolean
    /** Every match, not just this page — uncapped, so the header can say "1–100 of 412". */
    total: number
}

/** The index's side of [[Semantic Search]]: vectors in, nearest passages out. */
export interface SemanticIndexPort {
    status(model: string): Promise<SemanticStatus>
    pending(model: string, limit: number): Promise<PendingPassage[]>
    put(model: string, dims: number, rows: readonly EmbeddingRow[]): Promise<number>
    search(model: string, vector: Float32Array, offset: number, limit: number, floor: number): Promise<SemanticSearchResult>
    sweep(model: string): Promise<number>
}

export interface SemanticSearchResult {
    groups: SemanticDocumentGroup[]
    hasMore: boolean
    /** The store's state at the time of the answer, so a partial answer can say so. */
    status: SemanticStatus
}

export interface IndexPersistenceStatus {
    persisted: boolean
    blocked?: 'held' | 'unsupported'
}

export interface IndexUpdate {
    full: boolean
    changedConceptKeys: ReadonlySet<string>
    backlinkTargetsChanged: ReadonlySet<string>
}

export interface RemoteIndexOptions {
    graphId: string
    debounceMs?: number
    /**
     * How long `refresh()` waits for the worker's first answer before giving up. Generous by
     * default — the first answer includes fetching ~900KB of sqlite wasm — but finite, so a
     * worker that cannot start rejects the open instead of hanging it; the caller then falls
     * back to the inline index (ADR 0041: fail closed).
     */
    openTimeoutMs?: number
    /**
     * Idle patience after a ferried port proves the owner worker adopted it, but before the
     * replayed open reaches that worker. Chromium can split those deliveries across long
     * owner-page scheduling gaps. Defaults to 60 seconds.
     */
    adoptedOpenTimeoutMs?: number
    onProgress?: (progress: IndexProgress) => void
    /** A warm-index catch-up failure must be visible without failing the interactive open. */
    onBackgroundError?: (error: Error) => void
}

export function createRemoteGraphIndex(
    source: IndexSource,
    transport: IndexTransport,
    options: RemoteIndexOptions,
): RemoteGraphIndex {
    const debounceMs = options.debounceMs ?? 300
    let existing = new Set<string>()
    let candidates = new Map<string, ConceptCandidate>()
    let revision = 0
    let persisted = false
    let persistenceBlocked: 'held' | 'unsupported' | undefined
    let persistenceKnown = false
    const persistenceChanged = new Set<(status: IndexPersistenceStatus) => void>()
    /**
     * Armed by the shared transport's `transport-changed` marker and cleared by the next
     * honoured open answer. The fresh-empty-worker recovery below fires only while armed,
     * so duplicate open answers, including the compatibility nudge each ferry candidate carries,
     * can never masquerade as a worker replacement (live, 2026-07-31: every such duplicate
     * scheduled another full derivation during bring-up).
     */
    let workerReplaced = false
    /** Set while refresh()'s initial full derivation runs; cleared by its snapshot. */
    let building = false
    const updated = new Set<(update: IndexUpdate) => void>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let rebuildTail = Promise.resolve()
    /** Woken after each rebuild on the tail completes, for `settled()` to look again. */
    let drainWaiters: Array<() => void> = []
    /** Source events accumulate immediately, but cannot mutate a worker before open completes. */
    let backgroundRebuildsEnabled = false
    let disposed = false
    let activeRebuildId: string | undefined
    let activeRebuildCompletion:
        | {
              promise: Promise<void>
              resolve: () => void
              reject: (error: Error) => void
          }
        | undefined
    let rebuildInvalidated = false
    /** A concurrent worker ingest is not represented in our source-side dirty set. */
    let rebuildRequiresFullRetry = false
    /** A cold generation must exist before its source begins shared history hydration. */
    let coldCatchUpPending = false

    /** Concepts whose content changed, or `null` for "the document set moved — replace all". */
    let dirty: Set<string> | null = new Set()

    let nextId = 1
    let nextOpenId = 1
    const pending = new Map<number, (response: IndexResponse) => void>()
    let onOpened: ((response: Extract<IndexResponse, { type: 'opened' }>) => void) | undefined
    let onOpenAttached: (() => void) | undefined
    /** Stops open-startup patience once the worker confirms that it accepted the request. */
    let onOpenAccepted: ((openId: number) => void) | undefined
    /** A replay onto a replacement worker needs a fresh startup-patience window. */
    let onOpenTransportChanged: (() => void) | undefined
    let awaitedOpenId: number | undefined
    let onOpenFailed: ((error: Error) => void) | undefined
    const rebuildLockAbort = new AbortController()
    /** Any inbound worker message counts as life; see openIndex's activity-based patience. */
    let lastTransportActivity = performance.now()
    let transportGeneration = 0
    type OpenedResponse = Extract<IndexResponse, { type: 'opened' }>
    interface PreparedOpen {
        openId: number
        generation: number
        settled: boolean
        promise: Promise<OpenedResponse>
    }
    let preparedOpen: PreparedOpen | undefined

    transport.onMessage((response) => {
        lastTransportActivity = performance.now()
        switch (response.type) {
            case 'snapshot': {
                // Snapshots pushed after the initial rebuild started mean it has content
                // to show (the empty pre-rebuild snapshot arrives WITH 'opened', before
                // `building` is ever set).
                if (!building || response.rebuildId) building = false
                revision = response.revision
                // A full replacement can remove real concepts and pageless candidates.
                // Include both generations so an open editor restyles links which changed
                // from existing to missing, or disappeared from completion entirely.
                const changedConceptKeys = new Set([
                    ...existing,
                    ...candidates.keys(),
                    ...response.existing,
                    ...response.candidates.map((candidate) => candidate.key),
                ])
                existing = new Set(response.existing)
                candidates = new Map(response.candidates.map((candidate) => [candidate.key, candidate]))
                for (const listener of updated) {
                    listener({
                        full: true,
                        changedConceptKeys,
                        backlinkTargetsChanged: new Set(),
                    })
                }
                if (response.rebuildId && activeRebuildId) {
                    // A different id means another tab superseded our stream and committed
                    // an authoritative full generation. Either way, our stream no longer
                    // owns the pending rebuild.
                    const shouldRetry = rebuildInvalidated
                    const completion = activeRebuildCompletion
                    if (rebuildRequiresFullRetry) dirty = null
                    activeRebuildId = undefined
                    activeRebuildCompletion = undefined
                    rebuildInvalidated = false
                    rebuildRequiresFullRetry = false
                    completion?.resolve()
                    // A cold generation is only the cache snapshot. Even when a foreground
                    // relay update invalidated it while streaming, post-commit catch-up is
                    // the one authoritative retry path. Scheduling another full derivation
                    // here duplicated the entire graph before reconciliation had even begun.
                    if (coldCatchUpPending && !disposed) {
                        coldCatchUpPending = false
                        catchUpWarmIndex({ verifyExternalSource: false })
                    } else if (shouldRetry && !disposed) {
                        queueRebuild()
                    }
                }
                return
            }
            case 'delta': {
                if (response.revision !== revision + 1) {
                    transport.send({ type: 'snapshot-request' })
                    return
                }
                revision = response.revision
                if (activeRebuildId) {
                    // Another attached tab changed the worker's visible generation while our
                    // staged replacement was being built. The staged commit would overwrite
                    // that delta, and its source concept is not necessarily known in this tab.
                    rebuildInvalidated = true
                    rebuildRequiresFullRetry = true
                }
                for (const key of response.existingAdded) existing.add(key)
                for (const key of response.existingRemoved) existing.delete(key)
                for (const candidate of response.candidateUpserts) {
                    candidates.set(candidate.key, candidate)
                }
                for (const key of response.candidateRemoved) candidates.delete(key)
                const changedConceptKeys = new Set([
                    ...response.existingAdded,
                    ...response.existingRemoved,
                ])
                const update: IndexUpdate = {
                    full: false,
                    changedConceptKeys,
                    backlinkTargetsChanged: new Set(response.backlinkTargetsChanged),
                }
                performanceRecorder.mark('index.delta.received', {
                    bytes: new TextEncoder().encode(JSON.stringify(response)).byteLength,
                    changed: changedConceptKeys.size,
                })
                for (const listener of updated) listener(update)
                return
            }
            case 'progress':
                options.onProgress?.({ phase: 'indexing', done: response.done, total: response.total })
                return
            case 'attached':
                // The owner's worker has adopted the ferried port. Chromium can still defer
                // the replayed inbound open until a later owner-page scheduling gap, so move
                // from the short "worker never started" budget to adoption patience.
                onOpenAttached?.()
                return
            case 'open-accepted':
                // This is stronger than a generic liveness pulse: the open has reached the
                // worker and is now ordered behind any existing core work. A storm-history
                // catch-up can keep that queue busy for minutes, but abandoning it for an
                // inline rebuild would duplicate the whole graph and lose persistence.
                onOpenAccepted?.(response.openId)
                return
            case 'transport-changed':
                workerReplaced = true
                transportGeneration += 1
                if (preparedOpen) {
                    if (preparedOpen.settled) {
                        // The sharing facade replays its latest correlated open immediately
                        // after this marker. Start waiting before that synchronous replay is
                        // sent, rather than issuing a duplicate open from refresh later.
                        preparedOpen = createPreparedOpen({
                            openId: preparedOpen.openId,
                            send: false,
                        })
                    } else {
                        // The same in-flight request is replayed. Move its result onto the new
                        // generation and restore the timer which open-accepted may have stopped
                        // for the worker that just disappeared.
                        preparedOpen.generation = transportGeneration
                        onOpenTransportChanged?.()
                    }
                } else {
                    // Cold refresh re-opens directly while holding the rebuild lock rather
                    // than through the preparation cache. Its replay needs the same renewed
                    // failure detection.
                    onOpenTransportChanged?.()
                }
                return
            case 'opened': {
                // Compatibility ferrying can replay opens. Never let a late answer for an
                // older correlated request settle the open currently awaited by this tab.
                if (
                    onOpened &&
                    response.openId !== undefined &&
                    response.openId !== awaitedOpenId
                ) {
                    return
                }
                const persistenceDidChange =
                    !persistenceKnown ||
                    persisted !== response.persisted ||
                    persistenceBlocked !== response.persistenceBlocked
                persisted = response.persisted
                persistenceBlocked = response.persistenceBlocked
                persistenceKnown = true
                if (persistenceDidChange) {
                    const status = {
                        persisted,
                        ...(persistenceBlocked ? { blocked: persistenceBlocked } : {}),
                    }
                    for (const listener of persistenceChanged) listener(status)
                }
                if (onOpened) {
                    workerReplaced = false
                    onOpened(response)
                } else if (!workerReplaced) {
                    // A duplicate answer from the ferry's compatibility nudge, not a
                    // replacement. Ignoring it is the whole point of the marker.
                } else if (response.indexedDocuments === 0) {
                    // Unsolicited after a real swap, and empty: the shared transport moved
                    // onto a fresh worker (owner failover, reclaiming a dead holder's pool,
                    // or giving up on an unreachable owner, ADR 0042 §4) whose database
                    // holds nothing. Its snapshot has just wiped this tab's concept caches;
                    // without a rebuild every wikilink would style as missing from here on
                    // (live, 2026-07-28).
                    workerReplaced = false
                    if (building) {
                        // A cold caller has no usable generation and must fall back rather
                        // than publish the empty caches from the replacement worker.
                        failActiveRebuild(new Error('the index worker was replaced during rebuild'))
                    } else {
                        // A detached rebuild is opportunistic. Cancel its superseded stream
                        // quietly and let the replacement worker's scheduled rebuild take over.
                        cancelActiveRebuild()
                    }
                    rebuildInvalidated = false
                    rebuildRequiresFullRetry = false
                    scheduleRebuild()
                } else {
                    // Unsolicited after a real swap, with content: the replacement pool is
                    // adopted as-is, exactly as before the swap markers existed. Known gap,
                    // deliberately unchanged here: a takeover of a pool whose last commit
                    // predates recent edits serves that older state until the next edit or
                    // full refresh reconciles it.
                    workerReplaced = false
                }
                return
            }
            default: {
                const id = 'id' in response ? response.id : undefined
                if (id !== undefined) {
                    pending.get(id)?.(response)
                    pending.delete(id)
                    return
                }
                // An error with no request id is the worker itself failing (its script or
                // wasm would not load). If an open is in flight, it must reject, not hang.
                if (response.type === 'error') {
                    if (
                        onOpenFailed &&
                        response.openId !== undefined &&
                        response.openId !== awaitedOpenId
                    ) {
                        return
                    }
                    // A rebuild stream's chunks and commit are fire-and-forget, so its
                    // failures can arrive after the stream has already been failed and a
                    // replacement started — a wrecked index does exactly this: the discard
                    // fails the stream, then the commit it had already posted reports
                    // 'rebuild not begun'. Those must not fail the replacement.
                    if (response.rebuildId !== undefined && response.rebuildId !== activeRebuildId) return
                    const error = new Error(response.message)
                    onOpenFailed?.(error)
                    failActiveRebuild(error)
                    recoverIfDiscarded(error)
                }
            }
        }
    })

    function newRebuildCompletion() {
        let resolve!: () => void
        let reject!: (error: Error) => void
        const promise = new Promise<void>((onResolve, onReject) => {
            resolve = onResolve
            reject = onReject
        })
        // Detached rebuilds keep their rejection handled here as well as at the caller so
        // disposing or replacing a worker cannot produce an unhandled rejection between
        // those two turns of the microtask queue.
        void promise.catch(() => {})
        return { promise, resolve, reject }
    }

    function failActiveRebuild(error: Error): void {
        const completion = activeRebuildCompletion
        activeRebuildId = undefined
        activeRebuildCompletion = undefined
        building = false
        completion?.reject(error)
    }

    const isIndexDiscarded = (error: Error) => error.message.startsWith(INDEX_DISCARDED_PREFIX)

    /**
     * The worker found its stored index corrupt, threw it away and is now serving an EMPTY one
     * (core.ts). Whatever request tripped over it has already failed; what matters is that the
     * graph gets re-derived without anyone asking — the sidebars are answering "nothing" until
     * it does. Queued through the ordinary debounce so it lands behind whatever the failure
     * interrupted, and as a full replacement, because there is nothing left to be incremental
     * against.
     */
    function recoverIfDiscarded(error: Error): void {
        if (disposed || !isIndexDiscarded(error)) return
        dirty = null
        queueRebuild()
    }

    function cancelActiveRebuild(): void {
        const completion = activeRebuildCompletion
        activeRebuildId = undefined
        activeRebuildCompletion = undefined
        building = false
        completion?.resolve()
    }

    function request<T extends IndexResponse>(build: (id: number) => IndexRequest): Promise<T> {
        const id = nextId++
        return new Promise<T>((resolve, reject) => {
            pending.set(id, (response) => {
                if (response.type === 'error') {
                    const error = new Error(response.message)
                    recoverIfDiscarded(error)
                    reject(error)
                } else resolve(response as T)
            })
            transport.send(build(id))
        })
    }

    /**
     * The ownership lock in share.ts protects the ONE worker, not the source-side graph walk.
     * Several cold tabs can attach to that worker before its first generation commits, observe
     * the same empty database and each start streaming every document. Serialize that decision
     * separately, then re-open under the lock so followers see the winner's committed result.
     */
    async function withRebuildLock(work: () => Promise<void>): Promise<void> {
        const manager =
            typeof navigator !== 'undefined' &&
            typeof navigator.locks?.request === 'function'
                ? navigator.locks
                : undefined
        if (!manager) {
            await work()
            return
        }
        let entered = false
        try {
            await manager.request(
                REBUILD_LOCK_PREFIX + options.graphId,
                { mode: 'exclusive', signal: rebuildLockAbort.signal },
                async () => {
                    entered = true
                    if (!disposed) await work()
                },
            )
        } catch (error) {
            if (disposed || rebuildLockAbort.signal.aborted) return
            // A failure inside the protected work is authoritative. Only an unavailable
            // lock service degrades to the old single-tab behaviour.
            if (entered) throw error
            await work()
        }
    }

    /**
     * Source catch-up reads and advances shared cache watermarks. Serialising that read/advance
     * pair stops every newly-opened tab from downloading and decrypting the same long server
     * history concurrently. The follower re-checks watermarks only after the winner commits.
     */
    async function withCatchUpLock(work: () => Promise<void>): Promise<void> {
        const manager =
            typeof navigator !== 'undefined' &&
            typeof navigator.locks?.request === 'function'
                ? navigator.locks
                : undefined
        if (!manager) {
            await work()
            return
        }
        let entered = false
        try {
            await manager.request(
                CATCH_UP_LOCK_PREFIX + options.graphId,
                { mode: 'exclusive', signal: rebuildLockAbort.signal },
                async () => {
                    entered = true
                    if (!disposed) await work()
                },
            )
        } catch (error) {
            if (disposed || rebuildLockAbort.signal.aborted) return
            if (entered) throw error
            await work()
        }
    }

    async function openIndex({
        openId = nextOpenId++,
        send = true,
    }: {
        openId?: number
        send?: boolean
    } = {}): Promise<Extract<IndexResponse, { type: 'opened' }>> {
        if (disposed) throw new IndexTransportOpenError('the index was disposed')
        try {
            return await new Promise<Extract<IndexResponse, { type: 'opened' }>>(
                (resolve, reject) => {
                    // Startup patience is ACTIVITY-based, not a fixed cliff. Ferry attempts
                    // keep it alive until a worker accepts the open. Once `open-accepted`
                    // arrives the request is safely ordered in that worker's serial queue,
                    // so there is deliberately no client deadline on legitimate work ahead
                    // of it. A worker which cannot start never acknowledges and still fails
                    // closed. The worker owns a separate terminal safety bound.
                    const timeoutMs = options.openTimeoutMs ?? 15_000
                    const adoptedTimeoutMs = options.adoptedOpenTimeoutMs ?? 60_000
                    let idleTimeoutMs = timeoutMs
                    awaitedOpenId = openId
                    const cadence = Math.max(25, Math.min(1_000, Math.floor(timeoutMs / 2)))
                    let startedAt = performance.now()
                    let timer: ReturnType<typeof setInterval> | undefined
                    const stopStartupTimer = () => {
                        if (timer === undefined) return
                        clearInterval(timer)
                        timer = undefined
                    }
                    const startStartupTimer = () => {
                        stopStartupTimer()
                        startedAt = performance.now()
                        timer = setInterval(() => {
                            const idleSince = Math.max(startedAt, lastTransportActivity)
                            if (performance.now() - idleSince >= idleTimeoutMs) {
                                stopStartupTimer()
                                reject(new Error('the index worker did not answer'))
                            }
                        }, cadence)
                    }
                    startStartupTimer()
                    onOpenAccepted = (acceptedOpenId) => {
                        if (acceptedOpenId === openId) stopStartupTimer()
                    }
                    onOpenTransportChanged = () => {
                        idleTimeoutMs = timeoutMs
                        startStartupTimer()
                    }
                    onOpenAttached = () => {
                        idleTimeoutMs = Math.max(idleTimeoutMs, adoptedTimeoutMs)
                    }
                    onOpened = (response) => {
                        stopStartupTimer()
                        resolve(response)
                    }
                    onOpenFailed = (error) => {
                        stopStartupTimer()
                        reject(error)
                    }
                    if (send) transport.send({ type: 'open', graphId: options.graphId, openId })
                },
            ).finally(() => {
                onOpened = undefined
                onOpenAttached = undefined
                onOpenAccepted = undefined
                onOpenTransportChanged = undefined
                onOpenFailed = undefined
                awaitedOpenId = undefined
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            throw new IndexTransportOpenError(message)
        }
    }

    function createPreparedOpen({
        openId,
        send,
    }: {
        openId?: number
        send?: boolean
    } = {}): PreparedOpen {
        const correlatedOpenId = openId ?? nextOpenId++
        const pending = openIndex({ openId: correlatedOpenId, send })
        const next: PreparedOpen = {
            openId: correlatedOpenId,
            generation: transportGeneration,
            settled: false,
            promise: pending.then(
                (response) => {
                    next.settled = true
                    return response
                },
                (error) => {
                    next.settled = true
                    throw error
                },
            ),
        }
        // GraphWorkspace deliberately starts preparation before awaiting it. Attach a
        // rejection observer now, while preserving the same rejecting promise for refresh.
        void next.promise.catch(() => {})
        return next
    }

    function ensurePreparedOpen(): PreparedOpen {
        if (preparedOpen?.generation === transportGeneration) return preparedOpen
        preparedOpen = createPreparedOpen()
        return preparedOpen
    }

    async function preparedOpenResponse(consume: boolean): Promise<OpenedResponse> {
        for (;;) {
            const candidate = ensurePreparedOpen()
            let response: OpenedResponse
            try {
                response = await candidate.promise
            } catch (error) {
                if (candidate.generation !== transportGeneration) {
                    if (preparedOpen === candidate) preparedOpen = undefined
                    continue
                }
                throw error
            }
            if (candidate.generation !== transportGeneration) {
                if (preparedOpen === candidate) preparedOpen = undefined
                continue
            }
            if (consume && preparedOpen === candidate) preparedOpen = undefined
            return response
        }
    }

    function catchUpWarmIndex({ verifyExternalSource = true } = {}): void {
        // `dirty` is the monotonic queue of source events observed since subscription.
        // A target preload can emit while a busy shared worker is still answering `open`;
        // clearing here would lose that event after its Local Cache watermark had already
        // advanced. Only `rebuild()` may take and reset the queue. Repeated named changes
        // are harmless because the worker's content hash makes ingest idempotent.
        // The persisted generation is already the browser's durable derived state.
        // A synced source catches documents up from its stored sequence watermarks;
        // only genuine remote changes emit named `onChange` events and cross into the
        // worker. Externally mutable sources without that seam retain the safe full
        // verification path.
        const catchUp = Promise.resolve().then(() =>
            withCatchUpLock(async () => {
                if (source.catchUpPersistedIndex) {
                    await source.catchUpPersistedIndex()
                    // Cache watermarks and the SQLite index live in different databases. Drain
                    // the durable source journal and wait for the worker commit before releasing
                    // the cross-tab lock, otherwise a close in this gap can make the stale index
                    // look permanently current to the next tab.
                    if (timer !== undefined) {
                        clearTimeout(timer)
                        timer = undefined
                    }
                    await runRebuild()
                    return
                }
                // A follower which just waited for this browser's rebuild lock observed the
                // generation that the winner committed moments ago. Re-reading the same
                // filesystem source immediately would be a second derivation in disguise.
                if (!verifyExternalSource) return
                dirty = null
                await runRebuild()
            }),
        )
        void catchUp.catch((error: unknown) =>
            options.onBackgroundError?.(
                error instanceof Error ? error : new Error(String(error)),
            ),
        )
    }

    /** Hand the worker every document. Used when nothing usable is persisted. */
    async function rebuildAll(
        checkpointStream?: IndexChangeCheckpoint['streamForIndex'],
    ): Promise<void> {
        if (disposed) return
        if (activeRebuildId) {
            await activeRebuildCompletion?.promise
            return
        }
        performanceRecorder.mark('index.rebuild.full')
        const rebuildId = crypto.randomUUID()
        activeRebuildId = rebuildId
        const completion = newRebuildCompletion()
        activeRebuildCompletion = completion
        rebuildInvalidated = false
        rebuildRequiresFullRetry = false
        let total: number
        let batches: AsyncIterable<readonly IndexDoc[]>
        try {
            const streamSource = checkpointStream ?? source.streamForIndex
            if (streamSource) {
                const stream = await streamSource({
                    onProgress: options.onProgress,
                })
                total = stream.total
                batches = stream.batches
            } else {
                const docs = await source.snapshotForIndex({ onProgress: options.onProgress })
                total = docs.length
                batches = (async function* () {
                    for (let start = 0; start < docs.length; start += REBUILD_SEND_CHUNK) {
                        yield docs.slice(start, start + REBUILD_SEND_CHUNK)
                    }
                })()
            }
            if (disposed || activeRebuildId !== rebuildId) {
                await completion.promise
                return
            }
            transport.send({ type: 'rebuild-begin', rebuildId, total })
            let sent = 0
            for await (const batch of batches) {
                if (disposed || activeRebuildId !== rebuildId) {
                    await completion.promise
                    return
                }
                if (sent > 0) await new Promise((resolve) => setTimeout(resolve))
                const docs = [...batch]
                transport.send({ type: 'rebuild-docs', rebuildId, docs })
                sent += docs.length
            }
            if (!disposed && activeRebuildId === rebuildId) {
                transport.send({ type: 'rebuild-commit', rebuildId })
                // Posting the commit only puts it in the worker's queue. A cold workspace
                // cannot mount editors until the worker confirms that the generation was
                // atomically swapped and pushes the caches used for wikilink styling.
                await completion.promise
            }
        } catch (error) {
            const reported = error instanceof Error ? error : new Error(String(error))
            if (activeRebuildId === rebuildId) failActiveRebuild(reported)
            throw reported
        }
    }

    async function rebuild(): Promise<void> {
        if (disposed) return
        const checkpoint = await source.pendingIndexChanges?.()
        const checkpointDocuments = new Map(
            (checkpoint?.documents ?? []).map((document) => [
                conceptKey(document.concept),
                document,
            ]),
        )
        if (checkpoint?.changes === null) {
            dirty = null
        } else if (checkpoint && dirty !== null) {
            for (const change of checkpoint.changes) dirty.add(change.concept)
        }
        const changed = dirty
        dirty = new Set()
        try {
            const checkpointCoversChanged =
                changed !== null &&
                [...changed].every((concept) =>
                    checkpointDocuments.has(conceptKey(concept)),
                )
            if (
                changed === null ||
                (changed.size > INCREMENTAL_LIMIT && !checkpointCoversChanged)
            ) {
                await rebuildAll(checkpoint?.streamForIndex)
            } else if (changed.size > 0) {
                const docs: IndexDoc[] = []
                for (const concept of changed) {
                    const doc =
                        checkpointDocuments.get(conceptKey(concept)) ??
                        (await source.snapshotDocument?.(concept))
                    if (doc) docs.push(doc)
                }
                if (docs.length !== changed.size) {
                    // A named document disappeared before its snapshot was read. Only a full
                    // replacement can remove its old rows safely.
                    await rebuildAll(checkpoint?.streamForIndex)
                } else {
                    // A cold post-commit hydration can make every cache row dirty at once.
                    // Those rows already have exact, cache-bound snapshots, so replacing the
                    // just-committed generation would be a duplicate derivation. Send bounded
                    // targeted chunks instead and acknowledge them behind one ordered barrier.
                    for (let start = 0; start < docs.length; start += REBUILD_SEND_CHUNK) {
                        transport.send({
                            type: 'ingest',
                            docs: docs.slice(start, start + REBUILD_SEND_CHUNK),
                        })
                    }
                    await request<Extract<IndexResponse, { type: 'barrier' }>>((id) => ({
                        type: 'barrier',
                        id,
                    }))
                }
            }
            await checkpoint?.acknowledge()
        } catch (error) {
            // Keep volatile work retryable in this session. A durable checkpoint remains
            // unacknowledged as the cross-restart source of truth as well.
            if (changed === null) dirty = null
            else if (dirty !== null) for (const concept of changed) dirty.add(concept)
            throw error
        }
    }

    /** Source events and the terminal catch-up flush share one ordered main-thread pipeline. */
    function runRebuild(): Promise<void> {
        const next = rebuildTail.then(() => rebuild())
        rebuildTail = next
            .catch(() => undefined)
            .then(() => {
                const woken = drainWaiters
                drainWaiters = []
                for (const wake of woken) wake()
            })
        return next
    }

    function queueRebuild(): void {
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(() => {
            timer = undefined
            void runRebuild().catch((error: unknown) =>
                options.onBackgroundError?.(
                    error instanceof Error ? error : new Error(String(error)),
                ),
            )
        }, debounceMs)
    }

    function scheduleRebuild(change?: StoreChange): void {
        if (!change || !source.snapshotDocument) dirty = null
        else if (dirty !== null) dirty.add(change.concept)
        if (activeRebuildId) {
            rebuildInvalidated = true
            return
        }
        if (!backgroundRebuildsEnabled) return
        queueRebuild()
    }

    const unsubscribe = source.onChange(scheduleRebuild)

    return {
        conceptExists: (concept) => existing.has(conceptKey(concept)),
        candidate: (concept) => candidates.get(conceptKey(concept)),
        allConcepts: () =>
            [...candidates.values()].sort((a, b) => a.key.localeCompare(b.key)),
        async backlinks(concept) {
            const response = await request<Extract<IndexResponse, { type: 'backlinks' }>>((id) => ({
                type: 'backlinks',
                id,
                concept,
            }))
            return response.groups
        },
        async assetUsage(needles) {
            const response = await request<Extract<IndexResponse, { type: 'asset-usage' }>>((id) => ({
                type: 'asset-usage',
                id,
                needles: [...needles],
            }))
            return response.usage
        },
        async searchText(query, offset, limit) {
            const response = await request<Extract<IndexResponse, { type: 'search-text' }>>(
                (id) => ({ type: 'search-text', id, query, offset, limit }),
            )
            return { groups: response.groups, hasMore: response.hasMore }
        },
        async searchTextCount(query) {
            const response = await request<Extract<IndexResponse, { type: 'search-count' }>>(
                (id) => ({ type: 'search-count', id, query }),
            )
            return { total: response.total, capped: response.capped }
        },
        async tasks(query, offset, limit) {
            const response = await request<Extract<IndexResponse, { type: 'tasks' }>>((id) => ({
                type: 'tasks',
                id,
                query,
                offset,
                limit,
            }))
            return { hits: response.hits, hasMore: response.hasMore, total: response.total }
        },
        semantic: {
            async status(model) {
                const response = await request<Extract<IndexResponse, { type: 'semantic-status' }>>((id) => ({ type: 'semantic-status', id, model }))
                return response.status
            },
            async pending(model, limit) {
                const response = await request<Extract<IndexResponse, { type: 'semantic-pending' }>>((id) => ({ type: 'semantic-pending', id, model, limit }))
                return response.passages
            },
            async put(model, dims, rows) {
                const response = await request<Extract<IndexResponse, { type: 'semantic-put' }>>((id) => ({ type: 'semantic-put', id, model, dims, rows: [...rows] }))
                return response.stored
            },
            async search(model, vector, offset, limit, floor) {
                const response = await request<Extract<IndexResponse, { type: 'semantic-search' }>>((id) => ({ type: 'semantic-search', id, model, vector, offset, limit, floor }))
                return { groups: response.groups, hasMore: response.hasMore, status: response.status }
            },
            async sweep(model) {
                const response = await request<Extract<IndexResponse, { type: 'semantic-sweep' }>>((id) => ({ type: 'semantic-sweep', id, model }))
                return response.removed
            },
        },
        prepare() {
            const preparation = preparedOpenResponse(false).then(() => {})
            // A caller may intentionally fire-and-overlap this with store hydration. The
            // authoritative failure is still returned and later rethrown by refresh.
            void preparation.catch(() => {})
            return preparation
        },
        isPersisted: () => persisted,
        persistenceBlocked: () => persistenceBlocked,
        onPersistenceChanged(listener) {
            persistenceChanged.add(listener)
            return () => persistenceChanged.delete(listener)
        },
        isBuilding: () => building,
        async refresh() {
            const opened = await preparedOpenResponse(true)
            // Something usable was already on disk. Trust it for the interactive open.
            // Subsequent document deltas correct changed rows, and an explicit full refresh
            // streams content through a staged generation before swapping it into view.
            if (opened.indexedDocuments > 0) {
                backgroundRebuildsEnabled = true
                catchUpWarmIndex()
                return
            }
            // Keep every follower on GraphWorkspace's loading surface while the first tab
            // derives and commits the shared generation.
            building = true
            await withRebuildLock(async () => {
                // Another tab may have completed the graph walk while this tab waited.
                // Re-open is idempotent in the shared worker and avoids touching the source.
                const afterLock = await openIndex()
                if (afterLock.indexedDocuments > 0) {
                    building = false
                    backgroundRebuildsEnabled = true
                    catchUpWarmIndex({ verifyExternalSource: false })
                    return
                }
                dirty = null
                coldCatchUpPending = true
                await runRebuild()
                backgroundRebuildsEnabled = true
            })
        },
        async rebuild() {
            if (disposed) return
            // A null queue is the full-replacement signal `rebuild()` already honours for an
            // over-limit change set: every document is streamed, the worker inserts each into
            // the staged generation without consulting its stored hash, and the commit swaps
            // the whole thing. Queued on the same ordered tail as source events, so a keystroke
            // landing mid-rebuild is not lost — it is ingested after the swap.
            dirty = null
            try {
                await runRebuild()
            } catch (error) {
                // The rebuild is precisely what a user reaches for when the index is wrecked,
                // and a wreck fails the first attempt by discarding itself. Once over.
                if (!(error instanceof Error) || !isIndexDiscarded(error)) throw error
                dirty = null
                await runRebuild()
            }
        },
        onUpdated(listener) {
            updated.add(listener)
            return () => updated.delete(listener)
        },
        settled() {
            return new Promise<void>((resolve) => {
                const look = () => {
                    // A queued debounce will run a rebuild; wait for that run, then look again in
                    // case a change arrived meanwhile and re-armed it.
                    if (timer !== undefined && !disposed) {
                        drainWaiters.push(look)
                        return
                    }
                    rebuildTail.then(resolve, resolve)
                }
                look()
            })
        },
        dispose() {
            disposed = true
            onOpenFailed?.(new Error('the index was disposed'))
            preparedOpen = undefined
            rebuildLockAbort.abort()
            // Disposal is an expected workspace lifecycle event, not a background failure.
            cancelActiveRebuild()
            if (timer !== undefined) clearTimeout(timer)
            unsubscribe()
            updated.clear()
            persistenceChanged.clear()
            transport.send({ type: 'close' })
            transport.close()
        },
    }
}
