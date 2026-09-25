/**
 * A local graph folder, open in a process with no editor: the client's filesystem store over a
 * directory adapter, with the same derived index, persistence and semantic search a synced
 * graph gets from `assembleHeadlessGraph` ([[2026-09-18 Headless Client Serves A Local Folder]]).
 *
 * A folder has no relay, so the two things the relay gave the synced backend for free are done
 * here instead:
 *
 * - **Edits made outside this process.** `refresh()` runs the store's `reconcile()` - re-list
 *   the folder, re-read files whose stamp moved, follow renames - and then waits, bounded, for
 *   the index to absorb what it found, so a search right after an external edit sees it. Every
 *   tool calls it first; a watcher the caller supplies (`fs.watch` in the CLI) feeds the same
 *   pass between calls so the index does not go stale while the agent thinks.
 * - **Knowing a write is done.** The store autosaves on a debounce and reports a failed write
 *   through a callback rather than a rejection. `settle()` flushes every document a tool touched
 *   and turns a failure into the message the agent gets; the buffer keeps the edit, the store
 *   retries it on the next flush and at shutdown, and a read meanwhile shows the pending text.
 *   If the file then changes on disk before the retry succeeds, the disk copy wins and the lost
 *   edit is logged: it was already reported as not written.
 *
 * A local document's file opens with a frontmatter block that carries its identity (ADR 0061);
 * a synced document's text never does, because identity lives in the encrypted registry. The
 * tools get the same shape on both: `open()` here is a view of the body alone, with edit
 * offsets translated past the block, so a read shows the note and never its identity, an edit
 * cannot reach the `title`, and the line numbers the index reports (it strips the block too)
 * match the text the agent was given. The store rewrites the title on every save anyway.
 *
 * Nothing is written into the folder except the documents a tool writes. The index and the
 * embedding store live under `persistDir`, a directory the CLI keys by the folder's path.
 */

import { documentProtection } from '$lib/document/protection/cipher-fence'
import { createRemoteGraphIndex } from '$lib/document/index-worker/client'
import { inlineTransport, memoryDbHost } from '$lib/document/index-worker/transport'
import type { SemanticStatus } from '$lib/document/semantic/embedding-db'
import type { EmbeddingModel } from '$lib/document/semantic/embedding-model'
import { assetNameFromRef, createAssetStore } from '$lib/storage/fs/asset-store'
import { folderPublishReader, readPublishSource } from '$lib/document/publish/source'
import { deleteGraphTheme, readGraphThemes, writeGraphTheme } from '$lib/storage/fs/theme-files'
import type { DirectoryAdapter } from '$lib/storage/fs/directory-adapter'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFilesystemDocumentStore, type DocumentConflict } from '$lib/storage/fs/filesystem-store'
import { conceptKey } from '$lib/storage/fs/identity'
import { isDocumentFile } from '$lib/storage/fs/scan'
import { describeFilesystemSaveFailure } from '$lib/storage/fs/save-error-copy'

import { bodyView, type HeadlessDocuments } from './headless-documents'
import { assembleHeadlessGraph, followIndex, type HeadlessGraph } from './headless-graph'
import { nodeIndexHost, type NodeIndexHost } from './persistence'

export interface HeadlessFolderDeps {
    adapter: DirectoryAdapter
    /** What the agent is told it is connected to: the folder's basename, from the CLI. */
    name: string
    /** The index's identity; the CLI derives it from the folder's path. */
    graphId: string
    /** The folder's absolute path, for `graph_info`; the name when a test has no path. */
    path?: string
    /** Where the index and the embedding store are kept between launches; absent, memory only. */
    persistDir?: string
    persistDebounceMs?: number
    embeddingModel?: () => Promise<EmbeddingModel>
    onSemanticProgress?: (status: SemanticStatus) => void
    onError?: (error: Error) => void
    /** One line a person should see: a write that failed, an edit the disk copy won over. */
    onWarning?: (line: string) => void
    /**
     * Start watching the folder, calling `trigger` on any change; returns the stop function.
     * The CLI passes `fs.watch`; absent, only the per-call refresh keeps the view current.
     */
    watch?: (trigger: () => void) => () => void
    /** Quiet time after the last watcher event before the reconcile pass runs. */
    watchDebounceMs?: number
    /** How long `refresh()` waits for the index to absorb a change; see `followIndex`. */
    indexFollowMs?: number
}

const WATCH_DEBOUNCE_MS = 250

