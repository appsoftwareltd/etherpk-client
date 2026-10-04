/**
 * A {@link DocumentStore} over a real directory (via a {@link DirectoryAdapter}):
 * the Filesystem Backend. The files *are* the state — this holds only a live
 * buffer per open document plus a derived registry, and reconciles external
 * changes (git checkout, Syncthing) the way DESIGN.md → The git workflow requires.
 *
 * Assembled entirely from the pure pieces (scan, identity, reconcileDecision,
 * debounce) so it is exercised in Node over createMemoryDirectoryAdapter before
 * any browser code exists.
 *
 * Async-seam note: the seam's
 * `getText()` is synchronous but disk reads are async, so `open()` returns a
 * handle whose buffer is empty on first open and is hydrated by an internal
 * awaited read that then notifies subscribers the *external* way — which is safe
 * because DocumentView registers its `subscribe` listener in the same synchronous
 * onMount tick as its `getText()` seed, before the read resolves.
 */


import type { StoreChange, StoreChangeListener } from '$lib/document/backlinks/live-index'
import { frontmatterIdentity, normaliseAliases, sameAliases, withFrontmatterIdentity } from '$lib/document/frontmatter/identity'
import { renderFrontmatter } from '$lib/document/frontmatter/frontmatter-yaml'
import type { IndexIncludeFact } from '$lib/document/index-db'
import { type IndexProperty, propertiesOf } from '$lib/document/properties'
import { includeFactsOf } from '$lib/document/publish/publication'
import { dayIsNotAPageName, isJournalConcept } from '$lib/document/journal-concept'
import { lineFeedsOnly } from '$lib/document/line-endings'
import { type TextSplice, countWikilinkTargets, rewriteWikilinkScope, wikilinkScopeSplices } from '$lib/document/wikilink/rename'
import { frontmatterSpan } from './frontmatter-span'
import {
    DocumentNotFoundError,
    type DocumentStore,
    type EditorDocument,
    type SpliceOutcome,
    type TextChange,
} from '$lib/document/types'
import { documentProtection } from '$lib/document/protection/cipher-fence'
import { containsCipherFence } from '$lib/document/protection/fence-info'
import { portableFileName, suffixedFileName } from '../file-names'
import { mergeDocuments } from '../merge'
import { aliasesAfterRename, planRename, refuseProtectedMerges, refuseUnreadableBlocks, unreadableBlockRefusal } from '../rename-plan'
import {
    type AliasRewrite,
    type RenameLinkStrategy,
    type RenameOptions,
    type RenamePlan,
    type RenameResult,
    type RenameStep,
    landedName,
    mergeCount,
    renameSteps,
} from '../rename'

import type { DirectoryAdapter, Subdir } from './directory-adapter'
import { type Debounced, debounce } from './debounce'
import { parseFrontmatter } from './frontmatter'
import { type DocumentKind, aliasesOf, conceptKey, fileStem } from './identity'
import { reconcileDecision } from './reconcile'
import { type DocumentEntry, scanGraph } from './scan'
import { type RegistryChanges, registryChanges } from './registry-changes'

/** One document as fed to the backlink index: identity, aliases, and body. */
export interface IndexDocSnapshot {
    concept: string
    kind: DocumentKind
    aliases: string[]
    /** The document body (frontmatter stripped). */
    text: string
    /** The includes this document declares as a publication page (ADR 0082); absent otherwise. */
    includes?: IndexIncludeFact[]
    /** Its [[Property]]s for Property Filters (ADR 0107); absent when the block sets none. */
    properties?: IndexProperty[]
}

/**
 * The snapshot for one document's full text: identity from the registry, aliases and include
 * facts from the frontmatter, the body for the index. Both backends build theirs this way, so
 * the index sees one shape whatever holds the document.
 */
export function indexSnapshotOf(identity: { concept: string; kind: DocumentKind }, text: string): IndexDocSnapshot {
    const fm = parseFrontmatter(text)
    const includes = identity.kind === 'page' ? includeFactsOf({ concept: identity.concept, kind: identity.kind, text, aliases: [] }) : []
    const properties = propertiesOf(fm.data)
    return {
        concept: identity.concept,
        kind: identity.kind,
        aliases: aliasesOf(fm),
        text: fm.body,
        ...(includes.length > 0 ? { includes } : {}),
        ...(properties.length > 0 ? { properties } : {}),
    }
}

/** A pending external-edit-under-dirty-buffer, surfaced to the UI for resolution. */
export interface DocumentConflict {
    target: string
    diskText: string
    bufferText: string
}

export interface FilesystemDocumentStoreOptions {
    /** Autosave debounce window (ms). */
    autosaveMs?: number
    /** Invoked when reconciliation finds an external edit under a dirty buffer. */
    onConflict?: (conflict: DocumentConflict) => void
    /**
     * A document that had gone was brought back by a local edit (ADR 0039 §4) - deleted in
     * the app, or removed on disk by something else. The caller tells the editor, because a
     * document quietly returning explains nothing to whoever removed it.
     */
    onResurrected?: (concept: string) => void
    /**
     * A write to `concept`'s file failed - the disk is full, the folder's permission lapsed, the
     * file is locked by another program - or the file could not be read when the document was
     * opened, so its buffer must not be written over it. The buffer keeps the edits and stays
     * dirty; nothing retries on a timer (a full disk should not be hammered). `flushDocument`
     * retries on demand, the next keystroke's autosave retries, and `dispose` makes a last
     * attempt. Tell the user, or the edits leave with the tab. `describeFilesystemSaveFailure`
     * (`fs/save-error-copy.ts`) turns the error into the sentence to show.
     */
    onSaveError?: (concept: string, error: unknown) => void
}

