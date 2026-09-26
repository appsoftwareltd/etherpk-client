/**
 * One graph, open in a process with no editor, behind the {@link HeadlessDocuments} interface
 * the tools use. This module holds the synced backend (ADR 0072) and the assembly the folder
 * backend (`headless-folder.ts`) shares with it: the derived index, its persistence, and
 * [[Semantic Search]] on demand.
 *
 * The synced backend is the client's own sync engine, server document store and derived index,
 * wired exactly as `GraphWorkspace.svelte` wires them for a tab, minus the tab. The
 * [[Headless Client]] holds the Graph Key and does the decrypting; the [[Sync Server]] stays as
 * blind to this device as to any other. Two browser seams are swapped here and nowhere else:
 *
 * - The [[Local Cache]] is IndexedDB in the browser. Node has none, so `fake-indexeddb` provides
 *   the same API in memory and `openGraphCache` runs unchanged - the store's tests already run it
 *   this way. With a `persistDir`, its rows are restored from the last run before the engine
 *   opens it and snapshotted after writes (`persistence.ts`); without one it is rebuilt from the
 *   relay on every open, which is the test tier's mode.
 * - The [[Derived Index]] runs in-process over sqlite-wasm in memory rather than in a shared
 *   worker over OPFS; with a `persistDir` the database bytes are imported on open and exported
 *   with the cache, so the index core takes its warm path. The [[Embedding]] store is a third
 *   file the same host attaches (ADR 0076).
 *
 * [[Semantic Search]] is opened on demand: `semantic()` loads the model the first time it is
 * asked and then follows the index, embedding new passages as they arrive. Which model is the
 * caller's (`embeddingModel`): the CLI passes the native one, the tests a fake, and a caller
 * that passes none gets an index that is not semantic.
 */

import 'fake-indexeddb/auto'

import type { GraphKeyring } from '$lib/crypto'
import { createRemoteGraphIndex, type RemoteGraphIndex } from '$lib/document/index-worker/client'
import { inlineTransport, memoryDbHost } from '$lib/document/index-worker/transport'
import type { SemanticStatus } from '$lib/document/semantic/embedding-db'
import type { EmbeddingModel } from '$lib/document/semantic/embedding-model'
import { createSemanticIndex, type SemanticIndex } from '$lib/document/semantic/semantic-index'
import { conceptKey } from '$lib/storage/fs/identity'
import { createServerDocumentStore } from '$lib/storage/server/server-document-store'
import { assetIdFromRef, createServerAssetStore } from '$lib/storage/server/server-asset-store'
import { listServerAssets } from '$lib/storage/server/asset-orphans'
import type { AssetStore } from '$lib/storage/fs/asset-store'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGraphSync, type SyncAccessLoss, type TransportSocket } from '$lib/sync/graph-sync'
import { openGraphCache } from '$lib/sync/local-cache'
import { PRESENCE_PALETTE } from '$lib/sync/presence-identity'
import type { SyncTokenSource } from '$lib/sync/sync-token'
import { writeRefusalForAgent } from '$lib/sync/write-refusal'
import { documentProtection } from '$lib/document/protection/cipher-fence'

import { readPublishSource } from '$lib/document/publish/source'
import type { PublishSource } from '$lib/document/publish/types'
import type { GraphTheme } from '$lib/document/publish/theme/graph-theme'

import type { HeadlessAssets } from './headless-assets'
import { bodyOf, bodyView, type HeadlessDocuments, type SettleResult } from './headless-documents'
import { nodeTransport } from './node-transport'
import { loadLocalCache, nodeIndexHost, persistLocalCache, type NodeIndexHost } from './persistence'