/** Open the folder, scan it and build the index; resolves once tools can answer. */
export async function openHeadlessFolder(deps: HeadlessFolderDeps): Promise<HeadlessGraph> {
    const warn = deps.onWarning ?? ((line: string) => console.error(`etherpk-mcp: ${line}`))
    /** The last failed write per document, until a flush of it is attempted again. */
    const saveErrors = new Map<string, unknown>()
    /** Conflicts raised during the reconcile pass in flight, resolved as soon as it returns. */
    let conflicts: DocumentConflict[] = []
    const store = createFilesystemDocumentStore(deps.adapter, {
        onConflict: (conflict) => conflicts.push(conflict),
        onSaveError: (concept, error) => saveErrors.set(conceptKey(concept), error),
    })
    const indexHost: NodeIndexHost | undefined = deps.persistDir ? nodeIndexHost(deps.persistDir) : undefined
    /**
     * The folder's listing as one string: every document file's name, mtime and size. A pass
     * first lists the two document subdirectories - a stat per file, no reads - and runs the
     * store's reconcile only when this differs from the last pass, so a pass before every
     * tool call on a large graph costs nothing when nothing moved. Only document files count:
     * a browser saving into the same folder writes a `.crswap` swap file first and renames it
     * over the document when the save lands, and a pass started by the swap file would read
     * the documents while that rename is due, which on Windows makes the browser's save fail.
     * An edit that keeps both mtime and size (an mtime-preserving copy) is missed until
     * something else changes, the same blind spot the store's own fast path accepts.
     */
    const listingSignature = async (): Promise<string> => {
        const parts: string[] = []
        for (const subdir of ['journals', 'pages'] as const) {
            for (const entry of await deps.adapter.list(subdir)) {
                if (!isDocumentFile(entry.name)) continue
                parts.push(`${subdir}/${entry.name}@${entry.lastModified}:${entry.size}`)
            }
        }
        return parts.sort().join('|')
    }
    let lastListing: string | undefined

    let stopWatching: (() => void) | undefined
    try {
        // Taken before the scan, so a file that changes while the scan runs differs from it and
        // gets picked up by the first pass rather than missed until the next change.
        lastListing = await listingSignature()
        await store.scan()
        const index = createRemoteGraphIndex(store, inlineTransport(indexHost ?? memoryDbHost()), { graphId: deps.graphId })
        await index.prepare()
        await index.refresh()

        const follower = followIndex(index, store, deps.indexFollowMs)

        /**
         * One reconcile pass: the store's own, then the conflicts it raised. A conflict here can
         * only be a dirty buffer whose write already failed and was reported, so the disk copy
         * wins and the person is told what was dropped. Passes never overlap: a request during
         * one runs another after it.
         */
        let reconciling: Promise<void> | undefined
        let rerun = false
        const reconcileNow = (): Promise<void> => {
            if (reconciling) {
                rerun = true
                return reconciling
            }
            reconciling = (async () => {
                const listing = await listingSignature()
                if (listing === lastListing) return
                lastListing = listing
                await store.reconcile()
                const raised = conflicts
                conflicts = []
                for (const conflict of raised) {
                    await store.resolveConflict(conflict.target, 'take-disk')
                    saveErrors.delete(conceptKey(conflict.target))
                    warn(`"${conflict.target}" changed on disk while an edit to it could not be written; took the file on disk and discarded the edit.`)
                }
            })()
            const pass = reconciling
            void pass.finally(() => {
                reconciling = undefined
                if (rerun) {
                    rerun = false
                    void reconcileNow()
                }
            })
            return pass
        }

        if (deps.watch) {
            let timer: ReturnType<typeof setTimeout> | undefined
            stopWatching = deps.watch(() => {
                clearTimeout(timer)
                timer = setTimeout(() => void reconcileNow(), deps.watchDebounceMs ?? WATCH_DEBOUNCE_MS)
            })
            const stop = stopWatching
            stopWatching = () => {
                clearTimeout(timer)
                stop()
            }
        }

        /** Documents a tool has opened since the last clean settle: the ones a flush must cover. */
        const touched = new Map<string, string>()
        const assetStore = createAssetStore(deps.adapter)

        const documents: HeadlessDocuments = {
            async refresh() {
                await reconcileNow()
                await follower.settled()
            },
            listDocuments: () => store.listDocuments(),
            whenReady: (concept) => store.whenReady(concept),
            open(concept) {
                touched.set(conceptKey(concept), concept)
                return bodyView(store.open(concept))
            },
            openRaw(concept) {
                touched.set(conceptKey(concept), concept)
                return store.open(concept)
            },
            createJournal: (date, body) => store.createJournal(date, body),
            createPage: (title, body) => store.createPage(title, body),
            // Written through the open buffer when there is one, so flushed at once: a rescan in
            // between would rebuild the registry from the file and lose the alias until the
            // autosave landed, and no tool call leaves unsaved work behind (see settle).
            async setAliases(target, aliases) {
                await store.setAliases(target, aliases)
                await store.flushDocument(target)
            },
            deleteDocument: (concept) => store.deleteDocument(concept),
            planRename: (from, to, referencingDocuments) => store.planRename(from, to, referencingDocuments),
            // The store rewrites an open document through its buffer and the rest on disk; the
            // buffers are flushed here so the rename is on disk when the tool returns, as every
            // other write is (see settle).
            async renamePage(from, to, options) {
                const result = await store.renamePage(from, to, options)
                for (const concept of [result.concept, ...result.rewrittenDocuments]) await store.flushDocument(concept)
                return result
            },
            // The files are the truth and a read is a disk read, so every body is confirmed.
            async readBodies() {
                const bodies = new Map<string, string>()
                for (const doc of store.listDocuments()) {
                    await store.whenReady(doc.concept)
                    const text = bodyView(store.open(doc.concept)).getText()
                    if (documentProtection(text).kind === 'document') continue
                    bodies.set(doc.concept, text)
                }
                return { bodies, unconfirmed: [] }
            },
        }

        return assembleHeadlessGraph({
            graphId: deps.graphId,
            name: deps.name,
            store: documents,
            index,
            backend: { kind: 'folder', path: deps.path ?? deps.name },
            publishing: {
                // The folder's files, read once per publish, as the Client reads a folder graph.
                readSource: async () => readPublishSource(await folderPublishReader(deps.adapter).read(), assetStore),
                graphTheme: async (id) => (await readGraphThemes(deps.adapter)).find((theme) => theme.id === id) ?? null,
            },
            // One file per theme, read fresh each time: the folder is the truth and an editor may
            // have written it since. A per-file save rewrites the theme's file whole, as the
            // Client's folder persistence does.
            themes: {
                list: () => readGraphThemes(deps.adapter),
                get: async (id) => (await readGraphThemes(deps.adapter)).find((theme) => theme.id === id) ?? null,
                put: (theme) => writeGraphTheme(deps.adapter, theme),
                async putFile(id, path, text) {
                    const existing = (await readGraphThemes(deps.adapter)).find((theme) => theme.id === id)
                    await writeGraphTheme(deps.adapter, { ...(existing ?? { id, name: id, files: {} }), files: { ...(existing?.files ?? {}), [path]: text }, updatedAt: new Date().toISOString() })
                },
                async removeFile(id, path) {
                    const existing = (await readGraphThemes(deps.adapter)).find((theme) => theme.id === id)
                    if (!existing) return
                    const files = { ...existing.files }
                    delete files[path]
                    await writeGraphTheme(deps.adapter, { ...existing, files, updatedAt: new Date().toISOString() })
                },
                remove: (id) => deleteGraphTheme(deps.adapter, id),
            },
            // The folder's own `assets/`, through the same store the browser uses over it:
            // content-hashed names, dedup by content, the reference the markdown embeds.
            assets: {
                store: assetStore,
                identify: assetNameFromRef,
                sizes: async () => new Map((await deps.adapter.list('assets')).map((entry) => [entry.name, entry.size])),
                downloadsDir: join(deps.persistDir ?? join(tmpdir(), 'etherpk-mcp', deps.graphId), 'downloads'),
                uploaded: new Set(),
            },
            indexHost,
            persistDir: deps.persistDir,
            persistDebounceMs: deps.persistDebounceMs,
            embeddingModel: deps.embeddingModel,
            onSemanticProgress: deps.onSemanticProgress,
            onError: deps.onError,
            onChange: (schedule) => store.onChange(() => schedule()),
            async settle(schedulePersist) {
                const failures: string[] = []
                for (const [key, concept] of touched) {
                    saveErrors.delete(key)
                    await store.flushDocument(concept)
                    const error = saveErrors.get(key)
                    if (error === undefined) {
                        touched.delete(key)
                        continue
                    }
                    failures.push(describeFilesystemSaveFailure(error, concept))
                }
                schedulePersist()
                if (failures.length === 0) return { settled: true }
                const message = `${failures.join(' ')} The edit is kept in memory, shows in a read of the document, and is retried on the next write and at shutdown.`
                warn(message)
                return { settled: false, outstanding: failures.length, message }
            },
            async disposeBackend() {
                stopWatching?.()
                follower.dispose()
                await store.dispose()
            },
        })
    } catch (error) {
        stopWatching?.()
        await store.dispose().catch(() => {})
        throw error
    }
}