export interface FilesystemDocumentStore extends DocumentStore {
    /**
     * Resolves once the document's text has been read from disk. `open()` hands back a handle
     * whose buffer is empty until the asynchronous read lands, so anything that reads a
     * document nobody has opened yet - the [[Tasks View]] ticking a row whose document is in no
     * editor - must wait here first, or it reads an empty document. The Server store has always
     * had this; this store owed it under the DocumentStore contract and did not implement it,
     * which is why such a tick was refused as "stale" and wrote nothing.
     */
    whenReady(target: string): Promise<void>
    /**
     * Write a document's dirty buffer now and wait for every write in flight. For a write that
     * must not sit in the debounce window - protecting a document, which the UI reports as done
     * the moment the fence is in the buffer, while the file on disk would stay plaintext until
     * the timer fired - and the retry path for a write that failed (`onSaveError`). Resolves
     * whether or not the write succeeds; a failure is reported again through `onSaveError`.
     * A no-op for a document that is not open or has nothing to write.
     */
    flushDocument(target: string): Promise<void>
    /**
     * `flushDocument` for every open document: every dirty buffer written now. For a check that
     * reads the folder rather than the buffers - the [[Orphaned Asset]] scan - which must not
     * miss a reference still inside the autosave debounce. Rejects, naming them, when a buffer is
     * still dirty afterwards (its write failed), so such a check fails rather than believe the
     * folder.
     */
    flushAll(): Promise<void>
    /** Build the registry from disk at graph open: every file is read and its identity learnt. */
    scan(): Promise<void>
    /** Current registry snapshot (journals date-desc, then pages alpha). */
    listDocuments(): DocumentEntry[]
    /** Subscribe to registry changes (add / remove / create). Returns an unsubscribe. */
    onDocumentsChanged(listener: () => void): () => void
    /** Subscribe to a document vanishing on disk. Returns an unsubscribe. */
    onDocumentRemoved(listener: (target: string) => void): () => void
    /**
     * Subscribe to an open document following its file to a new name. A `title` edited outside
     * the app is a rename that already happened (ADR 0061): the rescan re-keys the file, and the
     * open document is re-keyed to match rather than declared removed. Returns an unsubscribe.
     */
    onDocumentRenamed(listener: (from: string, to: string) => void): () => void
    /**
     * Set a document's aliases (ADR 0061). The block is rewritten - through the open buffer if
     * there is one, so its editor sees it, else on disk - and the registry follows at once rather
     * than at the next scan. Normalised: trimmed, unique, never the document's own name.
     */
    setAliases(target: string, aliases: readonly string[]): Promise<void>
    /**
     * A document's whole text as this store holds it, frontmatter included: an open document's
     * buffer (line feeds only, ADR 0112), else its file. Null when no document has that name.
     * What a [[Formatting Scan]] reads, since a fix to an open document goes through its buffer.
     */
    documentText(target: string): Promise<string | null>
    /**
     * Write `splices` into a document only if it holds exactly `expected`, the text
     * {@link documentText} gave a [[Formatting Scan]] (ADR 0109). The splices are in `expected`'s
     * offsets. An open document is fixed through its buffer, as external changes its editor is
     * told of, and saved before this resolves; its file is read first, so an edit made outside
     * the app is followed rather than saved over. A closed document is read, compared and
     * written. A failed save is reported through `onSaveError`, as for any edit.
     */
    spliceIfUnchanged(target: string, expected: string, splices: readonly TextSplice[]): Promise<SpliceOutcome>
    /**
     * Subscribe to any change that could affect derived state — registry changes
     * *and* content saves / reloads (a superset of {@link onDocumentsChanged}).
     * The [[Derived Index]] re-derives on this. Returns an unsubscribe.
     *
     * A change this store made itself — a save, a reload it adopted, a resolved conflict —
     * is **named**: `{ concept }`. The index then re-derives that one document. Unnamed
     * changes (a registry rescan: files added, removed or renamed) mean "re-verify
     * everything", and they used to be the only kind, which made every autosave a
     * whole-graph re-derivation. External edits made while the graph is open are
     * deliberately NOT chased by scanning: they are caught for open documents by
     * `reconcile()` (which names them), and for everything else at the next open, which
     * fully re-verifies a filesystem graph (ADR 0041 §6). A stale row until then is the
     * accepted price of not re-reading the graph per keystroke.
     */
    onChange(listener: StoreChangeListener): () => void
    /** Read every document's body + aliases, for (re)building the backlink index. */
    snapshotForIndex(): Promise<IndexDocSnapshot[]>
    /**
     * One document as the index wants it — the live buffer if it is open (what was just
     * saved, or is about to be), else the file — or null if the graph has no such document.
     * What lets a named change cost one document instead of the graph.
     */
    snapshotDocument(concept: string): Promise<IndexDocSnapshot | null>
    streamForIndex(): Promise<{
        total: number
        batches: AsyncIterable<readonly IndexDocSnapshot[]>
    }>
    /**
     * Follow disk: rescan the registry, reading only files whose mtime or size moved; then
     * re-read open documents that moved, reloading clean ones and raising a conflict for dirty
     * ones. A document with a write in flight is judged after the write settles.
     */
    reconcile(): Promise<void>
    /** Resolve a raised conflict by keeping the buffer or taking the disk copy. */
    resolveConflict(target: string, choice: 'keep-mine' | 'take-disk'): Promise<void>
    /**
     * Create the [[Journal Entry]] for `date` (a `YYYY-MM-DD` day), seeded with `body`.
     *
     * A journal entry carries no frontmatter — its identity is its filename, not a `title` — so
     * the body is the whole file, and a promoting [[Draft]]'s caret never moves (ADR 0056).
     */
    createJournal(date: string, body?: string): Promise<string>
    /**
     * Create a new page from a title; returns its concept. Rejects on a case-insensitive
     * collision. `body` seeds the document's content in the SAME write, which is what lets a
     * [[Draft]] promote without a second, racing write against an asynchronously hydrating
     * buffer (ADR 0050).
     */
    createPage(title: string, body?: string): Promise<string>
    /** What a rename would do, before anything is written (ADR 0038 §1) — the dialog's preview. */
    planRename(from: string, to: string, referencingDocuments?: number): Promise<RenamePlan>
    /** Apply a rename: the document, its scoped concepts, and any merges (ADR 0037, 0038). */
    renamePage(from: string, to: string, options: RenameOptions): Promise<RenameResult>
    /** Delete a document. Immediate and irreversible (ADR 0039). */
    deleteDocument(concept: string): Promise<void>
    /** Write every dirty buffer (a failed write included), wait for the writes, release resources. */
    dispose(): Promise<void>
}

interface OpenDoc {
    key: string
    target: string
    subdir: Subdir
    fileName: string
    buffer: string
    baseText: string
    /** The file's mtime and byte size when the buffer last synced with it (open, save, reload). */
    lastModified: number
    size: number
    dirty: boolean
    /**
     * The buffer reflects the file (or its absence). False while the hydration read is in
     * flight, and after it failed on a file that exists - then the buffer is a stand-in for
     * content never seen and must not be written over the file (`loadError` says why).
     */
    loaded: boolean
    loadError: unknown
    /** Settles once the hydration read has landed (or failed). What `whenReady` waits on. */
    ready: Promise<void>
    removed: boolean
    /**
     * Removed by this store's own delete, the user's: its tab closes, so only a handle a view
     * already holds still reaches it (an edit there brings it back, ADR 0039 §4). Opened afresh,
     * its name has no document until a file has it again.
     */
    deletedHere: boolean
    conflict: DocumentConflict | null
    listeners: Set<(text: string) => void>
    save: Debounced<[]>
    /** The write in flight, if any. Never rejects: a failed write lands in `saveError`. */
    saving: Promise<void> | null
    /** A write was wanted while one was in flight: run again with the latest buffer once it settles. */
    queued: boolean
    /** Why the last write failed, until one succeeds. `dirty` stays true meanwhile. */
    saveError: unknown
    handle: EditorDocument
}

function applyTextChange(text: string, change: TextChange): string {
    return text.slice(0, change.from) + change.insert + text.slice(change.to)
}

/** A signature of the registry's membership + (mtime, size) stamps, to fire change events only on real change. */
function registrySignature(entries: DocumentEntry[]): string {
    return entries.map((e) => `${e.key}@${e.lastModified}:${e.size}`).join('|')
}