export interface HeadlessGraphDeps {
    graphId: string
    rootDocId: string
    keyring: GraphKeyring
    relayUrl: string
    token: SyncTokenSource
    /** How this device announces itself in collaborators' editors: *Agent on <host>*. */
    presenceName: string
    /** Swap point for tests (the loopback relay); production uses the Node WebSocket. */
    connect?: (url: string) => TransportSocket
    /** Bounded wait for the first relay connection; a serve that cannot reach the relay fails loudly. */
    readyTimeoutMs?: number
    /**
     * Where the Local Cache and the index are kept between launches (`persistence.ts`). Absent,
     * both live in memory and are rebuilt from the relay on every open - the test tier's mode.
     */
    persistDir?: string
    /** How long after a write before the snapshot is taken; the shutdown path never waits. */
    persistDebounceMs?: number
    /**
     * How to obtain the embedding model, called once on first semantic use. Absent, semantic
     * search is unavailable and `semantic()` rejects with a message saying so.
     */
    embeddingModel?: () => Promise<EmbeddingModel>
    /** After every stored batch of embeddings, with the store's state - for a progress line. */
    onSemanticProgress?: (status: SemanticStatus) => void
    onError?: (error: Error) => void
    /**
     * Called once when the Sync Server ends this account's access to the graph for good: the
     * membership ended, or the token was revoked. The session has stopped syncing; every tool
     * refuses from then on with `access_removed` or `token_revoked`.
     */
    onAccessLost?: (loss: SyncAccessLoss) => void
    /** Feeds the Sync Server's name envelope; see `GraphSyncDeps.publishName`. */
    publishName?: (name: string) => void
    /**
     * The graph's assets (ADR 0027): the Sync Server's HTTP base url for the encrypted asset
     * store, or - for a test, which has no HTTP server behind the loopback relay - a store to
     * use as it is. Absent, the asset tools refuse with a message saying so.
     */
    assets?: { baseUrl: string; fetch?: typeof fetch } | { store: AssetStore; identify: (ref: string) => string | null }
}

/**
 * How often the cache and index are exported while a build is running. A build reports
 * progress every batch - far more often than the write debounce below ever settles - so a
 * debounce alone would export nothing until the whole build finished, and a process killed
 * mid-way would lose every vector of the run. Throttled exports bound the loss to this window.
 */
const BUILD_PERSIST_EVERY_MS = 30_000

/** How long a read waits for the relay before answering with what it has. */
const CATCH_UP_TIMEOUT_MS = 15_000

/** How long `refresh()` waits for the index to absorb a change before answering from what it has. */
const INDEX_FOLLOW_MS = 5_000

export interface IndexFollower {
    /** Resolves once no source change is waiting on the index, or after the bound. */
    settled(): Promise<void>
    dispose(): void
}

/**
 * Whether the index has yet to absorb the source's latest change. A tool that searches right
 * after a write - its own, or one found on disk - would otherwise race the index's debounce and
 * answer from the moment before; `refresh()` on either backend waits here first. The wait is
 * bounded: an index that is rebuilding a large graph should not stall every tool behind it.
 *
 * "Absorbed" means the change has been through the index's pipeline (`index.settled`), not that
 * the index changed: a write that leaves the indexed text as it was - a frontmatter-only edit on
 * a synced graph, whose index strips the block - emits no update, and waiting for one would
 * wait out the bound on that call and every call after it (2026-09-20). The update listener
 * stays for an index without `settled`.
 */
export function followIndex(index: RemoteGraphIndex, source: { onChange(listener: () => void): () => void }, followMs = INDEX_FOLLOW_MS): IndexFollower {
    let pending = false
    let waiters: Array<() => void> = []
    const stopSource = source.onChange(() => {
        pending = true
    })
    const stopIndex = index.onUpdated(() => {
        pending = false
        const resolved = waiters
        waiters = []
        for (const resolve of resolved) resolve()
    })
    return {
        settled() {
            if (!pending) return Promise.resolve()
            return new Promise<void>((resolve) => {
                waiters.push(resolve)
                const timer = setTimeout(resolve, followMs)
                timer.unref?.()
                if (index.settled) {
                    void index.settled().then(() => {
                        pending = false
                        clearTimeout(timer)
                        resolve()
                    })
                }
            })
        },
        dispose() {
            stopSource()
            stopIndex()
        },
    }
}

