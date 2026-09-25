/**
 * Graph-level sync (plan Phase 3 Task 5): one WebSocket per open graph, multiplexing all
 * documents. Owns per-doc engines (created lazily), the reconnect loop, and the graph-root
 * document — a hidden Y.Doc whose `registry` Y.Map (docId → {kind,title?,date?}) and `meta`
 * Y.Map (graph name, settings) are how a blind server's clients discover the doc set.
 *
 * The transport is injected (a `connect(url)` factory) so this unit-tests without real sockets.
 */
import * as Y from 'yjs'
import type { GraphKeyring } from '$lib/crypto'
import { performanceRecorder } from '$lib/diagnostics/performance'
import { SYNC_PROTOCOL_LIMITS } from '@appsoftwareltd/etherpk-shared'
import { CACHE_SEED, createDocSync, type DocSync } from './doc-sync'
import type { GraphCache } from './local-cache'
import {
    SyncProtocolMismatchError,
    readServerMessage,
    serializeClientMessage,
    type RelayClientMessage,
} from './messages'
import { createPresenceSession, type PresenceSession } from './presence-session'
import type { SyncTokenSource } from './sync-token'
import { type QuickNote, sanitizeQuickNotes } from '$lib/document/quick-notes'
import { sanitizeDictionaryWords } from '$lib/document/spelling/graph-dictionary'
import { type GraphTheme, isThemeFilePath, sanitizeGraphTheme } from '$lib/document/publish/theme/graph-theme'

export interface TransportSocket {
    send(data: string): void
    close(): void
    onOpen(cb: () => void): void
    onMessage(cb: (data: string) => void): void
    onClose(cb: () => void): void
}

export interface GraphSyncDeps {
    graphId: string
    rootDocId: string
    /**
     * Ask the relay for every document's live updates, not only the retained ones. A tab
     * retains what it shows and catches the rest up when it opens; a [[Headless Client]] serves
     * an index of the whole graph for as long as it runs, so a page created or edited on another
     * device must reach it live (2026-09-17: a serve that had run for half an hour had not
     * learned of two pages the server had held for ten minutes). An update for a document no
     * engine holds yet creates a synchronised engine, which catches its history up on its own.
     */
    subscribeAll?: boolean
    keyring: GraphKeyring
    relayUrl: string
    /**
     * Asked for a token on every connect, NOT captured once: a session outlives its
     * token's 15 minutes, and a reconnect carrying an expired one is rejected forever.
     */
    token: SyncTokenSource
    cache: GraphCache
    connect(url: string): TransportSocket
    debounceMs?: number
    /** Called whenever the registry Y.Map changes (membership of the doc set). */
    onRegistryChange?: () => void
    /** Passed to every document engine - see `DocSyncDeps.collectRowWhen`. */
    collectRowWhen?: (doc: Y.Doc) => boolean
    /**
     * This device's PREFERRED identity for the awareness `user` field — what y-codemirror
     * renders a remote caret's colour and name from. Absent ⇒ collaborators all show as
     * the library's default-blue "Anonymous". The per-session allocator owns the colour
     * actually advertised (presence-session.ts): the preference is kept when free and
     * deterministically moved when an earlier live session already shows it.
     */
    presence?: { name: string; color: string; colorLight?: string }
    /** Surfaces cache quota and transport failures to the owning workspace. */
    onError?: (error: Error) => void
    /**
     * Where the canonical [[Graph Name]] goes so devices that never opened this graph can
     * label it: the Sync Server's name envelope (ADR 0031, amended 2026-09-17;
     * graph-name-envelope.ts builds the callback). Called with the name once the root document
     * has caught up, then on every change, local or remote, and never twice with the same
     * value. Absent, the session publishes nothing.
     */
    publishName?: (name: string) => void
}

export interface RegistryEntry {
    kind: 'journal' | 'page'
    title?: string
    date?: string
    /**
     * Alternative names resolving to this document ([[Alias]]). A server document has no
     * frontmatter - identity lives only here (ADR 0024) - so this is where a rename's
     * "keep the old name working" arm puts the old name (ADR 0037).
     */
    aliases?: string[]
}

/**
 * The root doc's `meta` Y.Map: the [[Graph Name]] (identity metadata — one canonical,
 * any-member-writable name) and the shared [[Graph Settings]] object. Both are content:
 * encrypted like everything else, so the blind server never sees them.
 */
export interface GraphMeta {
    name?: string
    /** GraphSettings-shaped; consumers sanitize (storage/fs/graph-settings). */
    settings?: Record<string, unknown>
}

