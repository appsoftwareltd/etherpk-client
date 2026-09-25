/**
 * ServerDocumentStore (plan Phase 3 Task 6): the DocumentStore seam over the E2EE sync
 * engine. Mirrors FilesystemDocumentStore's surface so every workspace consumer (tree,
 * backlink index, journal, DocumentView) is unchanged — but text lives in a Yjs Y.Text
 * per document, and identity/title/date live ONLY in the encrypted graph-root registry
 * (ADR 0024), never on the server as plaintext.
 */
import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { dayIsNotAPageName, isJournalConcept } from '$lib/document/journal-concept'
import { normaliseAliases, withFrontmatterIdentity } from '$lib/document/frontmatter/identity'
import { parseFrontmatter } from '$lib/storage/fs/frontmatter'
import { frontmatterSpan } from '$lib/storage/fs/frontmatter-span'
import { conceptKey } from '$lib/storage/fs/identity'
import type { DocumentEntry } from '$lib/storage/fs/scan'
import {
    type ChangeOrigin,
    DocumentNotFoundError,
    DocumentSyncDegradedError,
    type EditorDocument,
    type TextChange,
} from '$lib/document/types'
import { includeFactsOf } from '$lib/document/publish/publication'
import type { IndexDocSnapshot } from '$lib/storage/fs/filesystem-store'
import type {
    IndexChangeCheckpoint,
    IndexSnapshotOptions,
    StoreChangeListener,
} from '$lib/document/backlinks/live-index'
import { createBreather } from '$lib/activity/breathe'
import type { GraphSync, RegistryEntry } from '$lib/sync/graph-sync'
import { REMOTE, SUPPRESSED, type SyncHealth } from '$lib/sync/doc-sync'
import { type TextSplice, countWikilinkTargets, wikilinkScopeSplices } from '$lib/document/wikilink/rename'
import { documentProtection } from '$lib/document/protection/cipher-fence'
import { mergeDocuments } from '../merge'
import { planRename, refuseProtectedMerges } from '../rename-plan'
import { type RenameOptions, type RenamePlan, type RenameResult, RenameUnconfirmedError, mergeCount, renameSteps } from '../rename'

export interface ServerDocumentStoreOptions {
    /** Bounded wait (ms) for an initial relay connection in scan(). */
    readyTimeoutMs?: number
    /**
     * A document deleted elsewhere was brought back by a local edit (ADR 0039 §4). The
     * workspace tells the editor, because a document silently returning is inexplicable to
     * whoever deleted it.
     */
    onResurrected?: (concept: string) => void
}

/**
 * One document's identity keyed by the id that survives a rename. The [[Local Mirror]] needs the
 * id rather than the concept: a concurrent creation race can leave two registry entries with the
 * same title or date, and a concept alone can neither tell them apart nor keep their files stable.
 */
export interface DocumentIdentity {
    docId: string
    kind: RegistryEntry['kind']
    concept: string
    aliases: string[]
}

/** A document's full text, and whether it can be trusted as the document's settled content. */
export interface DocumentText {
    text: string
    /**
     * False when the text may not be the document's real content - its history has not arrived,
     * its key is missing, or its ciphertext will not open. A consumer that writes somewhere
     * durable must skip it rather than record an empty document.
     */
    settled: boolean
}

/** Structural mirror of FilesystemDocumentStore (documented in document/types.ts). */
export interface ServerDocumentStore {
    open(target: string): EditorDocument
    /**
     * Resolves when a document has seeded from the Local Cache and, for a cold empty seed,
     * applied its first relay page. This is enough to present content; full historical
     * reconciliation continues independently to its terminal page.
     */
    whenReady(target: string): Promise<void>
    /** The collab buffer for a target — DocumentView mounts y-codemirror over it. */
    getYText(target: string): Y.Text | undefined
    /** The per-doc presence handle for a target — remote cursors (ADR 0024). */
    getAwareness(target: string): Awareness | undefined
    /** Retain relay content and presence while a real view consumes this document. */
    retainDocument(target: string): () => void
    scan(): Promise<void>
    listDocuments(): DocumentEntry[]
    /** Every document's identity, keyed by document id ({@link DocumentIdentity}). */
    listIdentities(): DocumentIdentity[]
    /**
     * Full materialized text for documents nobody has open, in bounded batches seeded from the
     * [[Local Cache]] and retired again - never through {@link open}, which starts a live editing
     * engine per document and keeps it for the session.
     *
     * A cached row is believed only when the relay's watermark says it is current (one bounded
     * metadata request per 512 documents): a document edited elsewhere while this tab was not
     * showing it, and so not subscribed to it, gets a bounded relay catch-up first. An empty
     * seed is a cache miss as often as it is an empty document, and gets the same catch-up
     * before its emptiness is believed. Whatever is still unconfirmed comes back with
     * `settled: false`; offline, the cache is believed as it stands.
     */
    readTexts(
        docIds: readonly string[],
        options?: { timeoutMs?: number; onProgress?: (done: number, total: number) => void },
    ): Promise<Map<string, DocumentText>>
    /**
     * Resolves true once the encrypted registry has been confirmed against the server this
     * session. Anything that deletes on the strength of "not in the registry" has to wait for
     * this: offline, the registry can be a partial cached one.
     */
    confirmRegistry(timeoutMs?: number): Promise<boolean>
    onDocumentsChanged(listener: () => void): () => void
    onDocumentRemoved(listener: (target: string) => void): () => void
    onChange(listener: StoreChangeListener): () => void
    snapshotForIndex(): Promise<IndexDocSnapshot[]>
    streamForIndex(options?: IndexSnapshotOptions): Promise<{
        total: number
        batches: AsyncIterable<readonly IndexDocSnapshot[]>
    }>
    /** Start bounded relay catch-up for every indexed document after a warm reopen. */
    catchUpPersistedIndex(): Promise<void>
    /** Durable Local Cache boundaries not yet represented by a committed index operation. */
    pendingIndexChanges(): Promise<IndexChangeCheckpoint>
    /** One document's index snapshot, for a listener that knows which one changed. */
    snapshotDocument(concept: string): IndexDocSnapshot | null
    reconcile(): Promise<void>
    resolveConflict(target: string, choice: 'keep-mine' | 'take-disk'): Promise<void>
    /**
     * Create the [[Journal Entry]] for `date` (a `YYYY-MM-DD` day), seeded with `body`.
     * The day is the identity here too - it is the registry entry, not a title (ADR 0056).
     */
    createJournal(date: string, body?: string): Promise<string>
    /** `body` seeds the new document's content, so a promoting [[Draft]] needs no second write (ADR 0050). */
    createPage(title: string, body?: string): Promise<string>
    /** What a rename would do, before anything is written (ADR 0038 §1) — the dialog's preview. */
    planRename(from: string, to: string, referencingDocuments?: number): Promise<RenamePlan>
    /** Apply a rename: the document, its scoped concepts, and any merges (ADR 0037, 0038). */
    renamePage(from: string, to: string, options: RenameOptions): Promise<RenameResult>
    /** Delete a document. Immediate and irreversible (ADR 0039). */
    deleteDocument(concept: string): Promise<void>
    /**
     * Drop deleted content from a document's Local Cache row. After protecting a document the
     * row otherwise keeps the pre-protection body for the document's lifetime, readable from
     * the profile directory with no key. The live document collects on its own (the write
     * runs under an untracked origin); the row is what has to be told.
     */
    compactDocument(target: string): Promise<void>
    /**
     * Upload a consolidated encrypted [[Snapshot]] of a document to the relay now, instead of
     * waiting for the idle trigger, and read it back to verify it (ADR 0025, amended). Nothing
     * in the app calls this on a timer; it is the manual and e2e handle on compaction.
     */
    uploadSnapshot(target: string): Promise<void>
    /**
     * Set a document's aliases (ADR 0061): the registry entry, then the block if the text carries
     * one. Normalised: trimmed, unique, never the document's own name.
     */
    setAliases(target: string, aliases: readonly string[]): Promise<void>
    dispose(): Promise<void>
}