export interface HeadlessGraph {
    readonly graphId: string
    /** What the agent is told it is connected to: the graph's name, or the folder's. */
    readonly name: string
    readonly store: HeadlessDocuments
    readonly index: RemoteGraphIndex
    /** The graph's assets behind the tools' seam; absent when the backend has no asset storage configured. */
    readonly assets?: HeadlessAssets
    /** Where the documents live, for `graph_info`: a synced graph on a server, or a folder. */
    readonly backend: HeadlessBackend
    /** What a publish reads: every document's materialised text, and the graph's own themes. */
    readonly publishing: HeadlessPublishing
    /** The graph's own themes, readable and writable. */
    readonly themes: HeadlessThemes
    /** Make every pending write durable - acknowledged by the relay, or on disk - and say if it is not. */
    settle(): Promise<SettleResult>
    /** Why the Sync Server ended access for good, or null while it has not; always null for a folder. */
    accessLoss(): SyncAccessLoss | null
    /** Write the cache and the index to `persistDir` now; a no-op without one. */
    persist(): Promise<void>
    /**
     * The graph's [[Semantic Search]], loading the model on the first call and keeping the
     * store current from then on. One instance per graph; a failed load is retried next call.
     */
    semantic(): Promise<SemanticIndex>
    /** The semantic index if a call has already opened it; never loads the model itself. */
    semanticOpened(): Promise<SemanticIndex | undefined>
    dispose(): Promise<void>
}

export type HeadlessBackend = { kind: 'synced'; server: string } | { kind: 'folder'; path: string }

/**
 * The publisher's view of a graph ([[2026-09-20 Headless Client Assets Rename And Publishing]]):
 * the same `PublishSource` the Client builds - cache-seeded, watermark-checked texts on a synced
 * graph, the folder's files on a folder - and the graph's [[Theme]]s. Nothing here holds a
 * [[Protection Key]]: a protected document's text arrives with its cipher fence still in it and
 * the publisher's selection excludes it.
 */
export interface HeadlessPublishing {
    readSource(): Promise<{ source: PublishSource; unsettled: string[] }>
    graphTheme(id: string): Promise<GraphTheme | null>
}

/**
 * The graph's own [[Theme]]s as the Theme editor writes them (ADR 0082): the root document's
 * `themes` map on a synced graph, `etherpk/theme-<id>.jsonc` files on a folder. Whole-theme
 * `put` for a copy or an import, `putFile` / `removeFile` for the editor's per-file save, so
 * two members editing different files of one theme both keep their edits.
 */
export interface HeadlessThemes {
    list(): Promise<GraphTheme[]>
    get(id: string): Promise<GraphTheme | null>
    put(theme: GraphTheme): Promise<void>
    putFile(id: string, path: string, text: string): Promise<void>
    removeFile(id: string, path: string): Promise<void>
    remove(id: string): Promise<void>
}

/** What a backend hands the shared assembly once its store and index are open. */
export interface HeadlessGraphParts {
    graphId: string
    name: string
    /** A synced graph's session reports why access ended; a folder has no such thing. */
    accessLoss?: () => SyncAccessLoss | null
    store: HeadlessDocuments
    index: RemoteGraphIndex
    assets?: HeadlessAssets
    backend: HeadlessBackend
    publishing: HeadlessPublishing
    themes: HeadlessThemes
    /** The on-disk index host, when the backend persists; absent means memory only. */
    indexHost?: NodeIndexHost
    persistDir?: string
    persistDebounceMs?: number
    embeddingModel?: () => Promise<EmbeddingModel>
    onSemanticProgress?: (status: SemanticStatus) => void
    onError?: (error: Error) => void
    /** Written before the index on every snapshot (persistence.ts → Ordering); the folder has none. */
    persistBackend?: () => Promise<void>
    /** Subscribe to changes that should schedule a snapshot; returns the unsubscribe. */
    onChange: (schedule: () => void) => () => void
    settle(schedulePersist: () => void): Promise<SettleResult>
    /** Release the backend's own resources, after the index and before the model. */
    disposeBackend(): Promise<void>
}