export interface GraphSync {
    readonly rootDoc: Y.Doc
    docSync(docId: string): DocSync
    retainDoc(docId: string): () => void
    /** Queue an ordered, durable lifecycle delete before the encrypted registry changes. */
    deleteDoc(docId: string): Promise<void>
    /** Drop deleted content from a document's cache row - after protecting it (ADR 0057). */
    compactDoc(docId: string): Promise<void>
    /**
     * Upload a consolidated encrypted snapshot of a document to the relay now, rather than
     * waiting for the idle trigger; the engine reads it back and verifies it (ADR 0025).
     */
    uploadSnapshot(docId: string): Promise<void>
    registry(): Y.Map<RegistryEntry>
    /** Snapshot of the root doc's `meta` map (graph name + shared settings). */
    getMeta(): GraphMeta
    setMetaName(name: string): void
    setMetaSettings(settings: Record<string, unknown>): void
    /** Fires on any `meta` change (local or remote). Returns an unsubscribe. */
    onMetaChange(listener: () => void): () => void
    /**
     * The graph's [[Quick Note]]s: the root doc's `quickNotes` Y.Array (ADR 0078). Its own
     * container rather than a field of `meta.settings`, because an array of elements merges
     * concurrent inserts from two devices where a whole-object setting would keep one and
     * drop the other. Encrypted like the rest of the root doc.
     */
    quickNotes(): {
        /** Every well-formed note, in array order (the View sorts by `createdAt`). */
        list(): QuickNote[]
        add(note: QuickNote): void
        remove(ids: readonly string[]): void
        /** Fires on any change to the array (local or remote). Returns an unsubscribe. */
        observe(listener: () => void): () => void
    }
    /**
     * The graph's [[Graph Dictionary]]: the root doc's `spellingDictionary` Y.Map of word ->
     * `true` (ADR 0095). A map of its own for the reason quick notes are an array of their own:
     * two devices adding words while apart both keep them. Encrypted like the rest of the root doc.
     */
    spellingDictionary(): {
        /** Every well-formed word, deduped and capped. */
        list(): string[]
        add(word: string): void
        remove(words: readonly string[]): void
        /** Fires on any change to the map (local or remote). Returns an unsubscribe. */
        observe(listener: () => void): () => void
    }
    /**
     * The graph's [[Theme]]s: the root doc's `themes` Y.Map (ADR 0082), theme id → a Y.Map of
     * the theme's fields with its files as a nested Y.Map of path → text. Per-file entries so a
     * save writes one file's text whole and two members editing different files of one theme
     * both keep their edits; a lost concurrent edit to the same file is visible and rare, unlike
     * the note loss ADR 0078 avoids. Encrypted like the rest of the root doc.
     */
    themes(): {
        list(): GraphTheme[]
        get(id: string): GraphTheme | null
        /** Write a whole theme: every file, replacing any it no longer has. */
        put(theme: GraphTheme): void
        /** Write one file's text. */
        putFile(id: string, path: string, text: string): void
        removeFile(id: string, path: string): void
        remove(id: string): void
        /** Fires on any change to any theme (local or remote). Returns an unsubscribe. */
        observe(listener: () => void): () => void
    }
    /** Resolves once the socket has opened (first connect). Short-lived flows need this
     *  before flushing — a flush into a never-opened socket dies with dispose. */
    connected(): Promise<void>
    /** Resolves once the ROOT doc's current catch-up reaches its terminal relay page. */
    rootCaughtUp(): Promise<void>
    /** Fires whenever ANY document's content (Y.Doc) changes — local or remote. The docId is
     *  the graph-root id for registry changes, else the content doc id. */
    onDocUpdate(listener: (docId: string) => void): () => void
    ready(): Promise<void>
    /**
     * Resolves when ONE doc's engine has seeded from the [[Local Cache]] (creating the
     * engine if needed). This is what lets an opened document show "loading" instead of
     * sitting silently empty while the background materialisation walk is still running.
     */
    whenReady(docId: string): Promise<void>
    /**
     * Hydrate a cold-index batch from the Local Cache without starting relay catch-up.
     * The caller must later promote stale documents through normal synchronized readiness.
     */
    seedDocsFromCache(docIds: readonly string[]): Promise<readonly Y.Doc[]>
    /** Seed only this batch, without re-awaiting every engine created earlier. */
    readyDocs(docIds: readonly string[]): Promise<void>
    /** Release background-only engines once their batch consumer has read them. */
    retireDocs(docIds: readonly string[]): void
    /** Resolves after ONE doc's first relay page is applied, for presentation readiness. */
    firstCatchupPageDoc(docId: string): Promise<void>
    /** Resolves at the terminal page of ONE doc's current catch-up cycle. */
    caughtUpDoc(docId: string): Promise<void>
    /**
     * Compare the Local Cache with one bounded relay metadata request per batch. Warm indexes
     * only materialise documents whose server watermark actually moved while this browser
     * was away.
     */
    docsNeedingCatchup(docIds: readonly string[]): Promise<string[]>
    /**
     * Cache rows which changed after the last explicit index commit. The acknowledgement
     * closure clears only the exact tokens captured by this call.
     */
    pendingIndexChanges(): Promise<GraphIndexCheckpoint>
    /** Whether the relay socket is open right now — gate anything that waits on the server. */
    isConnected(): boolean
    /**
     * Encrypt and send every pending update. On a large [[Import]] this is where the minutes
     * go, so it reports as each document's engine finishes - without it the Activity sat at
     * "0 of 2401" until the first acknowledgement arrived, looking hung.
     */
    flushAll(options?: { onProgress?: (flushed: number, total: number) => void }): Promise<void>
    /**
     * Wait until the server has acknowledged every operation in the durable outbox.
     *
     * `flushAll()` only gets bytes as far as `socket.send`; it never waited for the relay.
     * Anything that must not claim "the server has it" - an [[Import]] declaring itself
     * done, before the socket is disposed - has to wait here instead.
     *
     * Resolves `settled: false` when no ack has arrived for `stallMs`: the caller decides
     * what a stall means. It is NOT an error - unacked updates are already in the
     * durable outbox and replay on the next open, so a stall is a weaker claim, not a loss.
     */
    awaitAcked(options?: AwaitAckedOptions): Promise<AckResult>
    diagnostics(): { activeEngines: number; retainedDocuments: number }
    dispose(): void
}

export interface GraphIndexCheckpoint {
    docIds: readonly string[]
    /** Root bytes merged from durable cache and this tab's live CRDT, for identity mapping. */
    rootUpdate: Uint8Array | null
    /**
     * Read content at least as new as the captured cache token. A dirty missing row is a
     * deletion tombstone and deliberately does not fall back to a stale live engine.
     */
    readDocument(docId: string): Promise<Uint8Array | null>
    acknowledge(): Promise<void>
}