function conceptOf(entry: RegistryEntry): string {
    return entry.kind === 'journal' ? (entry.date ?? '') : (entry.title ?? '')
}

/**
 * Whether `promise` settled within `timeoutMs`. A sync milestone that never arrives (offline, a
 * silent server) is a bounded wait and a `false`, never a hang and never an unhandled rejection:
 * the caller decides what an unreached milestone means.
 */
async function reachedWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            promise.then(
                () => true,
                () => false,
            ),
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), timeoutMs)
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

/** Health that says the bytes are not this document's, so neither text nor emptiness is real. */
function contentBlocked(health: SyncHealth): boolean {
    return health === 'key-unavailable' || health === 'ciphertext-corrupt'
}

export function createServerDocumentStore(
    graph: GraphSync,
    options: ServerDocumentStoreOptions,
): ServerDocumentStore {
    const registry = graph.registry()
    /** Engines created between yields while snapshotting — small enough to keep frames free. */
    const ENGINE_BATCH = 100
    /** Longest a cold-empty document holds its loading state waiting for first catchup. */
    const COLD_CONTENT_TIMEOUT_MS = 15000
    const breathe = createBreather()

    const changeListeners = new Set<StoreChangeListener>()
    const docsChangedListeners = new Set<() => void>()
    const removedListeners = new Set<(target: string) => void>()
    const resurrectionClaims = new Map<string, RegistryEntry>()
    let disposed = false
    /** Whether the encrypted registry has been read to its terminal relay page this session. */
    let registryConfirmed = false

    /**
     * Bring documents to text this device can trust and KEEP their engines live until
     * `release()`, for a caller that is about to write through them. `readTexts` retires each
     * batch as it reads it, which is right for a copy and wrong for a rename: an engine created
     * again afterwards seeds from the cache asynchronously and reads as empty in between, which
     * is exactly how a rewrite came to skip every document nobody had open.
     *
     * The rule is `readTexts`'s: a cached row is believed when the relay's watermark says it is
     * current; a row the relay has moved past, and an empty seed (a cache miss as often as an
     * empty document), wait for a bounded catch-up. Offline there is no relay to ask, so the
     * cache is believed as it stands and only an empty seed is unconfirmed. Whatever could not
     * be confirmed is named, and the caller decides - a rename refuses on any.
     */
    async function materialise(docIds: readonly string[], timeoutMs: number): Promise<{ unconfirmed: string[]; release(): void }> {
        const unique = [...new Set(docIds)]
        const release = () => graph.retireDocs(unique)
        try {
            for (let start = 0; start < unique.length; start += ENGINE_BATCH) {
                await graph.readyDocs(unique.slice(start, start + ENGINE_BATCH))
            }
            const connected = graph.isConnected()
            const behind = new Set(connected ? await graph.docsNeedingCatchup(unique) : [])
            const unconfirmed: string[] = []
            const waits: Promise<void>[] = []
            for (const docId of unique) {
                const engine = graph.docSync(docId)
                const empty = engine.doc.getText('content').length === 0
                if (contentBlocked(engine.health())) {
                    unconfirmed.push(docId)
                    continue
                }
                if (!behind.has(docId) && !empty) continue
                if (!connected) {
                    // Behind is unknowable offline; an empty seed is the one case that stays unproven.
                    unconfirmed.push(docId)
                    continue
                }
                waits.push(
                    reachedWithin(graph.caughtUpDoc(docId), timeoutMs).then((reached) => {
                        if (!reached || contentBlocked(graph.docSync(docId).health())) unconfirmed.push(docId)
                    }),
                )
            }
            await Promise.all(waits)
            return { unconfirmed, release }
        } catch (error) {
            release()
            throw error
        }
    }

    interface RegistryIdentity {
        kind: RegistryEntry['kind']
        concept: string
        aliases: string[]
    }

    function currentRegistryIdentities(): Map<string, RegistryIdentity> {
        const out = new Map<string, RegistryIdentity>()
        registry.forEach((entry, docId) => {
            out.set(docId, {
                kind: entry.kind,
                concept: conceptOf(entry),
                // Alias order has no meaning in lookup or in the derived index. Normalising
                // here prevents a CRDT replay with reordered aliases from becoming an
                // unnamed full-index replacement.
                aliases: [...(entry.aliases ?? [])].sort((left, right) =>
                    left.localeCompare(right),
                ),
            })
        })
        return out
    }

    function sameIdentity(
        before: RegistryIdentity | undefined,
        after: RegistryIdentity | undefined,
    ): boolean {
        if (!before || !after) return before === after
        return (
            before.kind === after.kind &&
            before.concept === after.concept &&
            before.aliases.length === after.aliases.length &&
            before.aliases.every((alias, index) => alias === after.aliases[index])
        )
    }

    // key → concept, so a removal can report the CONCEPT (what a View is keyed by), not the
    // lower-cased key. The filesystem store reports the concept; consumers should not have to
    // know which backend they are talking to.
    let known = currentConcepts()
    let docIdsByConcept = currentDocIds()
    let knownRegistry = currentRegistryIdentities()

    function currentConcepts(): Map<string, string> {
        const out = new Map<string, string>()
        registry.forEach((entry) => {
            const concept = conceptOf(entry)
            out.set(conceptKey(concept), concept)
        })
        return out
    }

    function currentDocIds(): Map<string, string> {
        const out = new Map<string, string>()
        registry.forEach((entry, docId) => {
            out.set(conceptKey(conceptOf(entry)), docId)
            for (const alias of entry.aliases ?? []) out.set(conceptKey(alias), docId)
        })
        return out
    }

    // Registry membership → onDocumentsChanged (+ removals). A pure addition names the
    // exact concept so the index can ingest one document. Deletes, renames and mixed
    // transactions still require a replacement because they can remove several identities.
    const unobserveRegistry = (() => {
        const handler = (event: Y.YMapEvent<RegistryEntry>) => {
            const nextRegistry = currentRegistryIdentities()
            const changedDocIds = [...new Set([...knownRegistry.keys(), ...nextRegistry.keys()])]
                .filter((docId) => !sameIdentity(knownRegistry.get(docId), nextRegistry.get(docId)))
            // Yjs can replay a different CRDT struct which resolves to the same JSON value.
            // On graph reopen that is restored state, not a rename or membership change.
            // Emitting an unnamed index change here made every new tab walk the full graph.
            if (changedDocIds.length === 0) return

            const additions: string[] = []
            let additionsOnly = true
            for (const docId of changedDocIds) {
                const before = knownRegistry.get(docId)
                const after = nextRegistry.get(docId)
                if (before || !after) {
                    additionsOnly = false
                    continue
                }
                additions.push(after.concept)
            }
            const next = currentConcepts()
            for (const [key, concept] of known) {
                if (!next.has(key)) removedListeners.forEach((l) => l(concept))
            }
            known = next
            docIdsByConcept = currentDocIds()
            knownRegistry = nextRegistry
            docsChangedListeners.forEach((l) => l())
            if (additionsOnly) {
                for (const concept of additions) {
                    changeListeners.forEach((listener) => listener({ concept }))
                }
            } else {
                changeListeners.forEach((listener) => listener())
            }
            for (const [docId, change] of event.changes.keys) {
                if (change.action !== 'delete') continue
                const claimed = resurrectionClaims.get(docId)
                if (!claimed) continue
                queueMicrotask(() => {
                    if (registry.has(docId)) return
                    registry.set(docId, claimed)
                    resurrectionClaims.delete(docId)
                    options.onResurrected?.(conceptOf(claimed))
                })
            }
        }
        registry.observe(handler)
        return () => registry.unobserve(handler)
    })()

    // Document *content* changes (Y.Text edits, local or remote) are also onChange — this is
    // what keeps the derived index and the Local Mirror current on edits, not just on
    // add/remove. (The registry itself is one of these docs; its handler above still runs.)
    //
    // The changed document is NAMED. Discarding it here is what made one keystroke mean
    // "everything changed", and cost a full re-index of the graph (~3.9s at 2431 documents).
    // A listener that can act on one document should; one that cannot ignores the argument.
    const unobserveDocUpdates = graph.onDocUpdate((docId) => {
        // The root document contains registry and graph metadata. Its registry observer above
        // has better information, while metadata does not affect the document index at all.
        // Forwarding the root update as unnamed turned every page creation into a full rebuild.
        if (graph.docSync(docId).doc === graph.rootDoc) return
        const entry = entryFor(docId)
        const change = entry ? { concept: conceptOf(entry) } : undefined
        changeListeners.forEach((l) => l(change))
    })

    /** Find the registry docId whose concept matches `target` (case-insensitive). */
    function docIdFor(target: string): string | undefined {
        return docIdsByConcept.get(conceptKey(target))
    }

    /**
     * What the [[Derived Index]] derives over: the body below any [[Frontmatter]], as a Filesystem
     * Backend hands it (ADR 0061). The block is opaque to the index everywhere, so a wikilink
     * written up there makes no backlink on either backend - and line numbers it records stay
     * body-relative, which is what the reveal offset expects.
     */
    function bodyForIndex(text: string): string {
        return parseFrontmatter(text).body
    }

    /**
     * One document's index snapshot. Aliases come from the registry, not the block (ADR 0061);
     * the include facts a publication page declares have no registry home, so they are read
     * from the block here, as the Filesystem Backend reads them.
     */
    function indexSnapshotFor(entry: RegistryEntry, text: string): IndexDocSnapshot {
        const concept = conceptOf(entry)
        const includes = entry.kind === 'page' ? includeFactsOf({ concept, kind: entry.kind, text, aliases: [] }) : []
        return {
            concept,
            kind: entry.kind,
            aliases: entry.aliases ?? [],
            text: bodyForIndex(text),
            ...(includes.length > 0 ? { includes } : {}),
        }
    }

    /**
     * Bring a block the text carries in line with the registry (ADR 0061). Part of the action that
     * changed the registry - a rename, an alias change - and never a reaction to one arriving: if
     * every member's device rewrote the block on seeing the registry move, the CRDT would merge N
     * identical concurrent edits into duplicated text. Adds no block to a document without one. A
     * journal's title is its date, so only its aliases are mirrored.
     */
    function writeBackIdentity(docId: string): void {
        const entry = registry.get(docId)
        if (!entry) return
        const ytext = graph.docSync(docId).doc.getText('content')
        const text = ytext.toString()
        const next = withFrontmatterIdentity(text, {
            ...(entry.kind === 'page' ? { title: conceptOf(entry) } : {}),
            aliases: entry.aliases ?? [],
        })
        if (next === text) return
        // Only the block is replaced: the body is verbatim in `next`, and a whole-document rewrite
        // would be a whole-document edit for every other member to receive.
        const before = frontmatterSpan(text)?.end ?? 0
        const after = frontmatterSpan(next)?.end ?? 0
        ytext.doc!.transact(() => {
            if (before > 0) ytext.delete(0, before)
            ytext.insert(0, next.slice(0, after))
        }, STORE)
    }

    function entryFor(docId: string): RegistryEntry | undefined {
        return registry.get(docId)
    }

    /**
     * An edit outranks a delete (ADR 0039 §4), watched on the Y.Text rather than on
     * `applyChange`.
     *
     * On this backend the editor binds the Y.Text **directly** (yCollab), so `applyChange` is
     * never called for a Server-backed document - the resurrection check living only there
     * made the rule unreachable in the app while passing its unit tests. Reading the local
     * edit off the CRDT catches every way a document can be typed into.
     *
     * `registry` lives in the ROOT document and the Y.Text in the document's own, so writing
     * one from the other's observer is not re-entrant.
     */
    const resurrectors = new Map<string, () => void>()

    /**
     * The origin the store stamps on its OWN structural writes, so they are never mistaken for
     * a user's edit. Without it the deleter resurrected its own delete: `deleteDocument` drops
     * the registry entry and then clears the Y.Text, and that clear is a local content change
     * to a document with no entry - which is precisely the shape of a resurrection.
     */
    const STORE = Symbol('etherpk-store-write')

    function watchForResurrection(docId: string, openedAs: RegistryEntry | undefined): void {
        if (!openedAs || resurrectors.has(docId)) return
        const ytext = graph.docSync(docId).doc.getText('content')
        const handler = (_e: Y.YTextEvent, tx: Y.Transaction) => {
            if (tx.origin === REMOTE) return // someone else's edit asserts nothing on our behalf
            if (tx.origin === STORE) return // our own delete/merge, not a user asserting anything
            if (tx.origin === SUPPRESSED) return // ordered lifecycle clear, not an edit
            const lifecycle = graph.docSync(docId).lifecycle()
            if (lifecycle === 'deleted' || lifecycle === 'resurrecting') {
                resurrectionClaims.set(docId, openedAs)
            }
            if (registry.has(docId)) return
            registry.set(docId, openedAs)
            resurrectionClaims.delete(docId)
            options.onResurrected?.(conceptOf(openedAs))
        }
        ytext.observe(handler)
        resurrectors.set(docId, () => ytext.unobserve(handler))
    }

    return {
        open(target: string): EditorDocument {
            const docId = docIdFor(target)
            if (!docId) throw new DocumentNotFoundError(target)
            const ytext = graph.docSync(docId).doc.getText('content')
            // The entry as it was when opened, so a resurrection restores THIS document -
            // a journal comes back a journal, keeping its aliases - rather than a bare page.
            const openedAs = registry.get(docId)
            watchForResurrection(docId, openedAs)
            return {
                id: target,
                getText: () => ytext.toString(),
                applyChange(change: TextChange, origin: ChangeOrigin = 'editor') {
                    // An edit outranks a delete (ADR 0039 §4): if the entry has gone while
                    // this document was open, typing in it asserts that it should exist.
                    if (openedAs && !registry.has(docId)) {
                        registry.set(docId, openedAs)
                        resurrectionClaims.delete(docId)
                        options.onResurrected?.(conceptOf(openedAs))
                    }
                    // Local edit → mutate the Y.Text (NOT REMOTE) so the engine sees it as
                    // local and syncs it. Never notifies our subscribers. An EXTERNAL write -
                    // protecting the document is one - goes under the store's own origin, which
                    // the collaborative editor's undo manager does not track: under the default
                    // origin it would pin the deleted plaintext against garbage collection, and
                    // every state this document is ever serialised to would carry the body it
                    // was protected to hide.
                    ytext.doc!.transact(
                        () => {
                            if (change.to > change.from) ytext.delete(change.from, change.to - change.from)
                            if (change.insert) ytext.insert(change.from, change.insert)
                        },
                        origin === 'external' ? STORE : undefined,
                    )
                },
                subscribe(listener: (text: string) => void) {
                    // External/remote edits only: fire on REMOTE-origin changes.
                    const handler = (_e: Y.YTextEvent, tx: Y.Transaction) => {
                        if (tx.origin === REMOTE) listener(ytext.toString())
                    }
                    ytext.observe(handler)
                    return () => ytext.unobserve(handler)
                },
            }
        },
        getYText(target: string): Y.Text | undefined {
            const docId = docIdFor(target)
            return docId ? graph.docSync(docId).doc.getText('content') : undefined
        },
        async whenReady(target: string): Promise<void> {
            const docId = docIdFor(target)
            if (!docId) return
            await graph.whenReady(docId)
            // A cold cache seeds EMPTY — a miss, not content — while the real text is
            // still in flight over the wire. Resolving here dropped the loading overlay
            // onto 4.5s of blank editor (measured live, 2400-doc cold open). Hold until
            // the first catch-up page has applied; capped so an offline or silent server
            // leaves an editable empty document rather than an eternal spinner.
            if (graph.docSync(docId).doc.getText('content').length === 0 && graph.isConnected()) {
                await Promise.race([
                    graph.firstCatchupPageDoc(docId),
                    new Promise((resolve) => setTimeout(resolve, COLD_CONTENT_TIMEOUT_MS)),
                ])
                if (graph.docSync(docId).doc.getText('content').length === 0) {
                    // Caught up (or timed out) and STILL empty: either a genuinely empty
                    // document, or its history never arrived / never decrypted — the
                    // doc-sync skip counter warning says which. Name it either way.
                    console.warn(`[sync] "${target}" has no content after catchup — empty doc, or its history was skipped`)
                }
            }
            const health = graph.docSync(docId).health()
            // Only states that genuinely block content fail the open. A sequence gap or a
            // stale generation is a routine self-healing moment. The engine has already
            // requested catch-up when it sets them, and surfacing it as "opened without
            // its cached content" put a false failure banner on every open document while
            // busy peers kept the relay head moving (live, 2026-07-30).
            if (health === 'key-unavailable' || health === 'ciphertext-corrupt') {
                throw new DocumentSyncDegradedError(target, health)
            }
        },
        getAwareness(target: string): Awareness | undefined {
            const docId = docIdFor(target)
            return docId ? graph.docSync(docId).awareness : undefined
        },
        retainDocument(target: string): () => void {
            const docId = docIdFor(target)
            return docId ? graph.retainDoc(docId) : () => {}
        },
        async scan(): Promise<void> {
            // Seed the cached registry first. A cold offline open remains bounded, but once
            // connected we must consume the ROOT doc's terminal relay page before anything
            // identity-sensitive reads it. The first page can be a partial registry.
            await graph.ready()
            const reachedRelay =
                graph.isConnected() ||
                (await new Promise<boolean>((resolve) => {
                    let settled = false
                    const finish = (connected: boolean) => {
                        if (settled) return
                        settled = true
                        clearTimeout(timer)
                        resolve(connected)
                    }
                    const timer = setTimeout(
                        () => finish(false),
                        Math.max(0, options.readyTimeoutMs ?? 2000),
                    )
                    void graph.connected().then(() => finish(true))
                }))
            if (reachedRelay) {
                await graph.rootCaughtUp()
                registryConfirmed = true
            }
            known = currentConcepts()
            docIdsByConcept = currentDocIds()
            knownRegistry = currentRegistryIdentities()
        },
        listDocuments(): DocumentEntry[] {
            const journals: DocumentEntry[] = []
            const pages: DocumentEntry[] = []
            registry.forEach((entry, docId) => {
                const concept = conceptOf(entry)
                const doc: DocumentEntry = {
                    kind: entry.kind,
                    concept,
                    key: conceptKey(concept),
                    // Server docs are not files; fabricate fs-shaped fields the tree ignores.
                    subdir: entry.kind === 'journal' ? 'journals' : 'pages',
                    fileName: docId,
                    aliases: entry.aliases ?? [],
                    lastModified: 0,
            // No file behind a server document; the Filesystem Backend's (mtime, size) fast path
            // needs the field on every DocumentEntry, and zero is as honest as the mtime above.
            size: 0,
                }
                ;(entry.kind === 'journal' ? journals : pages).push(doc)
            })
            journals.sort((a, b) => b.concept.localeCompare(a.concept)) // date-desc
            pages.sort((a, b) => a.concept.localeCompare(b.concept)) // alpha
            return [...journals, ...pages]
        },
        listIdentities(): DocumentIdentity[] {
            const out: DocumentIdentity[] = []
            registry.forEach((entry, docId) => {
                out.push({
                    docId,
                    kind: entry.kind,
                    concept: conceptOf(entry),
                    aliases: [...(entry.aliases ?? [])],
                })
            })
            return out
        },
        async readTexts(docIds, readOptions): Promise<Map<string, DocumentText>> {
            const out = new Map<string, DocumentText>()
            const timeoutMs = readOptions?.timeoutMs ?? COLD_CONTENT_TIMEOUT_MS
            // Reported against the whole request, not the batch: a caller showing this to a
            // person is answering "how much of my graph is read", not "how far into batch 14".
            const report = () => readOptions?.onProgress?.(out.size, docIds.length)
            const read = (docId: string): { text: string; blocked: boolean } => ({
                text: graph.docSync(docId).doc.getText('content').toString(),
                blocked: contentBlocked(graph.docSync(docId).health()),
            })

            // The relay pushes live updates only for the documents this tab is showing, so the
            // cached row of a document nobody here has open is as old as this device's last look
            // at it: a page edited elsewhere (another device, the Headless Client) while this tab
            // was open would otherwise be believed from that row and published or mirrored as it
            // was. The watermark diff is what a warm reopen runs for the index - one bounded
            // metadata request per 512 documents, and only a document whose sequence moved is
            // materialised - so a graph where nothing changed still pays for no catch-up.
            // Offline there is no relay to ask, and the cache is the best this device has.
            const behind = new Set(graph.isConnected() ? await graph.docsNeedingCatchup(docIds) : [])
            const catchUp: string[] = []

            // Cache-only batches, retired as they are consumed: the cost of a mirror pass must
            // not scale with live engines the way opening every document does.
            for (let start = 0; start < docIds.length; start += ENGINE_BATCH) {
                if (disposed) break
                const batch = docIds.slice(start, start + ENGINE_BATCH)
                try {
                    await graph.seedDocsFromCache(batch)
                    for (const docId of batch) {
                        const { text, blocked } = read(docId)
                        const stale = behind.has(docId)
                        out.set(docId, { text, settled: !blocked && text.length > 0 && !stale })
                        if (!blocked && (text.length === 0 || stale)) catchUp.push(docId)
                    }
                } finally {
                    graph.retireDocs(batch)
                }
                report()
                await breathe()
            }

            // An empty seed is a cache miss as often as it is an empty document - the whole of
            // the mirror's "every page arrived without its body" bug - and a row the relay has
            // moved past is stale by definition. Only these pay for a relay catch-up.
            if (!graph.isConnected()) return out
            for (let start = 0; start < catchUp.length; start += ENGINE_BATCH) {
                if (disposed) break
                const batch = catchUp.slice(start, start + ENGINE_BATCH)
                try {
                    await graph.readyDocs(batch)
                    await Promise.all(
                        batch.map(async (docId) => {
                            const reached = await reachedWithin(graph.caughtUpDoc(docId), timeoutMs)
                            const { text, blocked } = read(docId)
                            // At the terminal page the text is current whatever it holds. Short
                            // of it, an empty seed that now has text has at least its first page,
                            // which is better than an empty file; a document known to be behind
                            // is still behind, and saying so is what keeps its stale text off a
                            // website or out of a folder.
                            const current = reached || (text.length > 0 && !behind.has(docId))
                            out.set(docId, { text, settled: !blocked && current })
                        }),
                    )
                } finally {
                    graph.retireDocs(batch)
                }
                await breathe()
            }
            return out
        },
        async confirmRegistry(timeoutMs = 5000): Promise<boolean> {
            if (registryConfirmed) return true
            if (!graph.isConnected()) return false
            if (await reachedWithin(graph.rootCaughtUp(), timeoutMs)) registryConfirmed = true
            return registryConfirmed
        },
        onDocumentsChanged(listener) {
            docsChangedListeners.add(listener)
            return () => docsChangedListeners.delete(listener)
        },
        onDocumentRemoved(listener) {
            removedListeners.add(listener)
            return () => removedListeners.delete(listener)
        },
        onChange(listener) {
            changeListeners.add(listener)
            return () => changeListeners.delete(listener)
        },
        async snapshotForIndex(options?: IndexSnapshotOptions): Promise<IndexDocSnapshot[]> {
            const snapshots: IndexDocSnapshot[] = []
            const stream = await this.streamForIndex(options)
            for await (const batch of stream.batches) snapshots.push(...batch)
            return snapshots
        },
        async streamForIndex(options?: IndexSnapshotOptions) {
            const entries: Array<[string, RegistryEntry]> = []
            registry.forEach((entry, docId) => entries.push([docId, entry]))
            return {
                total: entries.length,
                batches: (async function* () {
                    for (let start = 0; start < entries.length; start += ENGINE_BATCH) {
                        const batch = entries.slice(start, start + ENGINE_BATCH)
                        const docIds = batch.map(([docId]) => docId)
                        try {
                            const docs = await graph.seedDocsFromCache(docIds)
                            const snapshots = batch.map(([_docId, entry], index) =>
                                indexSnapshotFor(entry, docs[index].getText('content').toString()),
                            )
                            options?.onProgress?.({
                                phase: 'loading',
                                done: Math.min(start + batch.length, entries.length),
                                total: entries.length,
                            })
                            yield snapshots
                        } finally {
                            graph.retireDocs(docIds)
                        }
                        await breathe()
                    }
                })(),
            }
        },
        async catchUpPersistedIndex() {
            const docIds: string[] = []
            registry.forEach((_entry, docId) => docIds.push(docId))
            // One bounded metadata request per 512 documents replaces one catch-up request
            // per document. A warm 2,400-document graph therefore asks the relay five cheap
            // questions and only materialises documents whose sequence actually changed.
            const staleDocIds = await graph.docsNeedingCatchup(docIds)
            for (let start = 0; start < staleDocIds.length; start += ENGINE_BATCH) {
                if (disposed) return
                const batch = staleDocIds.slice(start, start + ENGINE_BATCH)
                try {
                    await graph.readyDocs(batch)
                    // Catch-up is serialized by GraphSync. Waiting for each terminal page
                    // keeps the graph-scoped cross-tab lock until the complete history has
                    // advanced the shared cache, while bounding live Y.Docs to one batch.
                    // If the browser starts offline, these promises stay pending and the
                    // batch remains alive until the socket eventually opens. Graph disposal
                    // releases the waits, so leaving an offline workspace cannot leak it.
                    await Promise.all(batch.map((docId) => graph.caughtUpDoc(docId)))
                } finally {
                    graph.retireDocs(batch)
                }
                if (disposed) return
                await breathe()
            }
        },
        async pendingIndexChanges() {
            const checkpoint = await graph.pendingIndexChanges()
            const root = new Y.Doc()
            try {
                if (checkpoint.rootUpdate) Y.applyUpdate(root, checkpoint.rootUpdate)
            } catch (error) {
                root.destroy()
                throw error
            }
            const checkpointRegistry = root.getMap<RegistryEntry>('registry')
            const entries: Array<[string, RegistryEntry]> = []
            checkpointRegistry.forEach((entry, docId) => entries.push([docId, entry]))
            root.destroy()
            const entriesByDocId = new Map(entries)

            const snapshot = async (
                docId: string,
                entry: RegistryEntry,
            ): Promise<IndexDocSnapshot> => {
                const update = await checkpoint.readDocument(docId)
                const doc = new Y.Doc()
                try {
                    if (update) Y.applyUpdate(doc, update)
                    return indexSnapshotFor(entry, doc.getText('content').toString())
                } finally {
                    doc.destroy()
                }
            }

            const checkpointStream: NonNullable<IndexChangeCheckpoint['streamForIndex']> =
                async (snapshotOptions) => ({
                    total: entries.length,
                    batches: (async function* () {
                        for (let start = 0; start < entries.length; start += ENGINE_BATCH) {
                            const batch = entries.slice(start, start + ENGINE_BATCH)
                            const snapshots = await Promise.all(
                                batch.map(([docId, entry]) => snapshot(docId, entry)),
                            )
                            snapshotOptions?.onProgress?.({
                                phase: 'loading',
                                done: Math.min(start + batch.length, entries.length),
                                total: entries.length,
                            })
                            yield snapshots
                            await breathe()
                        }
                    })(),
                })

            const concepts = new Map<string, string>()
            const documents: IndexDocSnapshot[] = []
            let requiresFullReplacement = false
            for (const docId of checkpoint.docIds) {
                const entry = entriesByDocId.get(docId)
                if (!entry) {
                    // The root document owns graph identity, aliases and membership. A
                    // removed content document is also absent here. Either shape can remove
                    // index rows, so a targeted upsert is insufficient.
                    requiresFullReplacement = true
                    break
                }
                const concept = conceptOf(entry)
                concepts.set(conceptKey(concept), concept)
                documents.push(await snapshot(docId, entry))
            }
            return {
                changes: requiresFullReplacement
                    ? null
                    : [...concepts.values()].map((concept) => ({ concept })),
                documents,
                streamForIndex: checkpointStream,
                acknowledge: checkpoint.acknowledge,
            }
        },
        snapshotDocument(concept: string): IndexDocSnapshot | null {
            const docId = docIdFor(concept)
            const entry = docId ? registry.get(docId) : undefined
            if (!docId || !entry) return null
            return indexSnapshotFor(entry, graph.docSync(docId).doc.getText('content').toString())
        },

        async compactDocument(target: string): Promise<void> {
            const docId = docIdFor(target)
            if (docId) await graph.compactDoc(docId)
        },

        async uploadSnapshot(target: string): Promise<void> {
            const docId = docIdFor(target)
            if (docId) await graph.uploadSnapshot(docId)
        },

        async setAliases(target: string, aliases: readonly string[]): Promise<void> {
            const docId = docIdFor(target)
            const entry = docId ? registry.get(docId) : undefined
            if (!docId || !entry) throw new DocumentNotFoundError(target)
            const next = normaliseAliases(aliases, conceptOf(entry))
            const updated: RegistryEntry = { ...entry }
            if (next.length > 0) updated.aliases = next
            else delete updated.aliases
            registry.set(docId, updated)
            writeBackIdentity(docId)
        },
        // CRDTs merge — there is nothing to reconcile or resolve.
        async reconcile() {},
        async resolveConflict() {},
        async createJournal(date: string, body = ''): Promise<string> {
            const day = date.trim()
            if (!isJournalConcept(day)) throw new Error(`"${date}" is not a calendar day.`)
            if (docIdFor(day)) throw new Error(`A document for "${day}" already exists`)
            const docId = crypto.randomUUID()
            registry.set(docId, { kind: 'journal', date: day } satisfies RegistryEntry)
            // Seeded in the same breath as the registry entry, exactly as createPage does, so a
            // promoting [[Draft]] never writes twice (ADR 0050).
            if (body !== '') {
                const ytext = graph.docSync(docId).doc.getText('content')
                ytext.doc!.transact(() => ytext.insert(0, body))
            }
            return day
        },
        async createPage(title: string, body = ''): Promise<string> {
            // Refused, never redirected to createJournal: a page registered under a day mirrors
            // and exports to `pages/`, and a caller that means the day calls createJournal itself.
            if (isJournalConcept(title)) throw new Error(dayIsNotAPageName(title))
            if (docIdFor(title)) throw new Error(`A page for "${title}" already exists`)
            const docId = crypto.randomUUID()
            registry.set(docId, { kind: 'page', title } satisfies RegistryEntry)
            // Seed the content in the same breath as the registry entry, so a promoting
            // [[Draft]] never has to write twice (ADR 0050). A local-origin insert, exactly
            // as a keystroke would be, so the sync engine carries it like any other edit.
            if (body !== '') {
                const ytext = graph.docSync(docId).doc.getText('content')
                ytext.doc!.transact(() => ytext.insert(0, body))
            }
            return title
        },

        async planRename(from: string, to: string, referencingDocuments?: number): Promise<RenamePlan> {
            // No entry is not a refusal: a [[Pageless Concept]] renames by rewriting its links,
            // and the plan says so through a null kind (ADR 0064).
            const docId = docIdFor(from)
            const entry = docId ? registry.get(docId) : undefined

            // Counting here materialises every Y.Doc in the graph. The caller usually has the
            // figure already (the backlink index knows it); the slow path stays for those that
            // do not.
            let counted = 0
            const concepts: string[] = []
            const aliases: { name: string; concept: string }[] = []
            registry.forEach((e, id) => {
                concepts.push(conceptOf(e))
                for (const alias of e.aliases ?? []) aliases.push({ name: alias, concept: conceptOf(e) })
                if (referencingDocuments !== undefined) return
                const text = graph.docSync(id).doc.getText('content').toString()
                if (countWikilinkTargets(text, from) > 0) counted += 1
            })
            const plan = planRename({
                from,
                to,
                kind: entry?.kind ?? null,
                concepts,
                aliases,
                referencingDocuments: referencingDocuments ?? counted,
            })
            // A Protected Document never merges (ADR 0062). Read from the live document, which
            // is what a merge would join.
            return refuseProtectedMerges(plan, (concept) => {
                const id = docIdFor(concept)
                if (!id) return false
                return documentProtection(graph.docSync(id).doc.getText('content').toString()).kind === 'document'
            })
        },

        /**
         * Apply a rename plan (ADR 0038). A server document's identity lives ONLY in the
         * encrypted registry (ADR 0024), so a rename is a registry write - there is no
         * frontmatter here, which is why the alias strategy keeps the old name in the registry
         * entry rather than in the document body - and a [[Merge]] is a content write into the
         * surviving doc plus dropping the absorbed entry. A step with no document behind it
         * (a [[Pageless Concept]], ADR 0064) is only the body pass below.
         */
        async renamePage(from: string, to: string, options: RenameOptions): Promise<RenameResult> {
            // Re-plan rather than trust the dialog's preview - the graph may have moved. Only
            // the preview reads the reference count, so the apply path does not pay for it.
            const plan = await this.planRename(from, to, 0)
            if (plan.refusal) throw new Error(plan.refusal)

            // Every document this rename reads has to be current before anything is written:
            // the steps' own documents (a merge joins two texts, and an unseeded one is empty),
            // and under the rewrite arm the referencing documents. The caller's index says
            // which those are; without a list every document is read, at the cost of a pass
            // over the graph. An engine created here stays live until the passes below are
            // done - `readTexts` retires as it goes, which is why it is not used here (ADR 0038,
            // note of 2026-09-20).
            const wanted = new Set<string>()
            for (const step of renameSteps(plan)) {
                for (const concept of [step.from, step.into]) {
                    const id = docIdFor(concept)
                    if (id) wanted.add(id)
                }
            }
            if (options.strategy === 'rewrite') {
                if (options.referencing) {
                    for (const concept of options.referencing) {
                        const id = docIdFor(concept)
                        if (id) wanted.add(id)
                    }
                } else {
                    registry.forEach((_entry, id) => wanted.add(id))
                }
            }
            const materialised = await materialise([...wanted], options.timeoutMs ?? COLD_CONTENT_TIMEOUT_MS)
            try {
                if (materialised.unconfirmed.length > 0) {
                    const names = materialised.unconfirmed.map((id) => {
                        const entry = registry.get(id)
                        return entry ? conceptOf(entry) : id
                    })
                    throw new RenameUnconfirmedError(names)
                }
                return applyRename(plan, options, [...wanted])
            } finally {
                materialised.release()
            }
        },

        /**
         * Delete a document (ADR 0039): the registry entry goes AND the stored content is
         * removed server-side, so [[Storage Footprint]] drops immediately rather than waiting
         * on compaction.
         */
        async deleteDocument(concept: string): Promise<void> {
            const docId = docIdFor(concept)
            if (!docId) return // already gone; deleting twice is not an error
            // The ordered content lifecycle transition is durable before the encrypted root
            // registry changes. A delayed old-generation append can no longer recreate rows.
            await graph.deleteDoc(docId)
            // Dropping the entry is what fires onDocumentRemoved. The registry is encrypted
            // client content, so it remains a separate convergent operation.
            registry.delete(docId)
        },

        async dispose() {
            disposed = true
            unobserveRegistry()
            unobserveDocUpdates()
            for (const stop of resurrectors.values()) stop()
            resurrectors.clear()
            await graph.flushAll()
            graph.dispose()
        },
    }

    /**
     * The writes of a rename, over documents `renamePage` has already brought current and
     * holds live: the registry steps, then the body pass over `readable` (ADR 0038).
     */
    function applyRename(plan: RenamePlan, options: RenameOptions, readable: readonly string[]): RenameResult {
        for (const step of renameSteps(plan)) {
            const docId = docIdFor(step.from)
            if (!docId) continue // a pageless concept; only its links move (ADR 0064)
            const entry = registry.get(docId)
            if (!entry) continue

            let aliases = Array.isArray(entry.aliases) ? entry.aliases : []
            if (options.strategy === 'alias' && !aliases.some((a) => conceptKey(a) === conceptKey(step.from))) {
                // Every renamed document keeps its old name, cascaded ones included.
                aliases = [...aliases, step.from]
            }

            // The document that answers to the name - by title or alias (docIdFor resolves
            // both) - is the survivor, and keeps its own title (`step.into`).
            const targetId = step.merges ? docIdFor(step.into) : undefined
            if (targetId && targetId !== docId) {
                const survivor = graph.docSync(targetId).doc.getText('content')
                const absorbed = graph.docSync(docId).doc.getText('content')
                const survivorEntry = registry.get(targetId)
                // The absorbed document's block, if it has one, is identity the registry
                // already carries - its aliases union below, its title is the name being
                // vacated. As body text it would sit as a second `---` block inside the
                // survivor, so only what is below it is joined (as on a Filesystem Backend).
                const absorbedText = absorbed.toString()
                const absorbedBody = absorbedText.slice(frontmatterSpan(absorbedText)?.end ?? 0)
                const merged = mergeDocuments(
                    { body: survivor.toString(), aliases: survivorEntry?.aliases ?? [] },
                    { body: absorbedBody, aliases },
                )
                survivor.doc!.transact(() => {
                    survivor.delete(0, survivor.length)
                    survivor.insert(0, merged.body)
                }, STORE)
                registry.set(targetId, {
                    ...(survivorEntry ?? { kind: entry.kind }),
                    title: step.into,
                    ...(merged.aliases.length > 0 ? { aliases: merged.aliases } : {}),
                })
                // The absorbed document's entry goes; its content is now in the survivor.
                registry.delete(docId)
                writeBackIdentity(targetId)
                continue
            }

            // A page renamed onto one of its own aliases: the alias becomes the title and
            // is no longer an alias.
            const next: RegistryEntry = { ...entry, title: step.to }
            const kept = normaliseAliases(aliases, step.to)
            if (kept.length > 0) next.aliases = kept
            else delete next.aliases
            registry.set(docId, next)
            writeBackIdentity(docId)
        }

        // Bodies last, in one pass: the cascade rule fixes plain and scoped references
        // together. Each document is its own CRDT transaction — there is none spanning them
        // — and within a document the rewrite is a set of per-occurrence splices, never a
        // whole-text replace (ADR 0066): a delete-all would not cover anything typed
        // concurrently by a Player or another device, which then survived and was re-seated
        // at the start of the document. Applied back-to-front so earlier offsets stay valid.
        // Only the documents brought current above are read: the caller's index said which
        // reference the concept, and a document that was not read is not silently skipped
        // but simply not in the set - the fallback without an index read every document.
        let rewritten = 0
        const rewrittenDocuments: string[] = []
        if (options.strategy === 'rewrite') {
            const edits: { id: string; splices: TextSplice[] }[] = []
            for (const id of readable) {
                // A step above may have merged this document away.
                if (!registry.get(id)) continue
                const ytext = graph.docSync(id).doc.getText('content')
                // The body only, as on a Filesystem Backend: a block's title is the
                // write-back's to set, and anything else up there is not a reference.
                const text = ytext.toString()
                const prefix = frontmatterSpan(text)?.end ?? 0
                const splices = wikilinkScopeSplices(text.slice(prefix), plan.direct.from, plan.direct.to).map(
                    (s) => ({ ...s, from: s.from + prefix, to: s.to + prefix }),
                )
                if (splices.length > 0) edits.push({ id, splices })
            }
            for (const edit of edits) {
                const ytext = graph.docSync(edit.id).doc.getText('content')
                ytext.doc!.transact(() => {
                    for (let i = edit.splices.length - 1; i >= 0; i--) {
                        const splice = edit.splices[i]
                        ytext.delete(splice.from, splice.to - splice.from)
                        ytext.insert(splice.from, splice.insert)
                    }
                }, STORE)
                rewritten += 1
                const entry = registry.get(edit.id)
                rewrittenDocuments.push(entry ? conceptOf(entry) : edit.id)
            }
        }

        return { concept: plan.direct.into, rewritten, rewrittenDocuments, cascaded: plan.cascade.length, merged: mergeCount(plan) }
    }
}