/**
 * The part of a headless graph that does not care where its documents come from: snapshots of
 * the index (and whatever the backend keeps beside it) off the tool's critical path, semantic
 * search opened on demand, and a dispose that takes a last snapshot.
 */
export function assembleHeadlessGraph(parts: HeadlessGraphParts): HeadlessGraph {
    const { index, indexHost } = parts

    // One snapshot at a time, backend before index (see persistence.ts → Ordering), and never
    // on the tool's own critical path: a write schedules one, shutdown takes one.
    let persisting: Promise<void> = Promise.resolve()
    let timer: ReturnType<typeof setTimeout> | undefined
    const persist = () => {
        if (!parts.persistDir || !indexHost) return persisting
        persisting = persisting
            .then(() => parts.persistBackend?.())
            .then(() => indexHost.export())
            .catch((error: unknown) => parts.onError?.(error instanceof Error ? error : new Error(String(error))))
        return persisting
    }
    const schedulePersist = () => {
        if (!parts.persistDir) return
        clearTimeout(timer)
        timer = setTimeout(() => void persist(), parts.persistDebounceMs ?? 5_000)
    }
    // Edits arriving while serving count too, or a quiet agent would leave a stale file.
    const unsubscribe = parts.onChange(schedulePersist)

    let lastBuildPersist = 0
    const persistDuringBuild = () => {
        if (Date.now() - lastBuildPersist >= BUILD_PERSIST_EVERY_MS) {
            lastBuildPersist = Date.now()
            void persist()
        } else schedulePersist()
    }

    let semanticOpening: Promise<SemanticIndex> | undefined
    let semanticModel: EmbeddingModel | undefined
    const semantic = (): Promise<SemanticIndex> => {
        if (semanticOpening) return semanticOpening
        semanticOpening = (async () => {
            if (!parts.embeddingModel) throw new Error('Semantic search is not available in this process: no embedding model was configured.')
            const model = await parts.embeddingModel()
            semanticModel = model
            const created = createSemanticIndex({
                index,
                model,
                onError: parts.onError,
                // Stored vectors are part of what the next launch resumes from, so they
                // reach the disk during the build, not only after it.
                onProgress: (status) => {
                    persistDuringBuild()
                    parts.onSemanticProgress?.(status)
                },
            })
            created.follow()
            return created
        })()
        semanticOpening.catch(() => {
            semanticOpening = undefined
        })
        return semanticOpening
    }

    return {
        graphId: parts.graphId,
        name: parts.name,
        store: parts.store,
        index,
        assets: parts.assets,
        backend: parts.backend,
        publishing: parts.publishing,
        themes: parts.themes,
        settle: () => parts.settle(schedulePersist),
        accessLoss: () => parts.accessLoss?.() ?? null,
        persist,
        semantic,
        semanticOpened: () => (semanticOpening ? semanticOpening.catch(() => undefined) : Promise.resolve(undefined)),
        async dispose() {
            clearTimeout(timer)
            unsubscribe()
            if (semanticOpening) await semanticOpening.then((s) => s.dispose()).catch(() => {})
            await persist()
            index.dispose()
            parts.assets?.store.dispose()
            await parts.disposeBackend()
            await semanticModel?.dispose?.()
        },
    }
}