export interface AwaitAckedOptions {
    /** Called with the number of appends still outstanding, whenever that number falls. */
    onProgress?: (outstanding: number) => void
    signal?: AbortSignal
    /** Give up after this long with no ack at all. Default 30s. */
    stallMs?: number
}

export interface AckResult {
    /** True when everything was acked; false when the wait gave up on a stall. */
    settled: boolean
    /** Appends still unacked (0 when `settled`). */
    outstanding: number
}

/** Reconnect after a dropped socket (simple; backoff tuned later). */
const RECONNECT_MS = 50
/** Retry after a token mint failed - a server round trip, so slower than a reconnect. */
const TOKEN_RETRY_MS = 2_000

/** Internal signal: a watermark request is safe to repeat on the next socket generation. */
class WatermarkConnectionInterruptedError extends Error {}

export function createGraphSync(deps: GraphSyncDeps): GraphSync {
    const engines = new Map<string, DocSync>()
    const retained = new Map<string, number>([[deps.rootDocId, 1]])
    const retiring = new Set<string>()
    const presenceSession: PresenceSession | undefined = deps.presence
        ? createPresenceSession({
              name: deps.presence.name,
              color: deps.presence.color,
              colorLight: deps.presence.colorLight ?? `${deps.presence.color}33`,
          })
        : undefined
    const presenceDetach = new Map<string, () => void>()
    const docUpdateListeners = new Set<(docId: string) => void>()
    // ack carries only outboxId (no docId); remember which doc issued each append so an
    // ack routes back to the right engine.
    const ackRoute = new Map<string, string>()
    let socket: TransportSocket | undefined
    let open = false
    let disposed = false
    /**
     * Set when the Sync Server turned out to speak another protocol version. The session then
     * stops for good: every reconnect would meet the same server, and nothing either side
     * sends can be read by the other. Pending appends stay in the cache for a later session.
     */
    let protocolMismatch: SyncProtocolMismatchError | undefined
    const reportError = (error: unknown) => {
        if (!disposed) deps.onError?.(error instanceof Error ? error : new Error(String(error)))
    }
    const outboundSnapshots: string[] = []
    type CatchupRequest = Extract<RelayClientMessage, { type: 'catchup' }>
    const foregroundCatchups: CatchupRequest[] = []
    const backgroundCatchups: CatchupRequest[] = []
    let catchupInFlight: CatchupRequest | undefined
    let resolveFirstOpen: (() => void) | undefined
    const firstOpen = new Promise<void>((resolve) => {
        resolveFirstOpen = resolve
    })
    const connectionWaiters = new Set<{
        resolve: () => void
        reject: (error: Error) => void
    }>()
    type DocumentWatermark = {
        docId: string
        generation: number
        state: 'active' | 'deleted'
        lastSeq: number
    }
    const watermarkRequests = new Map<
        string,
        {
            resolve: (documents: DocumentWatermark[]) => void
            reject: (error: Error) => void
            timer: ReturnType<typeof setTimeout>
        }
    >()

    /**
     * `connected()` is deliberately a first-open milestone. Watermark reconciliation can
     * start hours later, so it needs the socket that is live NOW rather than that settled
     * historical promise.
     */
    function waitForCurrentConnection(): Promise<void> {
        if (open && socket) return Promise.resolve()
        if (disposed) return Promise.reject(new Error('the graph sync session was disposed'))
        if (protocolMismatch) return Promise.reject(protocolMismatch)
        return new Promise<void>((resolve, reject) => {
            connectionWaiters.add({ resolve, reject })
        })
    }

    async function requestWatermarks(docIds: readonly string[]): Promise<DocumentWatermark[]> {
        while (!disposed) {
            await waitForCurrentConnection()
            const activeSocket = socket
            // A close can land between the waiter resolving and this continuation running.
            if (!open || !activeSocket) continue

            try {
                return await new Promise<DocumentWatermark[]>((resolve, reject) => {
                    const requestId = crypto.randomUUID()
                    const timer = setTimeout(() => {
                        watermarkRequests.delete(requestId)
                        reject(new Error('the sync relay did not answer a watermark check'))
                    }, 15_000)
                    watermarkRequests.set(requestId, { resolve, reject, timer })
                    activeSocket.send(
                        serializeClientMessage({
                            type: 'watermarks',
                            requestId,
                            docIds: [...docIds],
                        }),
                    )
                })
            } catch (error) {
                // The request is read-only and idempotent. A socket generation ending while
                // it is in flight means "try on the reconnect", not a failed reconciliation.
                if (error instanceof WatermarkConnectionInterruptedError && !disposed) continue
                throw error
            }
        }
        throw new Error('the graph sync session was disposed')
    }

    /**
     * Documents the CURRENT socket has subscribed to. The relay keeps and forwards presence
     * only for a subscribed document, and this mirrors that rule at the source:
     * y-protocols renews every engine's awareness state every fifteen seconds, and an engine
     * created for a background walk starts with an empty `{}` state, so without the gate every
     * unretained engine encrypted and sent presence the relay would only drop. Cleared with
     * the socket; the reconnect's subscribe rebuilds it before anything is advertised.
     */
    const subscribed = new Set<string>()

    function sendNow(message: RelayClientMessage): void {
        if (message.type === 'presence' && !subscribed.has(message.docId)) return
        const data = serializeClientMessage(message)
        if (open && socket) {
            socket.send(data)
            if (message.type === 'subscribe' && 'docIds' in message) for (const docId of message.docIds) subscribed.add(docId)
            if (message.type === 'unsubscribe') for (const docId of message.docIds) subscribed.delete(docId)
        } else if (message.type === 'snapshot_put') outboundSnapshots.push(data)
        // Appends are already durable and replay on open. Catch-up is regenerated from the
        // current watermark. Presence is ephemeral, and a lost ack confirmation merely
        // leaves a harmless server receipt, so none belongs in a volatile socket queue.
    }

    /**
     * Subscribe to every retained document on a freshly opened socket, in batches the relay
     * accepts. Above the protocol's per-message limit the relay rejects a subscribe as invalid,
     * which would leave a tab with many open views silently without live updates after a
     * reconnect.
     */
    function subscribeRetained(): void {
        const docIds = [...retained.keys()]
        const batchSize = SYNC_PROTOCOL_LIMITS.maxSubscriptionDocIds
        for (let start = 0; start < docIds.length; start += batchSize) {
            sendNow({ type: 'subscribe', docIds: docIds.slice(start, start + batchSize) })
        }
    }

    function pumpCatchups(): void {
        if (!open || !socket || catchupInFlight) return
        catchupInFlight = foregroundCatchups.shift() ?? backgroundCatchups.shift()
        if (catchupInFlight) socket.send(serializeClientMessage(catchupInFlight))
    }

    function queueCatchup(message: CatchupRequest): void {
        if (!open) return
        if (
            catchupInFlight?.docId === message.docId &&
            catchupInFlight.generation === message.generation &&
            catchupInFlight.afterSeq === message.afterSeq
        ) {
            return
        }
        // A foreground open supersedes an unsent background request for the same document.
        const removeQueued = (queue: CatchupRequest[]) => {
            const index = queue.findIndex((candidate) => candidate.docId === message.docId)
            if (index >= 0) queue.splice(index, 1)
        }
        removeQueued(foregroundCatchups)
        removeQueued(backgroundCatchups)
        const queue = message.priority === 'foreground' ? foregroundCatchups : backgroundCatchups
        queue.push(message)
        pumpCatchups()
    }

    function finishCatchup(requestId?: string): void {
        if (!requestId || catchupInFlight?.requestId !== requestId) return
        const completedDocId = catchupInFlight.docId
        catchupInFlight = undefined
        pumpCatchups()
        retireEngineIfIdle(completedDocId)
    }

    function rawSend(message: RelayClientMessage): void {
        if (message.type === 'catchup') {
            queueCatchup(message)
            return
        }
        sendNow(message)
    }

    // Cache seeding and relay synchronization are separate operations. A cold index needs
    // bounded, cache-only batches; foreground documents and post-commit reconciliation
    // explicitly promote an engine into synchronization.
    const readied = new Map<string, Promise<void>>()
    const syncEnabled = new Set<string>()

    function activate(docId: string, e: DocSync): void {
        readied.set(docId, e.ready())
    }

    function enableSync(docId: string, e: DocSync): void {
        if (syncEnabled.has(docId)) return
        syncEnabled.add(docId)
        // A lazily-created engine, including one first used by a cache-only index walk,
        // must catch up when a real consumer promotes it. Keep the cache failure visible
        // through `readied`; this detached branch only reports it without an unhandled
        // rejection while no caller is awaiting yet.
        void (readied.get(docId) ?? Promise.resolve())
            .then(() => {
                if (!disposed && open && engines.get(docId) === e) e.resync()
            })
            .catch(reportError)
    }

    /**
     * Identity is applied on RETENTION, not engine creation: background index and
     * materialisation walks create engines for documents nobody is editing, and an engine
     * can outlive a release/retain cycle. The session's apply also resurrects a state
     * cleared by clearPresence — setLocalStateField would silently no-op on it, leaving
     * this client permanently invisible after re-opening a document (live, 2026-07-30).
     */
    function attachPresence(docId: string, e: DocSync): void {
        if (!presenceSession || docId === deps.rootDocId || presenceDetach.has(docId)) return
        presenceDetach.set(docId, presenceSession.attach(e.awareness))
    }

    function detachPresence(docId: string): void {
        presenceDetach.get(docId)?.()
        presenceDetach.delete(docId)
    }

    function retireEngineIfIdle(docId: string): void {
        if (docId === deps.rootDocId || retained.has(docId) || !retiring.has(docId)) return
        if (
            catchupInFlight?.docId === docId ||
            foregroundCatchups.some((request) => request.docId === docId) ||
            backgroundCatchups.some((request) => request.docId === docId)
        ) {
            return
        }
        const candidate = engines.get(docId)
        if (!candidate || !candidate.isIdle()) return
        retiring.delete(docId)
        detachPresence(docId)
        candidate.destroy()
        engines.delete(docId)
        readied.delete(docId)
        syncEnabled.delete(docId)
        performanceRecorder.mark('sync.engine.count', {
            active: engines.size,
            subscriptions: retained.size,
        })
    }

    function engine(docId: string, synchronize = true): DocSync {
        let e = engines.get(docId)
        if (!e) {
            e = createDocSync({
                docId,
                graphId: deps.graphId,
                keyring: deps.keyring,
                send: (message) => {
                    if (
                        message.type === 'append' ||
                        message.type === 'delete' ||
                        message.type === 'resurrect'
                    ) {
                        ackRoute.set(message.outboxId, docId)
                    }
                    rawSend(message)
                },
                persist: deps.cache.docCache(
                    docId,
                    docId === deps.rootDocId ? 'root' : 'document',
                ),
                debounceMs: deps.debounceMs,
                collectRowWhen: docId === deps.rootDocId ? undefined : deps.collectRowWhen,
                // The disposed-guarded reporter, not the raw callback: an engine's late
                // rejection after dispose must not reach the next workspace's notice.
                onError: reportError,
                onIdle: () => queueMicrotask(() => retireEngineIfIdle(docId)),
                catchupPriority: () => {
                    return retained.has(docId) ? 'foreground' : 'background'
                },
            })
            engines.set(docId, e)
            performanceRecorder.mark('sync.engine.count', {
                active: engines.size,
                subscriptions: retained.size,
            })
            // Name this device's caret before any cursor is advertised, so a collaborator
            // never sees the default-blue "Anonymous" flash into a named one.
            if (retained.has(docId)) attachPresence(docId, e)
            // Any content change (local edit or remote update) notifies onDocUpdate, so the
            // store's onChange (index, mirror) fires on edits, not only on registry changes.
            e.doc.on('update', (_update, origin) => {
                // Rehydrating the already-indexed IndexedDB snapshot on every hard refresh
                // is not a content change. Genuine relay updates use REMOTE and still flow.
                if (origin === CACHE_SEED) return
                for (const l of docUpdateListeners) l(docId)
            })
            activate(docId, e)
        }
        if (synchronize) enableSync(docId, e)
        return e
    }

    async function indexDocumentUpdate(
        docId: string,
        missingCacheMeansDeleted: boolean,
    ): Promise<Uint8Array | null> {
        const cached = await deps.cache.docCache(docId).load()
        if (cached?.lifecycle === 'deleted' || (!cached && missingCacheMeansDeleted)) {
            return null
        }
        const live = engines.get(docId)
        if (!cached && !live) return null

        // A tab can be older than a cache boundary written by a peer, while a local edit can
        // be newer than its own asynchronous cache save. CRDT-merging both views gives the
        // index a snapshot at least as new as the captured token without creating a relay
        // subscription solely to read derived data.
        const merged = new Y.Doc()
        try {
            if (cached) Y.applyUpdate(merged, cached.update, CACHE_SEED)
            if (live) Y.applyUpdate(merged, Y.encodeStateAsUpdate(live.doc), CACHE_SEED)
            return Y.encodeStateAsUpdate(merged)
        } finally {
            merged.destroy()
        }
    }

    // The root document is just another synced doc.
    const root = engine(deps.rootDocId)
    const registryMap = root.doc.getMap<RegistryEntry>('registry')
    if (deps.onRegistryChange) registryMap.observe(() => deps.onRegistryChange?.())
    const metaMap = root.doc.getMap<unknown>('meta')
    const quickNotesArray = root.doc.getArray<unknown>('quickNotes')
    const dictionaryMap = root.doc.getMap<unknown>('spellingDictionary')
    const themesMap = root.doc.getMap<Y.Map<unknown>>('themes')

    /** A stored theme as a plain object, or null when the entry is not one. */
    function readTheme(id: string): GraphTheme | null {
        const entry = themesMap.get(id)
        if (!(entry instanceof Y.Map)) return null
        const filesMap = entry.get('files')
        const files: Record<string, unknown> = {}
        if (filesMap instanceof Y.Map) for (const [path, text] of filesMap.entries()) files[path] = text
        return sanitizeGraphTheme({ id, name: entry.get('name'), origin: entry.get('origin'), updatedAt: entry.get('updatedAt'), files })
    }

    function themeEntry(id: string, create: boolean): Y.Map<unknown> | null {
        let entry = themesMap.get(id)
        if (!(entry instanceof Y.Map)) {
            if (!create) return null
            entry = new Y.Map<unknown>()
            themesMap.set(id, entry)
            entry.set('files', new Y.Map<string>())
        }
        return entry
    }

    function themeFiles(entry: Y.Map<unknown>): Y.Map<string> {
        let files = entry.get('files')
        if (!(files instanceof Y.Map)) {
            files = new Y.Map<string>()
            entry.set('files', files)
        }
        return files as Y.Map<string>
    }
    // The name envelope follows what this session sees of the canonical name, with two rules.
    // A name this session writes itself goes out at once: the user's own rename is never stale.
    // A name that arrived from the cache or the relay goes out only after the root document has
    // genuinely caught up, because until then it may be older than what another member already
    // published. Disposal marks catch-up complete so waiters can end (doc-sync.ts), which must
    // not count as caught up here, or closing an offline tab would overwrite a newer name.
    let publishedName: string | undefined
    let rootCaughtUpOnce = false
    const publishName = (name: unknown) => {
        if (disposed || !deps.publishName) return
        if (typeof name !== 'string' || name === '' || name === publishedName) return
        publishedName = name
        deps.publishName(name)
    }
    const publishNameOnceCaughtUp = () => {
        if (rootCaughtUpOnce) publishName(metaMap.get('name'))
    }
    if (deps.publishName) {
        metaMap.observe(publishNameOnceCaughtUp)
        void root.caughtUp().then(
            () => {
                if (disposed) return
                rootCaughtUpOnce = true
                publishNameOnceCaughtUp()
            },
            () => {
                // A failed catch-up is reported through the engine's own channels. This session
                // then publishes nothing (the next one will), and the rejection must not escape:
                // in the Node-based Headless Client an unhandled rejection ends the process.
            },
        )
    }

    /** Report once, fail everything waiting for a connection, and close without reconnecting. */
    function stopForProtocolMismatch(serverVersion: number): void {
        if (protocolMismatch) return
        protocolMismatch = new SyncProtocolMismatchError(serverVersion)
        reportError(protocolMismatch)
        for (const waiter of connectionWaiters) waiter.reject(protocolMismatch)
        connectionWaiters.clear()
        socket?.close()
    }

    function handleMessage(raw: string): void {
        const read = readServerMessage(raw)
        if (read.kind === 'protocol_mismatch') {
            stopForProtocolMismatch(read.serverVersion)
            return
        }
        if (read.kind === 'malformed') return
        const message = read.message
        if (message.type === 'catchup_batch') {
            performanceRecorder.mark('sync.catchup.batch', {
                rows: message.updates.length,
                bytes: new TextEncoder().encode(raw).byteLength,
                continuation: message.hasMore ? 1 : 0,
            })
        }
        if (message.type === 'error') {
            if (
                message.code === 'stale_generation' &&
                message.docId &&
                message.currentGeneration !== undefined
            ) {
                if (catchupInFlight?.docId === message.docId) {
                    catchupInFlight = undefined
                }
                void engine(message.docId).staleGeneration(message.currentGeneration)
                pumpCatchups()
            }
            return
        }
        if (message.type === 'watermarks') {
            const pending = watermarkRequests.get(message.requestId)
            if (!pending) return
            clearTimeout(pending.timer)
            watermarkRequests.delete(message.requestId)
            pending.resolve(message.documents)
            return
        }
        const report = reportError
        if (message.type === 'presence') {
            if (!retained.has(message.docId)) return
            void engine(message.docId).receivePresence(message.envelope).catch(report)
            return
        }
        if (message.type === 'ack') {
            const docId = ackRoute.get(message.outboxId)
            if (docId) {
                void engine(docId)
                    .receive(message)
                    .then(() => ackRoute.delete(message.outboxId))
                    .catch(report)
            }
            return
        }
        if (message.type === 'catchup_batch') {
            void engine(message.docId)
                .receive(message)
                .catch(report)
                .finally(() => finishCatchup(message.requestId))
            return
        }
        void engine(message.docId).receive(message).catch(report)
    }

    /**
     * A token is fetched for EVERY connect, never captured: the source re-mints when the
     * held token nears expiry, so a socket that drops an hour in still reconnects. Sends
     * Encrypted appends issued while the token is in flight remain in IndexedDB and replay
     * on open. Only rebuildable snapshot uploads use a volatile queue.
     */
    function connect(): void {
        if (disposed || protocolMismatch) return
        void deps.token().then(
            (token) => {
                if (disposed) return
                const s = deps.connect(`${deps.relayUrl}?token=${encodeURIComponent(token)}`)
                socket = s
                s.onOpen(() => {
                    if (disposed || socket !== s) return
                    open = true
                    resolveFirstOpen?.()
                    for (const waiter of connectionWaiters) waiter.resolve()
                    connectionWaiters.clear()
                    subscribeRetained()
                    if (deps.subscribeAll) sendNow({ type: 'subscribe', all: true })
                    for (const data of outboundSnapshots.splice(0)) s.send(data)
                    // A local awareness state set while the socket was closed was dropped
                    // (presence never queues). Advertise every retained document now so the
                    // relay can store the envelope and replay it to late subscribers.
                    for (const docId of retained.keys()) {
                        if (docId === deps.rootDocId) continue
                        const e = engines.get(docId)
                        if (e) void e.advertisePresence().catch(reportError)
                    }
                    // Resync only engines promoted into synchronization. Cache-only cold-index
                    // batches must not turn one quick derivation into thousands of hidden
                    // downloads before post-commit reconciliation acquires its graph lock.
                    for (const [docId, e] of engines) {
                        if (!syncEnabled.has(docId)) continue
                        void (readied.get(docId) ?? Promise.resolve())
                            .then(() => e.resync())
                            .catch(reportError)
                    }
                })
                s.onMessage(handleMessage)
                s.onClose(() => {
                    if (socket !== s) return
                    open = false
                    socket = undefined
                    // Routes and subscriptions belong to one socket generation. Durable
                    // IndexedDB rows, not these entries, determine outstanding work and are
                    // replayed below; the next open resubscribes every retained document.
                    subscribed.clear()
                    ackRoute.clear()
                    catchupInFlight = undefined
                    foregroundCatchups.length = 0
                    backgroundCatchups.length = 0
                    for (const pending of watermarkRequests.values()) {
                        clearTimeout(pending.timer)
                        pending.reject(new WatermarkConnectionInterruptedError())
                    }
                    watermarkRequests.clear()
                    if (!disposed && !protocolMismatch) setTimeout(connect, RECONNECT_MS)
                })
            },
            // No token, no socket - normally offline, or a server that is down. Back off
            // further than a dropped socket does: minting is a server round trip.
            () => {
                if (!disposed) setTimeout(connect, TOKEN_RETRY_MS)
            },
        )
    }
    connect()

    return {
        rootDoc: root.doc,
        docSync: (docId) => engine(docId),
        retainDoc(docId) {
            const count = retained.get(docId) ?? 0
            retained.set(docId, count + 1)
            retiring.delete(docId)
            performanceRecorder.mark('sync.subscription.count', {
                subscriptions: retained.size,
                active: engines.size,
            })
            const retainedEngine = engine(docId)
            // The engine may predate retention (background index walk) or have been
            // released and re-retained — both must (re)apply the session identity here.
            attachPresence(docId, retainedEngine)
            if (count === 0 && open) {
                rawSend({ type: 'subscribe', docIds: [docId] })
                // The relay stores the latest presence envelope per subscriber; advertising
                // right after subscribe makes this client immediately visible to the room
                // and replayable to whoever subscribes next.
                void retainedEngine.advertisePresence().catch(reportError)
                void (readied.get(docId) ?? Promise.resolve()).then(() => retainedEngine.resync())
            }
            let released = false
            return () => {
                if (released || docId === deps.rootDocId) return
                released = true
                const next = (retained.get(docId) ?? 1) - 1
                if (next > 0) {
                    retained.set(docId, next)
                    return
                }
                retained.delete(docId)
                retiring.add(docId)
                performanceRecorder.mark('sync.subscription.count', {
                    subscriptions: retained.size,
                    active: engines.size,
                })
                // Awareness removal is an encrypted, ephemeral message. Preserve its wire
                // ordering before unsubscribe so peers do not retain a stale collaborator.
                detachPresence(docId)
                void retainedEngine
                    .clearPresence()
                    .catch(reportError)
                    .finally(() => {
                        if (disposed) return
                        if (retained.has(docId)) {
                            // Re-retained while the tombstone was in flight: re-apply the
                            // session identity (this resurrects the cleared state) and
                            // re-advertise, or this client stays invisible in this doc.
                            attachPresence(docId, retainedEngine)
                            if (open) void retainedEngine.advertisePresence().catch(reportError)
                            return
                        }
                        rawSend({ type: 'unsubscribe', docIds: [docId] })
                        retireEngineIfIdle(docId)
                    })
            }
        },
        deleteDoc: (docId) => engine(docId).delete(),
        compactDoc: (docId) => deps.cache.docCache(docId).compact(),
        uploadSnapshot: (docId) => engine(docId).compact(),
        registry: () => registryMap,
        getMeta() {
            const name = metaMap.get('name')
            const settings = metaMap.get('settings')
            return {
                ...(typeof name === 'string' && name !== '' ? { name } : {}),
                ...(typeof settings === 'object' && settings !== null ? { settings: settings as Record<string, unknown> } : {}),
            }
        },
        setMetaName(name) {
            metaMap.set('name', name)
            publishName(name)
        },
        setMetaSettings(settings) {
            metaMap.set('settings', settings)
        },
        onMetaChange(listener) {
            metaMap.observe(listener)
            return () => metaMap.unobserve(listener)
        },
        quickNotes: () => ({
            list: () => sanitizeQuickNotes(quickNotesArray.toArray()),
            add(note) {
                quickNotesArray.push([{ id: note.id, text: note.text, createdAt: note.createdAt }])
            },
            remove(ids) {
                // Highest index first, in one transaction, so earlier deletions do not shift
                // the indexes of later ones and peers see one change rather than several.
                const gone = new Set(ids)
                root.doc.transact(() => {
                    const items = quickNotesArray.toArray()
                    for (let i = items.length - 1; i >= 0; i--) {
                        const item = items[i]
                        const id = typeof item === 'object' && item !== null ? (item as { id?: unknown }).id : undefined
                        if (typeof id === 'string' && gone.has(id)) quickNotesArray.delete(i, 1)
                    }
                })
            },
            observe(listener) {
                quickNotesArray.observe(listener)
                return () => quickNotesArray.unobserve(listener)
            },
        }),
        spellingDictionary: () => ({
            list: () => sanitizeDictionaryWords([...dictionaryMap.keys()]),
            add(word) {
                dictionaryMap.set(word, true)
            },
            remove(words) {
                root.doc.transact(() => {
                    for (const word of words) dictionaryMap.delete(word)
                })
            },
            observe(listener) {
                dictionaryMap.observe(listener)
                return () => dictionaryMap.unobserve(listener)
            },
        }),
        themes: () => ({
            list() {
                const out: GraphTheme[] = []
                for (const id of themesMap.keys()) {
                    const theme = readTheme(id)
                    if (theme) out.push(theme)
                }
                return out.sort((a, b) => a.id.localeCompare(b.id))
            },
            get: (id) => readTheme(id),
            put(theme) {
                root.doc.transact(() => {
                    const entry = themeEntry(theme.id, true) as Y.Map<unknown>
                    entry.set('name', theme.name)
                    if (theme.origin !== undefined) entry.set('origin', theme.origin)
                    entry.set('updatedAt', theme.updatedAt ?? new Date().toISOString())
                    const files = themeFiles(entry)
                    for (const path of [...files.keys()]) if (!(path in theme.files)) files.delete(path)
                    for (const [path, text] of Object.entries(theme.files)) {
                        if (isThemeFilePath(path) && files.get(path) !== text) files.set(path, text)
                    }
                })
            },
            putFile(id, path, text) {
                if (!isThemeFilePath(path)) return
                root.doc.transact(() => {
                    const entry = themeEntry(id, true) as Y.Map<unknown>
                    themeFiles(entry).set(path, text)
                    entry.set('updatedAt', new Date().toISOString())
                })
            },
            removeFile(id, path) {
                const entry = themeEntry(id, false)
                if (!entry) return
                root.doc.transact(() => {
                    themeFiles(entry).delete(path)
                    entry.set('updatedAt', new Date().toISOString())
                })
            },
            remove(id) {
                themesMap.delete(id)
            },
            observe(listener) {
                themesMap.observeDeep(listener)
                return () => themesMap.unobserveDeep(listener)
            },
        }),
        connected: () => firstOpen,
        rootCaughtUp: () => root.caughtUp(),
        onDocUpdate(listener) {
            docUpdateListeners.add(listener)
            return () => docUpdateListeners.delete(listener)
        },
        async ready() {
            // Durable operations must replay even when their document is not otherwise
            // opened during this session.
            for (const docId of await deps.cache.pendingDocIds()) engine(docId)
            await Promise.all([...readied.values()])
        },
        async whenReady(docId) {
            engine(docId) // creating on demand also queues its cache read NOW, not at walk order
            await readied.get(docId)
        },
        async seedDocsFromCache(docIds) {
            const batch = docIds.map((docId) => engine(docId, false))
            await Promise.all(
                docIds.map((docId) => readied.get(docId) ?? Promise.resolve()),
            )
            return batch.map((entry) => entry.doc)
        },
        async readyDocs(docIds) {
            for (const docId of docIds) engine(docId)
            await Promise.all(
                docIds.map((docId) => readied.get(docId) ?? Promise.resolve()),
            )
        },
        retireDocs(docIds) {
            for (const docId of docIds) {
                if (docId === deps.rootDocId || retained.has(docId)) continue
                retiring.add(docId)
                retireEngineIfIdle(docId)
            }
        },
        firstCatchupPageDoc: (docId) => engine(docId).firstCatchupPage(),
        caughtUpDoc: (docId) => engine(docId).caughtUp(),
        async docsNeedingCatchup(docIds) {
            const changed: string[] = []
            for (
                let start = 0;
                start < docIds.length;
                start += SYNC_PROTOCOL_LIMITS.maxSubscriptionDocIds
            ) {
                const batch = docIds.slice(
                    start,
                    start + SYNC_PROTOCOL_LIMITS.maxSubscriptionDocIds,
                )
                const local = await deps.cache.watermarks(batch)
                const remote = await requestWatermarks(batch)
                for (const watermark of remote) {
                    const cached = local.get(watermark.docId)
                    if (
                        (!cached &&
                            (watermark.generation !== 1 ||
                                watermark.state !== 'active' ||
                                watermark.lastSeq !== 0)) ||
                        (cached &&
                            (cached.generation !== watermark.generation ||
                                cached.lifecycle !== watermark.state ||
                                cached.lastSeq !== watermark.lastSeq))
                    ) {
                        changed.push(watermark.docId)
                    }
                }
            }
            return changed
        },
        async pendingIndexChanges() {
            const changes = await deps.cache.pendingIndexChanges()
            const dirtyDocIds = new Set(changes.map((change) => change.docId))
            return {
                docIds: changes.map((change) => change.docId),
                rootUpdate: await indexDocumentUpdate(
                    deps.rootDocId,
                    dirtyDocIds.has(deps.rootDocId),
                ),
                readDocument: (docId) =>
                    indexDocumentUpdate(docId, dirtyDocIds.has(docId)),
                acknowledge: () => deps.cache.acknowledgeIndexChanges(changes),
            }
        },
        isConnected: () => open,
        async flushAll({ onProgress } = {}) {
            const all = [...engines.values()]
            let flushed = 0
            await Promise.all(all.map((e) => e.flush().then(() => onProgress?.(++flushed, all.length))))
        },
        async awaitAcked({ onProgress, signal, stallMs = 30_000 } = {}) {
            const initial = await deps.cache.countPending()
            if (initial === 0) return { settled: true, outstanding: 0 }
            onProgress?.(initial)

            return new Promise<AckResult>((resolve) => {
                let last = initial
                let lastProgressAt = Date.now()
                const POLL_MS = 100
                let timer: ReturnType<typeof setTimeout> | undefined
                const finish = (result: AckResult) => {
                    if (timer) clearTimeout(timer)
                    resolve(result)
                }
                const poll = async () => {
                    try {
                        const current = await deps.cache.countPending()
                        if (current < last) {
                            last = current
                            lastProgressAt = Date.now()
                            onProgress?.(current)
                        }
                        if (current === 0) return finish({ settled: true, outstanding: 0 })
                        if (signal?.aborted) return finish({ settled: false, outstanding: current })
                        if (Date.now() - lastProgressAt >= stallMs) {
                            return finish({ settled: false, outstanding: current })
                        }
                        timer = setTimeout(poll, POLL_MS)
                    } catch (error) {
                        reportError(error)
                        finish({ settled: false, outstanding: last })
                    }
                }
                timer = setTimeout(poll, POLL_MS)
            })
        },
        diagnostics: () => ({
            activeEngines: engines.size,
            retainedDocuments: retained.size,
        }),
        dispose() {
            disposed = true
            socket?.close()
            for (const detach of presenceDetach.values()) detach()
            presenceDetach.clear()
            for (const e of engines.values()) e.destroy()
            engines.clear()
            retiring.clear()
            syncEnabled.clear()
            foregroundCatchups.length = 0
            backgroundCatchups.length = 0
            catchupInFlight = undefined
            for (const pending of watermarkRequests.values()) {
                clearTimeout(pending.timer)
                pending.reject(new Error('the graph sync session was disposed'))
            }
            watermarkRequests.clear()
            for (const waiter of connectionWaiters) {
                waiter.reject(new Error('the graph sync session was disposed'))
            }
            connectionWaiters.clear()
        },
    }
}

/** The real browser WebSocket adapter (not used in unit tests). */
export function browserTransport(url: string): TransportSocket {
    const ws = new WebSocket(url)
    return {
        send: (data) => ws.send(data),
        close: () => ws.close(),
        onOpen: (cb) => ws.addEventListener('open', () => cb()),
        onMessage: (cb) => ws.addEventListener('message', (e) => cb(String((e as MessageEvent).data))),
        onClose: (cb) => ws.addEventListener('close', () => cb()),
    }
}