export function createFilesystemDocumentStore(
    adapter: DirectoryAdapter,
    options: FilesystemDocumentStoreOptions = {},
): FilesystemDocumentStore {
    const { autosaveMs = 400, onConflict } = options

    const registry = new Map<string, DocumentEntry>()
    let registrySig = ''
    /**
     * The registry as the last rescan announced it, what the next one's changes are measured
     * against. Not `registry` itself: a rename's steps patch that in place before the closing
     * rescan, which would then find nothing moved. The same entry objects, so a save's stamps,
     * kept in step on its entry, are never mistaken for an edit made outside the app.
     */
    let announced: ReadonlyMap<string, DocumentEntry> = new Map()
    const open = new Map<string, OpenDoc>()
    const documentsChanged = new Set<() => void>()
    const documentRemoved = new Set<(target: string) => void>()
    const documentRenamed = new Set<(from: string, to: string) => void>()
    const changed = new Set<StoreChangeListener>()

    function snapshotEntries(): DocumentEntry[] {
        return [...registry.values()]
    }

    /** Named when this store knows which document moved; unnamed means re-verify everything. */
    function emitChange(change?: StoreChange): void {
        for (const listener of changed) listener(change)
    }

    /** The concept an open document answers to, as the registry spells it. */
    function conceptOf(doc: OpenDoc): string {
        return registry.get(doc.key)?.concept ?? doc.target
    }

    /**
     * Tell listeners what a rescan changed. The document-set listeners hear whenever the listing
     * moved; the index hears it precisely (`registryChanges`): each file changed outside the app,
     * by name, and the names, once, when they moved. Unnamed for every listing change, it re-read
     * every document after each save, since a save's new file stamp moves the listing too.
     */
    function emitRegistryChanged(changes: RegistryChanges): void {
        for (const listener of documentsChanged) listener()
        for (const concept of changes.contentChanged) emitChange({ concept })
        if (changes.namesMoved) emitChange()
    }

    function emitDocumentRemoved(target: string): void {
        for (const listener of documentRemoved) listener(target)
    }

    /**
     * The registry listing changed but no content did - aliases patched from a save. The
     * listing's consumers are told; the [[Derived Index]] is not asked to re-verify the graph,
     * because the named change the save emits already covers the one document that moved.
     */
    function emitRegistryOnly(): void {
        for (const listener of documentsChanged) listener()
    }

    /**
     * The buffer as it should rest on disk (ADR 0061): the REGISTRY's title, whatever the buffer
     * says, and the buffer's everything else. A title typed into the block is a proposal until the
     * rename dialog confirms it, and a file that already said the new name would be re-keyed by
     * the next rescan underneath the open document - which then found no entry for its old key
     * and was declared removed. Aliases are the file's to say, so they go as typed. A block is
     * only put back when the file name alone would not name the document.
     */
    function proposedToStored(doc: OpenDoc, buffer: string): string {
        const entry = registry.get(doc.key)
        if (!entry || entry.kind !== 'page') return buffer
        return withFrontmatterIdentity(buffer, { title: entry.concept }, { addBlock: fileStem(entry.fileName) !== entry.concept })
    }

    /** Aliases are the file's to say: keep the entry in step without waiting for the next scan. */
    function adoptAliases(entry: DocumentEntry, text: string): void {
        const aliases = aliasesOf(parseFrontmatter(text))
        if (sameAliases(aliases, entry.aliases)) return
        entry.aliases = aliases
        emitRegistryOnly()
    }

    /**
     * A file whose `title` was edited outside the app is a rename that already happened
     * (ADR 0061). The rescan has re-keyed it; the open document is re-keyed to match and its
     * consumers told, so the tab follows the file - instead of the document being declared
     * removed, and then resurrected over the external edit by its next keystroke.
     */
    function followFile(doc: OpenDoc): void {
        const entry = [...registry.values()].find((e) => e.subdir === doc.subdir && e.fileName === doc.fileName)
        if (!entry) return
        const from = doc.target
        open.delete(doc.key)
        doc.key = entry.key
        doc.target = entry.concept
        open.set(doc.key, doc)
        for (const listener of documentRenamed) listener(from, entry.concept)
    }

    /**
     * Replace the registry from a fresh scan; fire onDocumentsChanged iff it changed. The scan
     * is given the entries it has and reuses each whose file has not moved, so a pass over an
     * unchanged graph reads nothing, and it is told which files have a write in flight so it
     * never opens one the store is saving - on Windows that read handle would make the
     * browser's rename of its swap file over the target fail. A fresh store has no entries, so
     * graph open reads every file and learns every identity.
     */
    async function refreshRegistry(): Promise<DocumentEntry[]> {
        const entries = await scanGraph(adapter, {
            previous: registry.values(),
            writeInFlight: (subdir, fileName) => {
                for (const doc of open.values()) {
                    if (doc.saving && doc.subdir === subdir && doc.fileName === fileName) return true
                }
                return false
            },
        })
        registry.clear()
        for (const entry of entries) registry.set(entry.key, entry)
        // Before anyone is told, so whoever reads such a name next reads the new document.
        for (const doc of [...open.values()]) if (doc.removed && registry.has(doc.key)) await takeUpFileAgain(doc)
        const sig = registrySignature(entries)
        if (sig !== registrySig) {
            registrySig = sig
            const changes = registryChanges(announced, entries)
            announced = new Map(registry)
            emitRegistryChanged(changes)
        }
        return entries
    }

    /** Tell an open document's subscribers its text, all but `except` (the editor that made the edit). */
    function notify(doc: OpenDoc, text: string, except?: (text: string) => void): void {
        for (const listener of doc.listeners) if (listener !== except) listener(text)
    }

    /** The frontmatter block of `text`, given its parsed body (`''` when there is none). */
    function headOf(text: string, body: string): string {
        return body === text ? '' : text.slice(0, text.length - body.length)
    }

    /** Documents whose BODY references `concept` at the top level. */
    async function countReferencing(concept: string): Promise<number> {
        let total = 0
        for (const entry of registry.values()) {
            const { text } = await adapter.read(entry.subdir, entry.fileName)
            if (countWikilinkTargets(parseFrontmatter(text).body, concept) > 0) total += 1
        }
        return total
    }

    /**
     * The file a document is written to under `concept` - this backend's half of the naming
     * rule in `storage/file-names.ts`. The portable stem is lossy (`etc` and `etc.`, `A/B` and
     * `A_B`, two titles that truncate alike), so the bare name may already be another
     * document's: the file took whichever was listed last and the other's bytes were gone. The
     * first free candidate of `Title.md`, `Title (2).md`, ... is taken instead, the title
     * untouched, so no concept is invented.
     *
     * Taken means held by another registry entry in the subdir, compared case-insensitively
     * because a Windows or macOS folder would, or present on disk without being scanned yet (a
     * file added behind the store's back). `own` is the document being renamed: its current file
     * is not in its own way, and a candidate that IS that file in another case keeps the file
     * as it is - on NTFS and APFS `foo.md` and `Foo.md` are one file, so writing the new casing
     * and then removing the old would delete the document. A single user's directory, so the
     * registry plus `exists` is enough; nothing coordinates with a concurrent creator.
     */
    async function allocateFileName(subdir: Subdir, concept: string, own?: DocumentEntry): Promise<string> {
        const base = portableFileName(concept)
        const taken = new Set<string>()
        for (const entry of registry.values()) {
            if (entry.subdir === subdir && entry.key !== own?.key) taken.add(entry.fileName.toLowerCase())
        }
        for (let index = 1; ; index++) {
            const candidate = suffixedFileName(base, index)
            const lower = candidate.toLowerCase()
            if (own && lower === own.fileName.toLowerCase()) return own.fileName
            if (taken.has(lower)) continue
            if (await adapter.exists(subdir, candidate)) continue
            return candidate
        }
    }

    /**
     * The aliases a rename carries along (ADR 0038, amended 2026-10-03), after its title steps,
     * on both arms: each holder's list with its rewrites applied, handed to `write` (the store's
     * `setAliases`, which goes through the open buffer or the file and patches the registry).
     * Never through `applyStep`, which retitles and moves files and would give a journal a
     * title. A holder a step retitled, or merged into another document, is found under the name
     * it landed on. Its aliases are read from the open buffer where there is one, so an alias
     * typed but not yet saved is kept. Returns the holders, by their names now.
     */
    async function rewriteScopedAliases(
        plan: RenamePlan,
        strategy: RenameLinkStrategy,
        write: (target: string, aliases: readonly string[]) => Promise<void>,
    ): Promise<string[]> {
        const byHolder = new Map<string, AliasRewrite[]>()
        for (const rewrite of plan.aliases) {
            const key = conceptKey(landedName(plan, rewrite.holder))
            byHolder.set(key, [...(byHolder.get(key) ?? []), rewrite])
        }
        const holders: string[] = []
        for (const [key, rewrites] of byHolder) {
            const entry = registry.get(key)
            if (!entry) continue
            const openDoc = open.get(entry.key)
            if (openDoc) await openDoc.ready
            // A buffer that never loaded stands in for content never seen: the file holds the aliases.
            const text = openDoc?.loaded ? openDoc.buffer : (await adapter.read(entry.subdir, entry.fileName)).text
            // planRename refused this before any step ran; the text may have changed since. Read
            // from nothing, the list would drop every alias the document has.
            if (!frontmatterIdentity(text).readable) throw new Error(unreadableBlockRefusal(plan.direct.from, entry.concept))
            await write(entry.concept, aliasesAfterRename(aliasesOf(parseFrontmatter(text)), rewrites, strategy))
            holders.push(entry.concept)
        }
        return holders
    }

    /**
     * One step of a rename plan: retitle the document, and if the target name is already
     * taken, [[Merge]] into it instead.
     *
     * The document's own file is written before the old one is removed - a crash between the
     * two leaves a duplicate, which is recoverable, where the reverse order loses the
     * document.
     */
    async function applyStep(step: RenameStep, strategy: RenameLinkStrategy): Promise<void> {
        const entry = registry.get(conceptKey(step.from))
        if (!entry) return // a pageless concept: nothing to rename, links still move (ADR 0064)
        if (conceptKey(step.from) === conceptKey(step.to) && step.from === step.to) return

        // An open document's autosave is stopped before its file is touched: a writable still
        // open on the old path would recreate the file at close(), after the remove below, and
        // reading the file mid-write would carry stale text to the new name.
        const openDoc = open.get(entry.key)
        if (openDoc) {
            openDoc.save.cancel()
            await settled(openDoc)
        }

        const { text } = await adapter.read(entry.subdir, entry.fileName)
        // planRename refused this before any step ran; the file may have changed since.
        if (!frontmatterIdentity(text).readable) throw new Error(unreadableBlockRefusal(step.from, entry.concept))
        const fm = parseFrontmatter(text)
        let aliases = aliasesOf(fm)
        let body = fm.body
        // The text whose block the written file keeps: this document's, or the survivor's on a merge.
        let blockSource = text

        if (strategy === 'alias') {
            // Every renamed document keeps its old name (ADR 0038 §3), including cascaded
            // ones - otherwise the promise holds for one document and breaks for the rest.
            if (!aliases.some((a) => conceptKey(a) === conceptKey(step.from))) aliases = [...aliases, step.from]
        }

        // The document that answers to the name, by title or alias, is the survivor, and keeps
        // its own title (`step.into`).
        const targetEntry = step.merges ? registry.get(conceptKey(step.into)) : undefined
        // The document this step merges into, when the target name is another document's.
        const survivor = targetEntry && targetEntry.key !== entry.key ? targetEntry : undefined
        // A survivor open in an editor is merged through its buffer, which is what the editor shows
        // and its autosave writes: a merge written to the file alone was overwritten by the
        // buffer's next save, and the absorbed body with it. Its pending save is stopped, and the
        // buffer, unsaved typing included, is what is merged.
        const survivorDoc = survivor ? open.get(survivor.key) : undefined
        if (survivorDoc) {
            survivorDoc.save.cancel()
            await settled(survivorDoc)
            await survivorDoc.ready
        }
        const throughBuffer = survivorDoc?.loaded === true
        if (survivor) {
            const existing = { text: throughBuffer ? survivorDoc!.buffer : (await adapter.read(survivor.subdir, survivor.fileName)).text }
            if (!frontmatterIdentity(existing.text).readable) throw new Error(unreadableBlockRefusal(step.from, survivor.concept))
            const existingFm = parseFrontmatter(existing.text)
            const merged = mergeDocuments(
                { body: existingFm.body, aliases: aliasesOf(existingFm) },
                { body, aliases },
            )
            body = merged.body
            aliases = merged.aliases
            // The survivor's other frontmatter is kept (ADR 0038 §4).
            blockSource = existing.text
        }

        // A page renamed onto one of its own aliases: the alias becomes the title and is no
        // longer an alias.
        aliases = normaliseAliases(aliases, step.into)
        // Only the identity keys change: every other key, and any comment, stays as the block has it.
        const blockSpan = frontmatterSpan(blockSource)
        const block = blockSpan ? blockSource.slice(0, blockSpan.end) : ''
        const content = withFrontmatterIdentity(block + body, { title: step.into, aliases }, { addBlock: true })

        // A merge writes the survivor's own file, which is not always the name its title derives
        // to: an importer stores a colliding document as `X (2).md`, and the derived name may be
        // a third document's altogether. A plain rename allocates a free name the same way, and
        // keeps the file it has on a pure re-casing.
        const subdir = survivor?.subdir ?? entry.subdir
        const fileName = survivor?.fileName ?? (await allocateFileName(subdir, step.into, entry))
        let written: { lastModified: number; size: number }
        if (throughBuffer && survivorDoc) {
            // An external change, so the editor showing it is told; then the document's own save,
            // which keeps its record of the file in step with what was written.
            survivorDoc.handle.applyChange({ from: 0, to: survivorDoc.buffer.length, insert: content }, 'external')
            await saveNow(survivorDoc)
            written = { lastModified: survivorDoc.lastModified, size: survivorDoc.size }
        } else {
            written = await adapter.write(subdir, fileName, content)
        }
        if (!(subdir === entry.subdir && fileName === entry.fileName)) {
            await adapter.remove(entry.subdir, entry.fileName)
        }

        // Patch the registry in place instead of rescanning. A full scan READS EVERY FILE, so
        // rescanning per step made a five-step cascade seven passes over a 2831-document graph -
        // half a minute with the dialog just sitting there. Later steps only need this step's
        // entries to be current; `renamePage` rescans once at the end to restore scan order and
        // announce the change.
        registry.delete(entry.key)
        if (survivor) registry.delete(survivor.key)
        registry.set(conceptKey(step.into), {
            kind: survivor?.kind ?? entry.kind,
            concept: step.into,
            key: conceptKey(step.into),
            subdir,
            fileName,
            aliases,
            lastModified: written.lastModified,
            size: written.size,
        })

        // An open document still holds the path it was opened at. Left alone, its autosave
        // recreates the file under the OLD name and reconcile reads a path that no longer
        // exists (six NotFoundErrors on the first real-graph drive). Retire the handle: the
        // caller reopens the View under the new concept.
        if (openDoc) open.delete(entry.key)

        // A document removed while open under the name this step gives takes up the file that
        // holds the name now, as when a page is created under it. Left removed, the rewrite below
        // found it under the name, rewrote the deleted text, and that edit brought it back over
        // this file.
        const stale = open.get(conceptKey(step.into))
        if (stale?.removed) await takeUpFileAgain(stale)
    }

    /**
     * Start the document's save if none is in flight, else note that one is wanted. One writable
     * per file at a time: each `createWritable()` gets its own swap file, made visible at
     * `close()`, and nothing orders two of them - so of two overlapping writes the older text
     * could land last, and the first to settle nulled the pointer while the other was still
     * open, which let a reconcile pass read the app's own write as an external edit and raise a
     * conflict. A write wanted mid-flight runs when the current one settles, with the buffer as
     * it is then, so a burst of keystrokes costs two writes at most.
     *
     * The chain never rejects. An autosave has no caller to reject to, so a failed write (a full
     * disk, a lapsed folder permission, a file locked by another program) was an unhandled
     * rejection with `dirty` left true, the debounce spent and nothing to retry it. Now the
     * failure is recorded and reported (`onSaveError`), the buffer stays dirty - dirty work is
     * the source of truth - and `flushDocument`, the next keystroke's autosave and `dispose`
     * retry it. Never a timer: a full disk should not be hammered.
     */
    function runSave(doc: OpenDoc): void {
        if (doc.conflict || doc.removed) {
            doc.queued = false // autosave paused: nothing to run later either
            return
        }
        if (!doc.loaded) {
            // The buffer stands in for content never seen - the file was unreadable at open, or
            // the read is still in flight - so writing it would replace the file with an empty
            // document plus whatever was typed. A reconcile pass reads the file and either
            // reloads the buffer or raises a conflict, which is the way back; the refusal is
            // reported so the user knows the edits are not reaching disk.
            doc.queued = false
            if (doc.loadError !== null) options.onSaveError?.(conceptOf(doc), doc.loadError)
            return
        }
        if (doc.saving) {
            doc.queued = true
            return
        }
        doc.queued = false
        const snapshot = doc.buffer
        const written = proposedToStored(doc, snapshot)
        doc.saving = adapter
            .write(doc.subdir, doc.fileName, written)
            .then(
                (res) => {
                    doc.saveError = null
                    doc.baseText = written
                    doc.lastModified = res.lastModified
                    doc.size = res.size
                    doc.dirty = doc.buffer !== snapshot
                    // Keep the registry stamps in step so reconcile's fast path doesn't re-read our own write.
                    const entry = registry.get(doc.key)
                    if (entry) {
                        entry.lastModified = res.lastModified
                        entry.size = res.size
                        adoptAliases(entry, written)
                    }
                    // No entry ⇒ this write resurrected a removed document (ADR 0039 §4); the
                    // registry has to learn about it or the file exists but the graph does not
                    // list it.
                    else void refreshRegistry()
                    // Content changed on disk → the index row for THIS document is stale. Named,
                    // so the index re-derives one document rather than re-reading the graph.
                    emitChange({ concept: conceptOf(doc) })
                },
                (error: unknown) => {
                    doc.saveError = error
                    options.onSaveError?.(conceptOf(doc), error)
                },
            )
            .finally(() => {
                doc.saving = null
                // Picked up here rather than by the debounce: the keystrokes that wanted it have
                // had their timer. Only if there is still something to write - a write that
                // failed leaves `dirty` true, so it is retried once with the latest buffer.
                if (doc.queued && doc.dirty) runSave(doc)
            })
    }

    /** Resolves once no write is in flight for `doc`, including any that were queued behind it. */
    async function settled(doc: OpenDoc): Promise<void> {
        while (doc.saving) await doc.saving
    }

    /**
     * Write the buffer now if it is dirty, and wait for every write in flight. The pending
     * debounce is superseded rather than flushed: `dirty` is what says there is work, and it
     * outlives a spent debounce - which is what lets a failed autosave be retried here. A
     * document that could not be read at open is read again first: a retry is the user asking,
     * and reconcile either reloads the buffer or, if something was typed, raises a conflict.
     */
    async function saveNow(doc: OpenDoc): Promise<void> {
        doc.save.cancel()
        if (!doc.loaded && doc.loadError !== null) {
            try {
                await reconcileDoc(doc)
            } catch (error) {
                doc.loadError = error // still unreadable: `runSave` below reports it
            }
        }
        if (doc.dirty) runSave(doc)
        await settled(doc)
    }

    /**
     * The registry entry `target` names: a document by its own name, else by one of its aliases
     * (ADR 0061), as a bookmark or a Recents entry can carry a renamed page's old name. A page's own
     * name outranks another page's alias of the same name, as the index resolves it.
     */
    function entryNamed(target: string): DocumentEntry | undefined {
        const key = conceptKey(target)
        const own = registry.get(key)
        if (own) return own
        for (const entry of registry.values()) {
            if (entry.aliases.some((alias) => conceptKey(alias) === key)) return entry
        }
        return undefined
    }

    /** The open document `target` names, opening it if it is not; throws when nothing has that name. */
    function openDocNamed(target: string): OpenDoc {
        // An open document answers to its name even after its file went (an edit brings it back),
        // unless it went by the user's own delete: then the name is free until a file has it.
        const existing = open.get(conceptKey(target))
        if (existing && !(existing.removed && existing.deletedHere)) return existing
        const entry = entryNamed(target)
        if (!entry) throw new DocumentNotFoundError(target)
        // Reached by an alias: the document it names, open under that name's key, which it keeps.
        const opened = open.get(entry.key)
        if (opened) return opened
        const doc = makeOpenDoc(entry.key === conceptKey(target) ? target : entry.concept, entry)
        open.set(entry.key, doc)
        return doc
    }

    function makeOpenDoc(target: string, entry: DocumentEntry): OpenDoc {
        const doc: OpenDoc = {
            key: entry.key,
            target,
            subdir: entry.subdir,
            fileName: entry.fileName,
            buffer: '',
            baseText: '',
            lastModified: 0,
            size: 0,
            dirty: false,
            loaded: false,
            loadError: null,
            ready: Promise.resolve(),
            removed: false,
            deletedHere: false,
            conflict: null,
            listeners: new Set(),
            save: undefined as unknown as Debounced<[]>,
            saving: null,
            queued: false,
            saveError: null,
            handle: undefined as unknown as EditorDocument,
        }
        doc.save = debounce(() => runSave(doc), autosaveMs)
        doc.handle = {
            // Live, not captured: the document follows its file to a new name (`followFile`).
            get id() {
                return doc.target
            },
            getText: () => doc.buffer,
            applyChange(change, origin = 'editor', editor) {
                doc.buffer = applyTextChange(doc.buffer, change)
                doc.dirty = true
                // An edit outranks a delete (ADR 0039 §4). Without this, a file that vanished
                // under an open buffer left `removed = true` with autosave cancelled, and the
                // unsaved edits were silently discarded when the tab closed - a real bug that
                // predates delete, reachable through any external removal (a git checkout).
                if (doc.removed) {
                    doc.removed = false
                    doc.deletedHere = false
                    options.onResurrected?.(doc.target)
                }
                doc.save.call()
                // An editor's own edit needs no echo — it already shows it. An edit from
                // anywhere else does: without this an open editor renders text the buffer no
                // longer holds, and its next keystroke lands at an offset computed against a
                // document it disagrees with. A second editor on the document (ADR 0113) is in
                // the same place, so it hears the first one's edits. (Server-backed documents need
                // no equivalent: each editor binds the Y.Text directly, so any write reaches it.)
                if (origin === 'external') notify(doc, doc.buffer)
                else if (editor) notify(doc, doc.buffer, editor)
            },
            subscribe(listener) {
                doc.listeners.add(listener)
                return () => doc.listeners.delete(listener)
            },
        }

        // Hydrate the buffer asynchronously, then push it in the external way so the
        // editor (which has already seeded from the empty getText() and subscribed)
        // reflects it.
        doc.ready = adapter
            .read(doc.subdir, doc.fileName)
            .then((content) => {
                // The editor's buffer holds line feeds only (ADR 0112): CodeMirror joins its lines
                // with `\n`, and a `\r` kept here put every edit one character early per line ending
                // above it. `baseText` keeps the file's own bytes, so reconcile never takes the
                // file's line endings for an external edit, and nothing is written until an edit is.
                doc.buffer = lineFeedsOnly(content.text)
                doc.baseText = content.text
                doc.lastModified = content.lastModified
                doc.size = content.size
                doc.loaded = true
                notify(doc, doc.buffer)
            })
            .catch(async (error: unknown) => {
                // Absent (removed between the scan and this open): an empty buffer IS the
                // document, and the first keystroke recreates the file (ADR 0039 §4). Present
                // but unreadable (a lock, a permission hiccup, a sync tool mid-write): the
                // buffer stands in for content never seen, so `runSave` refuses to write it
                // until a reconcile pass has read the file - a reload if nothing was typed, a
                // conflict to resolve if something was. Before this, the first keystroke saved
                // the empty stand-in over the file.
                const present = await adapter.exists(doc.subdir, doc.fileName).catch(() => true)
                if (present) doc.loadError = error
                else doc.loaded = true
            })

        return doc
    }

    async function reconcileDoc(doc: OpenDoc): Promise<void> {
        if (doc.removed) return
        // Never judge a document against disk while OUR write to it is still landing. In that
        // window the bytes are on disk (a listing already reports the new mtime) but baseText,
        // lastModified and dirty still describe the pre-save state, so the verdict would be
        // "conflict" - the app's own autosave surfaced as "changed on disk while you have
        // unsaved edits", with autosave then paused. Awaiting rather than skipping: a genuine
        // external edit that landed during the write is still caught, just after it.
        await settled(doc)
        const entry = registry.get(doc.key)
        if (!entry) {
            // Vanished on disk (e.g. git checkout removed it).
            doc.removed = true
            doc.save.cancel()
            emitDocumentRemoved(doc.target)
            return
        }
        // Fast path: the listing's (mtime, size) pair matches what this document last synced,
        // so skip the read. Honest about what that misses: an edit that changes neither - the
        // same length, written inside the timestamp's resolution (2 s on exFAT, 1 s on HFS+) or
        // by a tool that preserves mtime (`rsync -t`, `cp -p`) - is caught only at the next
        // open, and the next autosave writes over it. mtime alone missed every mtime-preserving
        // edit; the size is free from the listing and closes most of that gap. Text equality
        // decides everything the fast path lets through. A document never read has nothing to
        // compare, so it is always read here - that is how an unreadable-at-open file recovers.
        if (doc.loaded && entry.lastModified === doc.lastModified && entry.size === doc.size) return

        followDisk(doc, await adapter.read(doc.subdir, doc.fileName))
    }

    /**
     * Bring an open document in line with its file as just read (`reconcileDecision`): nothing
     * but the stamps when the file is what the buffer last synced with, a reload of a clean buffer,
     * a conflict over a dirty one.
     */
    function followDisk(doc: OpenDoc, { text: diskText, lastModified, size }: { text: string; lastModified: number; size: number }): void {
        const decision = reconcileDecision({
            dirty: doc.dirty,
            baseText: doc.baseText,
            diskText,
        })
        if (decision === 'noop') {
            // Adopt the new stamps so identical content is not re-read on every pass.
            doc.lastModified = lastModified
            doc.size = size
            doc.loaded = true
            doc.loadError = null
            return
        }
        if (decision === 'reload') {
            doc.buffer = lineFeedsOnly(diskText) // as at open: the buffer is line feeds, baseText the file (ADR 0112)
            doc.baseText = diskText
            doc.lastModified = lastModified
            doc.size = size
            doc.loaded = true
            doc.loadError = null
            doc.dirty = false
            notify(doc, doc.buffer)
            emitChange({ concept: conceptOf(doc) })
            return
        }
        // conflict: stop, pause autosave, surface to the UI; leave the buffer untouched.
        doc.conflict = { target: doc.target, diskText, bufferText: doc.buffer }
        doc.save.cancel()
        onConflict?.(doc.conflict)
    }

    /**
     * A document removed while open keeps its buffer, so its tab still shows it and an edit there
     * brings it back (ADR 0039 §4). It answers to its name only until a file does again: a page
     * created under the name, in the app or by another program. Then it takes that file up as an
     * opened document would. A buffer with no unsaved edits reloads from the file, and one with
     * unsaved edits raises a conflict rather than being written over it. Before, it kept the name
     * for the session: the name opened the deleted text, the index read it, and the first
     * keystroke saved it over the new file.
     */
    async function takeUpFileAgain(doc: OpenDoc): Promise<void> {
        const entry = registry.get(doc.key)
        if (!doc.removed || !entry) return
        const read = await readIfPresent(entry.subdir, entry.fileName)
        if (!read) return
        doc.removed = false
        doc.deletedHere = false
        doc.subdir = entry.subdir
        doc.fileName = entry.fileName
        doc.target = entry.concept
        followDisk(doc, read)
    }

    /** A file's content, or null when it does not exist; any other failure rejects. */
    async function readIfPresent(subdir: Subdir, fileName: string): Promise<{ text: string; lastModified: number; size: number } | null> {
        try {
            return await adapter.read(subdir, fileName)
        } catch (error) {
            if (await adapter.exists(subdir, fileName).catch(() => true)) throw error
            return null
        }
    }

    /**
     * A Formatting Scan's fix to an open document (ADR 0109): through the buffer, so the editor
     * showing it is told, then saved now. The file is read first: an edit made outside the app
     * since the buffer last synced is followed, a reload or a conflict over unsaved typing, and
     * the fix is refused rather than saved over it.
     */
    async function spliceOpenDocument(doc: OpenDoc, expected: string, splices: readonly TextSplice[]): Promise<SpliceOutcome> {
        await doc.ready
        await settled(doc)
        if (doc.removed) return 'gone'
        if (doc.conflict) return 'changed' // raised already: the person resolves it first
        const disk = await readIfPresent(doc.subdir, doc.fileName)
        if (disk === null || doc.removed) return 'gone'
        // A save that began during the read is typing landing: the file cannot be judged against it.
        if (doc.saving || doc.conflict) return 'changed'
        followDisk(doc, disk)
        if (doc.conflict || !doc.loaded) return 'changed'
        if (containsCipherFence(doc.buffer)) return 'protected'
        if (doc.buffer !== expected) return 'changed'
        for (let i = splices.length - 1; i >= 0; i--) doc.handle.applyChange(splices[i], 'external')
        await saveNow(doc)
        return 'written'
    }

    /** A Formatting Scan's fix to a document nobody has open: read, compare, write (ADR 0109). */
    async function spliceClosedDocument(entry: DocumentEntry, expected: string, splices: readonly TextSplice[]): Promise<SpliceOutcome> {
        const read = await readIfPresent(entry.subdir, entry.fileName)
        if (read === null) return 'gone'
        const opened = open.get(entry.key)
        if (opened) return spliceOpenDocument(opened, expected, splices) // opened while the file was read
        if (containsCipherFence(read.text)) return 'protected'
        if (read.text !== expected) return 'changed'
        let text = read.text
        for (let i = splices.length - 1; i >= 0; i--) text = applyTextChange(text, splices[i])
        const written = await adapter.write(entry.subdir, entry.fileName, text)
        // As a save does: the registry keeps the stamps, so reconcile's fast path does not re-read
        // this write, and the index re-derives the one document.
        entry.lastModified = written.lastModified
        entry.size = written.size
        emitChange({ concept: entry.concept })
        return 'written'
    }

    return {
        open(target) {
            return openDocNamed(target).handle
        },

        async whenReady(target) {
            // Opening is what starts the read; a document already open just awaits its own.
            await openDocNamed(target).ready
        },

        async scan() {
            await adapter.ensureSkeleton()
            await refreshRegistry()
        },

        listDocuments() {
            return snapshotEntries()
        },

        onDocumentsChanged(listener) {
            documentsChanged.add(listener)
            return () => documentsChanged.delete(listener)
        },

        onDocumentRemoved(listener) {
            documentRemoved.add(listener)
            return () => documentRemoved.delete(listener)
        },

        onDocumentRenamed(listener) {
            documentRenamed.add(listener)
            return () => documentRenamed.delete(listener)
        },

        async setAliases(target, aliases) {
            const entry = registry.get(conceptKey(target))
            if (!entry) throw new DocumentNotFoundError(target)
            const next = normaliseAliases(aliases, entry.concept)
            const doc = open.get(entry.key)
            if (doc) await doc.ready
            // Through the buffer the editor shows, unless it never loaded: then it stands in for
            // content never seen, refuses to save, and the aliases would never reach the file.
            if (doc?.loaded) {
                const text = withFrontmatterIdentity(doc.buffer, { aliases: next }, { addBlock: next.length > 0 })
                // External, so the editor showing this buffer is told; the save follows as usual.
                if (text !== doc.buffer) doc.handle.applyChange({ from: 0, to: doc.buffer.length, insert: text }, 'external')
            } else {
                const { text } = await adapter.read(entry.subdir, entry.fileName)
                const rewritten = withFrontmatterIdentity(text, { aliases: next }, { addBlock: next.length > 0 })
                if (rewritten !== text) {
                    const res = await adapter.write(entry.subdir, entry.fileName, rewritten)
                    entry.lastModified = res.lastModified
                    entry.size = res.size
                    emitChange({ concept: entry.concept })
                }
            }
            if (!sameAliases(entry.aliases, next)) {
                entry.aliases = next
                emitRegistryOnly()
            }
        },

        async documentText(target) {
            const entry = registry.get(conceptKey(target))
            if (!entry) return null
            const doc = open.get(entry.key)
            if (doc) {
                await doc.ready
                // A buffer whose file could not be read stands in for content never seen.
                if (doc.loaded) return doc.buffer
            }
            return (await readIfPresent(entry.subdir, entry.fileName))?.text ?? null
        },

        async spliceIfUnchanged(target, expected, splices) {
            const entry = registry.get(conceptKey(target))
            if (!entry) return 'gone'
            const doc = open.get(entry.key)
            return doc ? spliceOpenDocument(doc, expected, splices) : spliceClosedDocument(entry, expected, splices)
        },

        onChange(listener) {
            changed.add(listener)
            return () => changed.delete(listener)
        },

        async snapshotForIndex() {
            const out: IndexDocSnapshot[] = []
            const stream = await this.streamForIndex()
            for await (const batch of stream.batches) out.push(...batch)
            return out
        },

        async streamForIndex() {
            const entries = [...registry.values()]
            return {
                total: entries.length,
                batches: (async function* () {
                    const batch: IndexDocSnapshot[] = []
                    for (const entry of entries) {
                        // A rename cascade can move a file while the stream is in flight.
                        // Its registry signal schedules another pass, so skip the stale read.
                        const read = await adapter
                            .read(entry.subdir, entry.fileName)
                            .catch(() => null)
                        if (!read) continue
                        batch.push(indexSnapshotOf(entry, read.text))
                        if (batch.length === 100) yield batch.splice(0)
                    }
                    if (batch.length > 0) yield batch
                })(),
            }
        },

        async snapshotDocument(concept) {
            const entry = registry.get(conceptKey(concept))
            if (!entry) return null
            const doc = open.get(entry.key)
            let text: string
            if (doc) {
                // The buffer, not the file: a named change fires when a save has landed, and
                // the buffer is what was saved — or newer, which the next save will name again.
                await doc.ready
                text = doc.buffer
            } else {
                const read = await adapter.read(entry.subdir, entry.fileName).catch(() => null)
                if (!read) return null
                text = read.text
            }
            return indexSnapshotOf(entry, text)
        },

        async reconcile() {
            // One removed while open and taken up again by the rescan has just been followed to its
            // file (`takeUpFileAgain`): reading it again here would raise any conflict twice.
            const wasRemoved = new Set([...open.values()].filter((doc) => doc.removed))
            await refreshRegistry()
            for (const doc of [...open.values()]) {
                if (wasRemoved.has(doc) && !doc.removed) continue
                if (!registry.has(doc.key)) followFile(doc)
                await reconcileDoc(doc)
            }
        },

        async resolveConflict(target, choice) {
            const doc = open.get(conceptKey(target))
            if (!doc || !doc.conflict) return
            // Either way the buffer and the file agree afterwards - including for a document
            // that was unreadable at open, whose conflict this may be.
            doc.loaded = true
            doc.loadError = null
            if (choice === 'take-disk') {
                const { text, lastModified, size } = await adapter.read(doc.subdir, doc.fileName)
                doc.buffer = lineFeedsOnly(text) // as at open (ADR 0112)
                doc.baseText = text
                doc.lastModified = lastModified
                doc.size = size
                doc.dirty = false
                doc.conflict = null
                notify(doc, doc.buffer)
            } else {
                const res = await adapter.write(doc.subdir, doc.fileName, doc.buffer)
                doc.baseText = doc.buffer
                doc.lastModified = res.lastModified
                doc.size = res.size
                doc.dirty = false
                doc.conflict = null
                const entry = registry.get(doc.key)
                if (entry) {
                    entry.lastModified = res.lastModified
                    entry.size = res.size
                }
            }
            emitChange({ concept: conceptOf(doc) })
        },

        async createJournal(date, body = '') {
            const concept = date.trim()
            if (!isJournalConcept(concept)) throw new Error(`"${date}" is not a calendar day.`)
            if (registry.get(conceptKey(concept))) {
                throw new Error(`A document for "${concept}" already exists.`)
            }
            await adapter.ensureSkeleton()
            await adapter.write('journals', `${concept}.md`, body)
            await refreshRegistry()
            return concept
        },

        async createPage(title, body = '') {
            const concept = title.trim()
            if (concept === '') throw new Error('A page needs a non-empty title.')
            // Refused, never redirected to createJournal: a caller that means the day calls that
            // itself (promoteDraft does), so one arriving here with a day has a bug to surface.
            if (isJournalConcept(concept)) throw new Error(dayIsNotAPageName(concept))
            const key = conceptKey(concept)
            if (registry.get(key)) {
                throw new Error(`A document for "${concept}" already exists.`)
            }
            await adapter.ensureSkeleton()
            // The concept is free (checked above); its portable file name may not be.
            const fileName = await allocateFileName('pages', concept)
            const content = renderFrontmatter({ title: concept }) + body
            await adapter.write('pages', fileName, content)
            await refreshRegistry()
            return concept
        },

        /**
         * Plan a rename (ADR 0037, 0038). The page's own file is rewritten first - frontmatter
         * `title` carries identity (ADR 0007), the file name merely follows it - and only
         * then are inbound links touched, so a failure part-way leaves the rename undone
         * rather than the graph pointing at a page that never moved. No entry is not a
         * refusal: a [[Pageless Concept]] renames by rewriting its links, and the plan says so
         * through a null kind (ADR 0064).
         */
        async planRename(from, to, referencingDocuments) {
            const entry = registry.get(conceptKey(from))
            const plan = planRename({
                from,
                to,
                kind: entry?.kind ?? null,
                concepts: [...registry.values()].map((e) => e.concept),
                aliases: [...registry.values()].flatMap((e) =>
                    (e.aliases ?? []).map((name) => ({ name, concept: e.concept })),
                ),
                // Counting by reading every file is O(graph) - seconds on a real graph, which
                // is why the caller can pass a figure it already has (the backlink index
                // knows). The slow path stays for callers with no index.
                referencingDocuments: referencingDocuments ?? (await countReferencing(from)),
            })
            // A Protected Document never merges (ADR 0062). An open document's buffer is ahead
            // of its file by one autosave - a protection just removed is not on disk yet - so
            // the buffer answers where there is one.
            const checked = await refuseProtectedMerges(plan, async (concept) => {
                const other = registry.get(conceptKey(concept))
                if (!other) return false
                const text = open.get(other.key)?.buffer ?? (await adapter.read(other.subdir, other.fileName)).text
                return documentProtection(text).kind === 'document'
            })
            // A block that does not parse would be rebuilt from nothing and lose its keys. Judged on
            // the file, which is what applyStep rewrites, once any save in flight has landed: an
            // open buffer fixed but not yet saved is still broken on disk. A scoped alias is
            // rewritten through the open buffer where there is one (rewriteScopedAliases), so its
            // holder is judged on that.
            return refuseUnreadableBlocks(
                checked,
                async (concept) => {
                    const other = registry.get(conceptKey(concept))
                    if (!other) return null
                    const openDoc = open.get(other.key)
                    if (openDoc) await settled(openDoc)
                    return (await adapter.read(other.subdir, other.fileName)).text
                },
                async (concept) => {
                    const other = registry.get(conceptKey(concept))
                    if (!other) return null
                    const openDoc = open.get(other.key)
                    if (openDoc) await openDoc.ready
                    return openDoc?.loaded ? openDoc.buffer : (await adapter.read(other.subdir, other.fileName)).text
                },
            )
        },

        /**
         * Apply a rename plan (ADR 0038). Steps run deepest-scope-first so a shallower
         * document is never renamed onto a name a deeper step has yet to vacate, and each
         * step is a plain rename or a [[Merge]] depending on whether the target is taken.
         */
        async renamePage(from, to, options: RenameOptions): Promise<RenameResult> {
            // Re-plan rather than trust the dialog's preview - the graph may have moved. The
            // reference count is passed as 0 because only the preview ever reads it, and
            // computing it here would add a whole extra read of every file to the apply path.
            const plan = await this.planRename(from, to, 0)
            if (plan.refusal) throw new Error(plan.refusal)

            for (const step of renameSteps(plan)) await applyStep(step, options.strategy)
            const aliasesRewritten = await rewriteScopedAliases(plan, options.strategy, (target, aliases) =>
                this.setAliases(target, aliases),
            )

            // Bodies last, and in ONE pass over the graph: the cascade rule rewrites every
            // `[[from]]` at any depth, which fixes plain references and scoped ones together.
            // An OPEN document is rewritten through its buffer, as per-occurrence external
            // changes (ADR 0066): the editor showing it updates at once and the next autosave
            // writes the rewritten text. Going round it via the file left the buffer stale - a
            // clean one was reloaded seconds later by the reconciler, a dirty one autosaved its
            // stale text back over the rewrite and silently lost it. Only a document nobody has
            // open is rewritten on disk.
            let rewritten = 0
            const rewrittenDocuments: string[] = []
            if (options.strategy === 'rewrite') {
                for (const other of [...registry.values()]) {
                    const openDoc = open.get(other.key)
                    if (openDoc) {
                        await openDoc.ready
                        const prefix = frontmatterSpan(openDoc.buffer)?.end ?? 0
                        const splices = wikilinkScopeSplices(openDoc.buffer.slice(prefix), plan.direct.from, plan.direct.to)
                        if (splices.length === 0) continue
                        for (let i = splices.length - 1; i >= 0; i--) {
                            const splice = splices[i]
                            openDoc.handle.applyChange(
                                { from: splice.from + prefix, to: splice.to + prefix, insert: splice.insert },
                                'external',
                            )
                        }
                        rewritten += 1
                        rewrittenDocuments.push(other.concept)
                        continue
                    }
                    const doc = await adapter.read(other.subdir, other.fileName)
                    const parsed = parseFrontmatter(doc.text)
                    const result = rewriteWikilinkScope(parsed.body, plan.direct.from, plan.direct.to)
                    if (result.count === 0) continue
                    await adapter.write(other.subdir, other.fileName, `${headOf(doc.text, parsed.body)}${result.text}`)
                    rewritten += 1
                    rewrittenDocuments.push(other.concept)
                }
            }

            await refreshRegistry()
            // Every document the rename wrote is named, so the index reads each one again whatever
            // its file's stamps say: a file rewritten in the millisecond of its last announced
            // write, to the same size, looks unchanged to the rescan above.
            const wrote = [...renameSteps(plan).filter((step) => step.hasDocument).map((step) => step.into), ...rewrittenDocuments]
            for (const concept of new Set(wrote)) emitChange({ concept })
            return {
                concept: plan.direct.into,
                aliasOf: plan.aliasOf === null ? null : landedName(plan, plan.aliasOf),
                rewritten,
                rewrittenDocuments,
                cascaded: plan.cascade.length,
                merged: mergeCount(plan),
                aliasesRewritten,
            }
        },

        async deleteDocument(concept: string): Promise<void> {
            const entry = registry.get(conceptKey(concept))
            if (!entry) return // already gone; deleting twice is not an error
            const doc = open.get(entry.key)
            if (doc) {
                // Stop autosave writing the file back out from under the delete, and wait for a
                // write already open: its writable would recreate the file at close().
                doc.save.cancel()
                doc.removed = true
                doc.deletedHere = true
                // Its unsaved typing goes with it. An edit in its tab brings both back (ADR 0039
                // §4); a page created under its name later starts from that page's own text.
                doc.dirty = false
                await settled(doc)
            }
            await adapter.remove(entry.subdir, entry.fileName)
            await refreshRegistry()
            emitDocumentRemoved(entry.concept)
        },

        async flushDocument(target) {
            const doc = open.get(conceptKey(target))
            if (!doc) return
            await saveNow(doc)
        },

        async flushAll() {
            await Promise.all([...open.values()].map(saveNow))
            // A write that failed leaves its buffer dirty and resolves (onSaveError reports it). A
            // caller reading the folder must not believe it, so this one says so. A removed
            // document's typing is not owed to the folder: it went with the document.
            const unwritten = [...open.values()].filter((doc) => doc.dirty && !doc.removed).map((doc) => doc.target)
            if (unwritten.length > 0) {
                throw new Error(`Edits to ${unwritten.join(', ')} could not be written to the folder yet, so it does not hold them. Try again once they are saved.`)
            }
        },

        async dispose() {
            // Every dirty buffer, a failed write included; the files are independent, so the
            // writes go out together.
            await Promise.all([...open.values()].map(saveNow))
            open.clear()
            documentsChanged.clear()
            documentRemoved.clear()
            changed.clear()
        },
    }
}