/** Open a synced graph, scan its registry and build the index; resolves once tools can answer. */
export async function openHeadlessGraph(deps: HeadlessGraphDeps): Promise<HeadlessGraph> {
    const cache = await openGraphCache(deps.graphId)
    // The saved rows go into the (fresh, in-memory) database the line above just created, before
    // the engine seeds from it: what it then reads is what the last run left.
    if (deps.persistDir) await loadLocalCache(deps.persistDir, deps.graphId)
    const indexHost: NodeIndexHost | undefined = deps.persistDir ? nodeIndexHost(deps.persistDir) : undefined
    const sync = createGraphSync({
        graphId: deps.graphId,
        rootDocId: deps.rootDocId,
        keyring: deps.keyring,
        relayUrl: deps.relayUrl,
        token: deps.token,
        cache,
        connect: deps.connect ?? nodeTransport,
        // The agent's index covers the whole graph for as long as this runs, so every
        // document's live updates are wanted, not only the retained ones (graph-sync.ts).
        subscribeAll: true,
        // Same rule as the workspace: a document that reads as protected has its cache row
        // collected so the body it was protected to hide does not linger in the clear.
        collectRowWhen: (doc) => documentProtection(doc.getText('content').toString()).kind === 'document',
        // The agent's caret colour is whichever palette entry the session allocator leaves it;
        // the name is what members read.
        presence: { name: deps.presenceName, ...PRESENCE_PALETTE[0] },
        onError: deps.onError,
        onAccessLost: deps.onAccessLost,
        publishName: deps.publishName,
    })
    const store = createServerDocumentStore(sync, { readyTimeoutMs: deps.readyTimeoutMs })
    try {
        await store.scan()
        const index = createRemoteGraphIndex(store, inlineTransport(indexHost ?? memoryDbHost()), { graphId: deps.graphId })
        await index.prepare()
        await index.refresh()

        const follower = followIndex(index, store)
        const documents: HeadlessDocuments = {
            // The relay pushes every change live; there is nothing to fetch, only the index to let catch up.
            refresh: () => follower.settled(),
            listDocuments: () => store.listDocuments(),
            /**
             * The document's text from a live handle, after its relay catch-up has reached its
             * terminal page. A fresh process has an empty Local Cache, so a cache-seeded read
             * answers "" for every document until the relay has spoken; a tool must never
             * believe that emptiness.
             */
            async whenReady(concept) {
                await store.whenReady(concept)
                const wanted = conceptKey(concept)
                const identity = store.listIdentities().find((candidate) => conceptKey(candidate.concept) === wanted)
                if (!identity) return
                const caughtUp = sync.caughtUpDoc(identity.docId).then(() => 'ok' as const)
                const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), CATCH_UP_TIMEOUT_MS))
                await Promise.race([caughtUp, timeout])
            },
            // The body alone, as on a folder: an imported page keeps its block, and the store
            // writes identity back into one that exists (ADR 0061).
            open: (concept) => bodyView(store.open(concept)),
            openRaw: (concept) => store.open(concept),
            createJournal: (date, body) => store.createJournal(date, body),
            createPage: (title, body) => store.createPage(title, body),
            setAliases: (target, aliases) => store.setAliases(target, aliases),
            deleteDocument: (concept) => store.deleteDocument(concept),
            planRename: (from, to, referencingDocuments) => store.planRename(from, to, referencingDocuments),
            renamePage: (from, to, options) => store.renamePage(from, to, options),
            // Cache-seeded batches checked against the relay's watermarks, never `open()`: the
            // Local Mirror's read, which is what a pass over every document costs here.
            async readBodies() {
                const identities = store.listIdentities()
                const texts = await store.readTexts(identities.map((identity) => identity.docId))
                const bodies = new Map<string, string>()
                const unconfirmed: string[] = []
                for (const identity of identities) {
                    const read = texts.get(identity.docId)
                    if (!read || !read.settled) {
                        unconfirmed.push(identity.concept)
                        continue
                    }
                    if (documentProtection(read.text).kind === 'document') continue
                    bodies.set(identity.concept, bodyOf(read.text).body)
                }
                return { bodies, unconfirmed }
            },
        }

        // The encrypted asset store over the Sync Server's asset API, with the same token source
        // the relay uses; a test hands a store in instead. Sizes come from the server's blind
        // enumeration (ids and sizes are all it knows) and are matched to references by id.
        let assets: HeadlessAssets | undefined
        if (deps.assets) {
            const store = 'store' in deps.assets ? deps.assets.store : createServerAssetStore({ graphId: deps.graphId, keyring: deps.keyring, baseUrl: deps.assets.baseUrl, syncToken: deps.token, fetch: deps.assets.fetch })
            const listing = 'store' in deps.assets ? undefined : { baseUrl: deps.assets.baseUrl, fetch: deps.assets.fetch }
            assets = {
                store,
                identify: 'store' in deps.assets ? deps.assets.identify : assetIdFromRef,
                ...(listing
                    ? {
                          sizes: async () => {
                              const rows = await listServerAssets({ graph: sync, graphId: deps.graphId, baseUrl: listing.baseUrl, syncToken: deps.token, fetch: listing.fetch })
                              return new Map(rows.map((row) => [row.assetId, row.size]))
                          },
                      }
                    : {}),
                downloadsDir: join(deps.persistDir ?? join(tmpdir(), 'etherpk-mcp', deps.graphId), 'downloads'),
                uploaded: new Set(),
            }
        }

        return assembleHeadlessGraph({
            graphId: deps.graphId,
            name: sync.getMeta().name ?? deps.graphId,
            accessLoss: () => sync.accessLoss(),
            store: documents,
            index,
            assets,
            backend: { kind: 'synced', server: deps.relayUrl.replace(/^wss?:\/\//, '').replace(/\/.*$/, '') },
            publishing: {
                // The Local Mirror's read: identities from the registry, texts in cache-seeded
                // batches checked against the relay's watermarks, never `open()`.
                readSource: () =>
                    readPublishSource(
                        { listDocuments: () => store.listIdentities(), readTexts: (ids, progress) => store.readTexts(ids, { onProgress: progress }) },
                        assets?.store ?? null,
                    ),
                graphTheme: async (id) => sync.themes().get(id),
            },
            themes: {
                list: async () => sync.themes().list(),
                get: async (id) => sync.themes().get(id),
                put: async (theme) => sync.themes().put(theme),
                putFile: async (id, path, text) => sync.themes().putFile(id, path, text),
                removeFile: async (id, path) => sync.themes().removeFile(id, path),
                remove: async (id) => sync.themes().remove(id),
            },
            indexHost,
            persistDir: deps.persistDir,
            persistDebounceMs: deps.persistDebounceMs,
            embeddingModel: deps.embeddingModel,
            onSemanticProgress: deps.onSemanticProgress,
            onError: deps.onError,
            persistBackend: deps.persistDir ? () => persistLocalCache(deps.persistDir!, deps.graphId) : undefined,
            onChange: (schedule) => sync.onDocUpdate(schedule),
            async settle(schedulePersist) {
                await sync.flushAll()
                const result = await sync.awaitAcked({ stallMs: 10_000 })
                schedulePersist()
                if (result.settled) return { settled: true }
                // Refused is not "unreachable": the server answered no. Saying the edit will be
                // delivered when the connection recovers would send an agent to check a working
                // network, so the result names the refusal instead.
                if (result.refused) {
                    return {
                        settled: false,
                        outstanding: result.outstanding,
                        code: 'write_refused',
                        message: writeRefusalForAgent(result.refused, result.outstanding),
                    }
                }
                return {
                    settled: false,
                    outstanding: result.outstanding,
                    message: `The edit is saved locally but the Sync Server has not acknowledged it (${result.outstanding} outstanding). It will be delivered when the connection recovers.`,
                }
            },
            async disposeBackend() {
                follower.dispose()
                await store.dispose()
                cache.dispose()
            },
        })
    } catch (error) {
        await store.dispose().catch(() => {})
        cache.dispose()
        throw error
    }
}
