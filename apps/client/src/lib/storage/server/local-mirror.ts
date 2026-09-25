/**
 * Local Mirror (ADR 0008): a continuously-maintained, faithful plain-markdown reflection of a
 * Server-backed graph on the user's disk, for Data Ownership. The server is always master - the
 * mirror is written, never read back - and any file that is not part of the server graph is
 * deleted, no exceptions. It writes settled document content and the [[Asset]] bytes those
 * documents reference, so the folder is a complete [[Export]] the user can back up with their own
 * sync service or version control, and can import to recreate the graph.
 *
 * Three rules keep it honest, and each is here because its absence lost data (see
 * [[2026-09-09 Local Mirror Robustness And Assets]]):
 *
 * - **Nothing is written until its content is confirmed.** Documents are read through the store's
 *   batched, cache-seeded path rather than opened, and one whose content cannot be confirmed is
 *   skipped and named rather than written as an empty file over a good one.
 * - **Nothing is deleted against an unverified view.** Strays go only once the encrypted registry
 *   has been confirmed against the server this session; assets go only when every document's
 *   content was confirmed, because a skipped document's references are unknown.
 * - **Only what changed is written.** The folder is modelled in memory after one read pass, so a
 *   keystroke rewrites one file rather than all of them, and a file whose bytes would not change
 *   is not touched at all. That is what makes the folder usable as a git working tree.
 *
 * Framework-free: a materialized-content source plus a DirectoryAdapter (the same web-fs adapter
 * a Filesystem Backend uses), so it runs over OPFS in the browser suite and over memory in unit
 * tests.
 */
import type { QuickNote } from '$lib/document/quick-notes'
import { QUICK_NOTES_FILE, quickNotesFileText } from '$lib/storage/fs/quick-notes-file'
import { DICTIONARY_FILE } from '$lib/storage/fs/dictionary-file'
import { dictionaryFileText } from '$lib/document/spelling/graph-dictionary'
import { graphThemeFileText, themeFileName, themeIdOfFileName } from '$lib/storage/fs/theme-files'
import type { GraphTheme } from '$lib/document/publish/theme/graph-theme'
import { serialiseProtectionRecord, type ProtectionRecord } from '$lib/crypto'
import { PROTECTION_FILE } from '$lib/document/protection/protection-store'
import { withFrontmatterIdentity } from '$lib/document/frontmatter/identity'
import { conceptKey, fileStem } from '$lib/storage/fs/identity'
import type { DirectoryAdapter, Subdir } from '$lib/storage/fs/directory-adapter'

import { referencedAssetNames } from './mirror-assets'
import {
    type MirrorDocument,
    type MirrorFile,
    type MirrorNameCollision,
    claimedConcept,
    mirrorSubdir,
    planMirrorNames,
} from './mirror-names'

export type { MirrorDocument, MirrorNameCollision }

/** One document's materialized text, and whether it can be trusted as its settled content. */
export interface MirrorText {
    text: string
    settled: boolean
}

/** What travels with the folder beside the documents: graph content, and the copier's own protection record. */
export interface MirrorMetadata {
    name?: string
    settings?: Record<string, unknown>
    quickNotes?: QuickNote[]
    /** The [[Graph Dictionary]] (ADR 0095), written as `etherpk/dictionary.txt`. */
    spellingDictionary?: string[]
    themes?: GraphTheme[]
    /**
     * The copier's passphrase-wrapped Protection Key record (ADR 0093), written as
     * `etherpk/protection.json` exactly as a Filesystem Backend keeps it. `null` says the graph
     * has none, so a file left from an earlier one is removed; `undefined` says it is not known
     * right now (a vault that could not be read), and the file is left alone.
     */
    protection?: ProtectionRecord | null
}

export interface MirrorSource {
    listDocuments(): MirrorDocument[]
    /** Full text for documents, without opening them. Batched and cache-seeded by the store. */
    readTexts(
        docIds: readonly string[],
        onProgress?: (done: number, total: number) => void,
    ): Promise<Map<string, MirrorText>>
    /**
     * Resolves true once the encrypted registry has been confirmed against the server this
     * session. False gates every deletion: offline, "not in the registry" does not mean
     * "deleted from the graph".
     */
    confirmRegistry(): Promise<boolean>
    /** [[Graph Settings]] and the [[Graph Name]] - graph content, so they travel with the folder. */
    metadata?(): MirrorMetadata | undefined
    /**
     * Every [[Asset]] the graph holds, by id. Null when the question cannot be answered right
     * now - offline, or no asset storage - which stops the asset pass rather than guessing.
     */
    listGraphAssets?(): Promise<readonly string[] | null>
    /** The asset an on-disk name or a document's reference identifies, or null for neither. */
    assetIdOf?(name: string): string | null
    /** One asset's plain bytes, with the name to store it under when no document names it. */
    fetchAsset?(assetId: string): Promise<MirrorAssetResult>
    /** Fires whenever materialized content or the document set changes. */
    onChange(listener: (change?: { concept: string }) => void): () => void
}

/**
 * What a pass is doing right now. The four phases are the four kinds of work a pass does, in the
 * order it does them, so a host can say which one is running rather than only that something is.
 *
 * `total` is 0 while it is not yet known; a bar drawn from that would be a lie, so hosts show the
 * label alone until it lands. Same rule as an [[Activity]] phase (ADR 0035).
 */
export interface MirrorProgress {
    phase: 'scanning' | 'reading' | 'writing' | 'assets'
    done: number
    total: number
}

/** The four phases in order, with the words a host should put on them. */
export const MIRROR_PHASE_LABELS: Record<MirrorProgress['phase'], string> = {
    scanning: 'Checking the folder',
    reading: 'Reading the graph',
    writing: 'Writing documents',
    assets: 'Downloading attachments',
}

/**
 * One asset's bytes, plus what to call it when no document names it. `unavailable` is an asset
 * the graph holds that did not come down this time, which every pass tries again.
 */
export type MirrorAssetResult = { bytes: Uint8Array<ArrayBuffer>; fileName: string } | 'unavailable'

/**
 * A document's link to an attachment the graph does not hold. An [[Import]] that could not carry
 * a source file across leaves exactly this, and no pass will ever resolve it - so it is named,
 * with the document that holds it, rather than retried for ever. Telling a person this was the
 * same as a failed download made a real graph report 195 attachments as pending indefinitely
 * while Mirror now changed nothing (2026-09-09).
 */
export interface MirrorDanglingLink {
    name: string
    concept: string
}

/** Why a mirror stopped: the first two need the user, the third only a retry. */
export type MirrorPauseKind = 'permission' | 'folder' | 'error'

export interface MirrorPause {
    kind: MirrorPauseKind
    message: string
}

export interface MirrorStatus {
    /** The folder's display name, so the Mirror tab can say where the copy is. */
    folder: string
    running: boolean
    syncing: boolean
    /**
     * What the running pass is doing. A `full` pass reconsiders every document, name, stray and
     * asset; a `targeted` one writes the handful whose content just changed. Only the first is
     * worth showing anywhere but the Mirror tab.
     */
    pass?: { kind: 'full' | 'targeted'; progress: MirrorProgress }
    /** Set when mirroring has stopped and needs the user or a retry. */
    paused?: MirrorPause
    /** Epoch-ms of the last pass that completed without error. */
    lastSyncAt?: number
    documents: number
    assets: number
    /** Concepts whose content could not be confirmed, so their files were left alone. */
    skipped: string[]
    /** Documents whose file name had to be suffixed to avoid a collision. */
    collisions: MirrorNameCollision[]
    /** Assets the graph holds that could not be downloaded on the last pass. Retried. */
    missingAssets: string[]
    /** Document links to attachments this graph does not hold. Never retried. */
    danglingLinks: MirrorDanglingLink[]
}

export interface LocalMirror {
    /** Start mirroring: a full pass now, then a debounced pass on every change. */
    start(): void
    /** Run a full pass now and wait for it (the tab's "Mirror now"). */
    sync(): Promise<void>
    /** Stop mirroring. The folder is left exactly as it is. */
    stop(): void
    dispose(): void
    status(): MirrorStatus
    onStatus(listener: (status: MirrorStatus) => void): () => void
    /** Clear a pause and try again - after the user re-granted permission, say. */
    resume(): void
}

export interface LocalMirrorOptions {
    /** Display name of the mirrored folder. */
    folder?: string
    /** How long content must settle before it reaches the disk. */
    debounceMs?: number
    /** How many assets to download at once. */
    assetConcurrency?: number
    /** Backoff before retrying a failure that is neither permission nor a missing folder. */
    retryDelaysMs?: readonly number[]
    /** Injectable for tests. */
    now?: () => number
}

/** What the mirror believes one file in the folder holds. */
interface DiskFile {
    /** The name as it really is on disk; the map is keyed case-insensitively. */
    name: string
    concept: string
    hash: string
    /**
     * The mtime this content was seen at. A listing is cheap and a read is not, so an unchanged
     * mtime is what lets a full pass skip re-reading the whole folder - the same fast path the
     * Filesystem Backend's reconciliation uses, and equally never trusted for equality itself.
     */
    mtime: number
}

/** What the mirror last wrote for one document. */
interface WrittenDocument {
    fileName: string
    /** Carried so a dangling link can name the document that holds it. */
    concept: string
    hash: string
    /** Concept plus aliases: what the [[Frontmatter]] block says, so a rename forces a rewrite. */
    identity: string
    /** Asset file names this document references, for the folder-wide wanted set. */
    refs: string[]
}

const DEFAULT_DEBOUNCE_MS = 5000
const DEFAULT_ASSET_CONCURRENCY = 4
const DEFAULT_RETRY_DELAYS_MS = [2000, 8000, 30000]
/** Status announcements per phase are throttled to one in this many items (see `progress`). */
const PROGRESS_ANNOUNCE_EVERY = 25
const MIRRORED_SUBDIRS: readonly Subdir[] = ['journals', 'pages']

/** SHA-256 of a string, hex. Change detection only - never identity. */
async function hashText(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Concept plus aliases, as one unambiguously comparable string. */
function identityOf(doc: MirrorDocument): string {
    return JSON.stringify([doc.concept, ...(doc.aliases ?? [])])
}

/**
 * The file's text: the document's text with the registry's identity in its [[Frontmatter]]
 * (ADR 0061). A block the text already carries is merged into - its other keys kept, its `title`
 * and `aliases` set to what the registry says - rather than having a second block written above
 * it. A page always gets a block, because on a Filesystem Backend the title is the identity. A
 * journal is named by its date and gets one only for its aliases, unless a collision moved it off
 * that name, where the block is the only thing left saying which day it is.
 */
export function mirrorFileText(doc: MirrorDocument, fileName: string, text: string): string {
    const aliases = [...(doc.aliases ?? [])]
    if (doc.kind === 'page') {
        return withFrontmatterIdentity(text, { title: doc.concept, aliases }, { addBlock: true })
    }
    const renamed = fileStem(fileName) !== doc.concept
    return withFrontmatterIdentity(
        text,
        { ...(renamed ? { title: doc.concept } : {}), aliases },
        { addBlock: renamed || aliases.length > 0 },
    )
}

/** What a write failure says about the folder, and how the user gets mirroring back. */
export function classifyMirrorFailure(error: unknown): MirrorPause {
    const name = (error as DOMException | null)?.name
    if (name === 'NotAllowedError' || name === 'SecurityError') {
        return {
            kind: 'permission',
            message: 'EtherPK no longer has permission to write to this folder.',
        }
    }
    if (name === 'NotFoundError') {
        return { kind: 'folder', message: 'The mirror folder is no longer there.' }
    }
    return { kind: 'error', message: (error as Error)?.message || 'Writing to the folder failed.' }
}

/** Run `work` over `items` with at most `limit` in flight. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
    let next = 0
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) await work(items[next++])
    })
    await Promise.all(runners)
}

export function createLocalMirror(
    source: MirrorSource,
    adapter: DirectoryAdapter,
    options: LocalMirrorOptions = {},
): LocalMirror {
    const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    const assetConcurrency = options.assetConcurrency ?? DEFAULT_ASSET_CONCURRENCY
    const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    const now = options.now ?? (() => Date.now())

    /** The folder as the mirror believes it to be, after one read pass. */
    let disk: Map<Subdir, Map<string, DiskFile>> | undefined
    const written = new Map<string, WrittenDocument>()
    /** Documents whose content changed since they were last written. */
    const dirty = new Set<string>()
    /** Concepts a change named, resolved to document ids on the next pass. */
    const dirtyConcepts = new Set<string>()
    /** Referenced assets that could not be downloaded; retried on every pass. */
    let missingAssets: string[] = []
    /** Document links to attachments the graph does not hold; reported, never fetched. */
    let danglingLinks: MirrorDanglingLink[] = []
    let skipped: string[] = []
    let collisions: MirrorNameCollision[] = []
    let assetCount = 0

    let timer: ReturnType<typeof setTimeout> | undefined
    let detach: (() => void) | undefined
    let disposed = false
    let running = false
    let syncing = false
    /** Whether the next pass also sweeps strays, assets and metadata. */
    let sweepPending = true
    let queued = false
    let retries = 0
    let lastSyncAt: number | undefined
    let paused: MirrorPause | undefined
    let pass: MirrorStatus['pass']
    const statusListeners = new Set<(status: MirrorStatus) => void>()

    function snapshot(): MirrorStatus {
        return {
            folder: options.folder ?? '',
            running,
            syncing,
            pass: pass && { kind: pass.kind, progress: { ...pass.progress } },
            paused,
            lastSyncAt,
            documents: written.size,
            assets: assetCount,
            skipped: [...skipped],
            collisions: [...collisions],
            missingAssets: [...missingAssets],
            danglingLinks: [...danglingLinks],
        }
    }

    function announce(): void {
        const status = snapshot()
        for (const listener of statusListeners) listener(status)
    }

    /**
     * Move the running pass to a phase, or advance it within one. A host that only hears about
     * the start and the end of a long pass can say nothing useful during the part that takes
     * time, so this announces - but not per file: every announcement snapshots every list the
     * status carries, and a listener cannot read 3,000 of them in the time they take to make.
     * Phase changes and the last item always go out; in between, one in every
     * PROGRESS_ANNOUNCE_EVERY.
     */
    function progress(phase: MirrorProgress['phase'], done: number, total: number): void {
        if (!pass) return
        const phaseChanged = pass.progress.phase !== phase
        pass.progress = { phase, done, total }
        if (phaseChanged || done === total || done % PROGRESS_ANNOUNCE_EVERY === 0) announce()
    }

    /** True once the pass under way should stop where it is: the mirror was stopped or disposed. */
    function halted(): boolean {
        return disposed || !running
    }

    function listen(): void {
        if (detach) return
        detach = source.onChange((change) => {
            if (disposed || !running) return
            // A named change is one document's content. An unnamed one moved the registry, so
            // the next pass has to reconsider every name, stray and asset.
            if (change?.concept) dirtyConcepts.add(conceptKey(change.concept))
            else sweepPending = true
            schedule(debounceMs)
        })
    }

    /**
     * Bring the in-memory view of the folder in line with what is actually there. The first pass
     * of a session reads every file, which is how the delta after any interruption is established
     * without downloading anything; after that only a file whose mtime moved is read again, so a
     * hand edit or an external delete is still found (ADR 0008: the server is master) at the cost
     * of one directory listing.
     */
    async function refreshDisk(): Promise<void> {
        const model = new Map<Subdir, Map<string, DiskFile>>()
        const listings = new Map<Subdir, Awaited<ReturnType<DirectoryAdapter['list']>>>()
        for (const subdir of MIRRORED_SUBDIRS) listings.set(subdir, await adapter.list(subdir))
        const markdown = [...listings.values()].flat().filter((entry) => entry.name.toLowerCase().endsWith('.md'))
        let scanned = 0
        progress('scanning', 0, markdown.length)
        for (const subdir of MIRRORED_SUBDIRS) {
            const before = disk?.get(subdir)
            const files = new Map<string, DiskFile>()
            for (const entry of listings.get(subdir)!) {
                if (!entry.name.toLowerCase().endsWith('.md')) continue
                progress('scanning', ++scanned, markdown.length)
                const key = entry.name.toLowerCase()
                const known = before?.get(key)
                if (known && known.mtime === entry.lastModified) {
                    files.set(key, known)
                    continue
                }
                let text: string
                try {
                    text = (await adapter.read(subdir, entry.name)).text
                } catch {
                    continue // vanished between the listing and the read
                }
                files.set(key, {
                    name: entry.name,
                    concept: claimedConcept(entry.name, text),
                    hash: await hashText(text),
                    mtime: entry.lastModified,
                })
            }
            model.set(subdir, files)
        }
        disk = model
    }

    /** The folder's markdown as the name planner needs it: real names and the concepts claimed. */
    function existingFiles(): Map<Subdir, MirrorFile[]> {
        const out = new Map<Subdir, MirrorFile[]>()
        for (const subdir of MIRRORED_SUBDIRS) {
            out.set(subdir, [...(disk?.get(subdir)?.values() ?? [])].map(({ name, concept }) => ({ name, concept })))
        }
        return out
    }

    function needsWrite(doc: MirrorDocument, fileName: string): boolean {
        const previous = written.get(doc.docId)
        if (!previous) return true
        if (previous.fileName !== fileName) return true
        if (previous.identity !== identityOf(doc)) return true
        if (dirty.has(doc.docId)) return true
        // Edited or deleted behind our back: the folder is app-managed, so put it right.
        const current = disk?.get(mirrorSubdir(doc.kind))?.get(fileName.toLowerCase())
        return !current || current.hash !== previous.hash
    }

    /** One pass. Resolves true when it ran to the end, false when it was halted part way. */
    async function runSync(sweep: boolean): Promise<boolean> {
        await adapter.ensureSkeleton()
        // A targeted pass writes one document's own change, so the folder cannot have moved
        // under it in a way that pass would act on; a full one always looks first.
        if (sweep || !disk) await refreshDisk()
        const docs = source.listDocuments()
        const plan = planMirrorNames(docs, existingFiles())
        collisions = plan.collisions

        if (dirtyConcepts.size > 0) {
            for (const doc of docs) {
                if (dirtyConcepts.has(conceptKey(doc.concept))) dirty.add(doc.docId)
            }
            dirtyConcepts.clear()
        }

        const targets = new Set(
            docs.filter((doc) => needsWrite(doc, plan.byDocId.get(doc.docId)!)).map((doc) => doc.docId),
        )
        progress('reading', 0, targets.size)
        const texts =
            targets.size > 0
                ? await source.readTexts([...targets], (done, total) => progress('reading', done, total))
                : new Map<string, MirrorText>()
        if (halted()) return false
        progress('writing', 0, targets.size)

        // A rename is a remove and a write, and the order matters twice over. A file whose old
        // name is what some document is about to be written as - including its own name in
        // another case, which a case-insensitive filesystem treats as the same file - has to go
        // BEFORE that write, or the write lands in it and the later remove destroys the result.
        // Every other rename writes first and removes after, so a failure part way leaves the
        // old copy rather than nothing. And a document whose content cannot be confirmed keeps
        // its old file untouched, which means nothing else may take that name this pass.
        const targetKeys = new Set([...plan.byDocId.values()].map((name) => name.toLowerCase()))
        const kept = new Map<Subdir, Set<string>>([
            ['journals', new Set<string>()],
            ['pages', new Set<string>()],
        ])
        for (const doc of docs) {
            const old = plan.renameFrom.get(doc.docId)
            if (!old) continue
            const settled = targets.has(doc.docId) && texts.get(doc.docId)?.settled
            if (!settled) kept.get(mirrorSubdir(doc.kind))!.add(old.toLowerCase())
        }
        for (const doc of docs) {
            const old = plan.renameFrom.get(doc.docId)
            if (!old || !targets.has(doc.docId) || !texts.get(doc.docId)?.settled) continue
            if (!targetKeys.has(old.toLowerCase())) continue
            if (halted()) return false
            const subdir = mirrorSubdir(doc.kind)
            await adapter.remove(subdir, old)
            disk!.get(subdir)!.delete(old.toLowerCase())
        }

        const nextSkipped: string[] = []
        let considered = 0
        /** Whether any document's asset references changed, which is what the asset pass is for. */
        let refsChanged = false
        for (const doc of docs) {
            const fileName = plan.byDocId.get(doc.docId)!
            const subdir = mirrorSubdir(doc.kind)
            if (!targets.has(doc.docId)) continue
            if (halted()) return false
            progress('writing', ++considered, targets.size)
            const got = texts.get(doc.docId)
            if (!got || !got.settled) {
                // Never put an unconfirmed body on disk: on a warm cache an unread document
                // reads empty, and writing that would replace real content with nothing.
                nextSkipped.push(doc.concept)
                continue
            }
            if (kept.get(subdir)!.has(fileName.toLowerCase())) {
                // The name is still held by a document that could not be confirmed this pass.
                nextSkipped.push(doc.concept)
                continue
            }
            const text = mirrorFileText(doc, fileName, got.text)
            const hash = await hashText(text)
            const old = plan.renameFrom.get(doc.docId)
            const current = disk!.get(subdir)!.get(fileName.toLowerCase())
            if (old || !current || current.hash !== hash) {
                const { lastModified } = await adapter.write(subdir, fileName, text)
                disk!.get(subdir)!.set(fileName.toLowerCase(), {
                    name: fileName,
                    concept: claimedConcept(fileName, text),
                    hash,
                    mtime: lastModified,
                })
            }
            if (old && old.toLowerCase() !== fileName.toLowerCase() && disk!.get(subdir)!.has(old.toLowerCase())) {
                await adapter.remove(subdir, old)
                disk!.get(subdir)!.delete(old.toLowerCase())
            }
            // A document that moved to another name leaves its old file behind. It is not
            // touched here: it claims a concept nothing holds now, so the sweep takes it, and
            // hiding it from the sweep is what left renamed pages duplicated in the folder.
            const refs = referencedAssetNames(text)
            const previous = written.get(doc.docId)
            if (!previous || previous.refs.join('\n') !== refs.join('\n')) refsChanged = true
            written.set(doc.docId, { fileName, concept: doc.concept, hash, identity: identityOf(doc), refs })
            dirty.delete(doc.docId)
        }
        skipped = nextSkipped

        const live = new Set(docs.map((doc) => doc.docId))
        for (const docId of [...written.keys()]) if (!live.has(docId)) written.delete(docId)

        const registryConfirmed = sweep ? await source.confirmRegistry() : false
        if (halted()) return false
        if (registryConfirmed) {
            const claimed = new Map<Subdir, Set<string>>()
            for (const subdir of MIRRORED_SUBDIRS) {
                claimed.set(subdir, new Set([...plan.claimed.get(subdir)!, ...kept.get(subdir)!]))
            }
            await removeStrays(claimed)
        }
        // A full pass always reconciles assets. A targeted one does so only when a document's
        // references moved - pasting an image is a content change like any other, and waiting
        // for the next registry change to fetch its bytes would leave the folder holding a link
        // to a file that is not in it - and otherwise costs no listing and no server call at all.
        if (sweep || refsChanged) {
            if (!(await syncAssets())) return false
        }
        if (sweep) await writeGraphMetadata()
        return true
    }

    /** Faithful reflection: any `.md` the server graph no longer contains goes. */
    async function removeStrays(claimed: Map<Subdir, Set<string>>): Promise<void> {
        for (const subdir of MIRRORED_SUBDIRS) {
            const held = disk!.get(subdir)!
            for (const [key, file] of [...held]) {
                if (claimed.get(subdir)!.has(key)) continue
                await adapter.remove(subdir, file.name)
                held.delete(key)
            }
        }
    }

    /**
     * Bring `assets/` in line with **what the graph holds**, which the server can enumerate, and
     * not with what a regex found in the documents.
     *
     * That distinction is the whole safety of this pass. Reference scanning cannot see inside a
     * [[Protected Document]] - its body is ciphertext in a fence - so an attachment used only
     * there was never downloaded, and worse, was deleted from the folder as a stray. Anything the
     * scan failed to see, it removed. Enumeration answers "does the graph hold this?" directly,
     * which is ADR 0008's rule stated rather than inferred, and it backs up an [[Orphaned Asset]]
     * too: the graph holds it and it counts against the account's storage, so the copy the user
     * owns should have it. Cleaning orphans up from Settings removes them from the folder on the
     * next pass, because they leave the server's list.
     *
     * The documents still decide **names**: one asset can be referenced under several stems, and a
     * link only resolves in another tool if the file is called what the markdown says. An asset
     * nothing names is stored under the name its own metadata carries.
     */
    async function syncAssets(): Promise<boolean> {
        const { listGraphAssets, fetchAsset, assetIdOf } = source
        if (!listGraphAssets || !fetchAsset || !assetIdOf) return true
        const held = await listGraphAssets()
        if (halted()) return false
        // The server could not be asked, so the folder is left exactly as it is. Deleting against
        // a list that could not be fetched is the one move nothing can undo.
        if (!held) return true
        const graphAssets = new Set(held)

        // What the documents point at, grouped by the asset each reference names.
        const namesById = new Map<string, Set<string>>()
        const dangling: MirrorDanglingLink[] = []
        for (const record of written.values()) {
            for (const name of record.refs) {
                const assetId = assetIdOf(name)
                if (!assetId || !graphAssets.has(assetId)) {
                    // A link to something this graph does not hold. An [[Import]] that could not
                    // carry a file across leaves exactly this, and no pass will ever resolve it,
                    // so it is named for the user rather than retried for ever.
                    dangling.push({ name, concept: record.concept })
                    continue
                }
                const names = namesById.get(assetId) ?? new Set<string>()
                names.add(name)
                namesById.set(assetId, names)
            }
        }

        const onDisk = await adapter.list('assets')
        const filesById = new Map<string, string[]>()
        for (const entry of onDisk) {
            const assetId = assetIdOf(entry.name)
            if (!assetId) continue // not an asset of this graph; the stray pass below takes it
            filesById.set(assetId, [...(filesById.get(assetId) ?? []), entry.name])
        }

        const work: Array<{ assetId: string; names: string[]; copyFrom?: string }> = []
        for (const assetId of graphAssets) {
            const present = filesById.get(assetId) ?? []
            const wanted = [...(namesById.get(assetId) ?? [])]
            const absent = wanted.filter((name) => !present.includes(name))
            if (present.length === 0 && wanted.length === 0) work.push({ assetId, names: [] })
            else if (absent.length > 0) {
                // A reference whose stem changed needs another name, not another download: the
                // bytes are already here under the old one.
                work.push({ assetId, names: absent, ...(present.length > 0 ? { copyFrom: present[0] } : {}) })
            }
        }

        const failed: string[] = []
        let done = 0
        progress('assets', 0, work.length)
        await pool(work, assetConcurrency, async (item) => {
            if (halted()) return
            try {
                if (item.copyFrom) {
                    const { bytes } = await adapter.readBinary('assets', item.copyFrom)
                    for (const name of item.names) await adapter.writeBinary('assets', name, bytes)
                } else {
                    const result = await fetchAsset(item.assetId)
                    if (result === 'unavailable') failed.push(labelFor(item))
                    else {
                        const names = item.names.length > 0 ? item.names : [result.fileName]
                        for (const name of names) await adapter.writeBinary('assets', name, result.bytes)
                    }
                }
            } catch (error) {
                // One asset that will not come down is one asset's problem. Only a folder that
                // cannot be written to at all stops the mirror, so those failures still throw.
                if (classifyMirrorFailure(error).kind !== 'error') throw error
                failed.push(labelFor(item))
            }
            progress('assets', ++done, work.length)
        })

        // Faithful, and never at the cost of the last copy: a file goes when the graph no longer
        // holds its asset, or when it is a stale name for an asset another file already carries
        // under the name the documents use. Judged on the folder as it is NOW, after the writes
        // above: a name that has just been replaced is only stale once its replacement exists.
        const settled = new Map<string, string[]>()
        const strays: string[] = []
        for (const entry of await adapter.list('assets')) {
            const assetId = assetIdOf(entry.name)
            if (!assetId) {
                strays.push(entry.name)
                continue
            }
            settled.set(assetId, [...(settled.get(assetId) ?? []), entry.name])
        }
        for (const [assetId, names] of settled) {
            if (!graphAssets.has(assetId)) {
                strays.push(...names)
                continue
            }
            const wanted = namesById.get(assetId)
            if (!wanted || wanted.size === 0) continue
            if (!names.some((name) => wanted.has(name))) continue
            strays.push(...names.filter((name) => !wanted.has(name)))
        }
        if (halted()) return false
        for (const name of strays) await adapter.remove('assets', name)

        missingAssets = failed
        danglingLinks = dangling
        assetCount = (await adapter.list('assets')).length
        return true
    }

    /** What to call an asset in a report before its own name has been fetched. */
    function labelFor(item: { assetId: string; names: string[] }): string {
        return item.names[0] ?? `${item.assetId.slice(0, 8)}…`
    }

    /**
     * [[Graph Settings]] and the [[Graph Name]] are graph content, not per-device state, so they
     * travel with the folder - which is what makes it a complete Export rather than only its
     * documents. Written under the same compare-first rule as everything else.
     */
    async function writeGraphMetadata(): Promise<void> {
        const meta = source.metadata?.()
        if (!meta) return
        const settings = meta.settings && Object.keys(meta.settings).length > 0 ? meta.settings : undefined
        await writeIfChanged('settings.json', settings)
        await writeIfChanged('graph.json', meta.name ? { name: meta.name } : undefined)
        // Quick Notes are content that has not reached a journal yet (ADR 0078); the folder
        // is only a complete copy of the graph if it holds them too.
        if (meta.quickNotes) await writeTextIfChanged(QUICK_NOTES_FILE, quickNotesFileText(meta.quickNotes))
        // The Graph Dictionary (ADR 0095). No words, no file: a graph that never added one does
        // not grow an empty file; one that had words and removed them all has it emptied.
        if (meta.spellingDictionary) {
            if (meta.spellingDictionary.length > 0 || (await hasMetadataFile(DICTIONARY_FILE))) {
                await writeTextIfChanged(DICTIONARY_FILE, dictionaryFileText(meta.spellingDictionary))
            }
        }
        // Themes are graph content too (ADR 0082): one file each, and a file for a theme the
        // graph no longer has is a stray, removed like any other.
        if (meta.themes) {
            const keep = new Set<string>()
            for (const theme of meta.themes) {
                keep.add(themeFileName(theme.id))
                await writeTextIfChanged(themeFileName(theme.id), graphThemeFileText(theme))
            }
            let entries: { name: string }[] = []
            try {
                entries = await adapter.list('etherpk')
            } catch {
                // No etherpk/ yet: nothing stale to remove.
            }
            for (const entry of entries) {
                if (themeIdOfFileName(entry.name) !== null && !keep.has(entry.name)) await adapter.remove('etherpk', entry.name)
            }
        }
        // The copier's own protection record (ADR 0093): the one thing that lets the protected
        // documents in this folder be opened again without the account, by whoever holds the
        // passphrase. A record that cannot be read right now is not the same as no record.
        if (meta.protection) await writeTextIfChanged(PROTECTION_FILE, `${serialiseProtectionRecord(meta.protection)}\n`)
        else if (meta.protection === null && (await adapter.exists('etherpk', PROTECTION_FILE))) await adapter.remove('etherpk', PROTECTION_FILE)
    }

    async function writeIfChanged(name: string, value: Record<string, unknown> | undefined): Promise<void> {
        if (!value) return
        await writeTextIfChanged(name, `${JSON.stringify(value, null, 2)}\n`)
    }

    async function hasMetadataFile(name: string): Promise<boolean> {
        try {
            await adapter.read('etherpk', name)
            return true
        } catch {
            return false
        }
    }

    async function writeTextIfChanged(name: string, text: string): Promise<void> {
        try {
            if ((await adapter.read('etherpk', name)).text === text) return
        } catch {
            // Absent, so write it.
        }
        await adapter.write('etherpk', name, text)
    }

    function schedule(delay: number): void {
        if (disposed || !running || paused) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
            timer = undefined
            void pump()
        }, delay)
    }

    /** The pass under way, so a caller that needs to wait for it can. */
    let inFlight: Promise<void> | undefined

    function pump(): Promise<void> {
        if (disposed || !running || paused) return Promise.resolve()
        if (syncing) {
            queued = true
            return inFlight ?? Promise.resolve()
        }
        inFlight = runPass().finally(() => {
            inFlight = undefined
        })
        return inFlight
    }

    async function runPass(): Promise<void> {
        const sweep = sweepPending
        sweepPending = false
        queued = false
        syncing = true
        pass = { kind: sweep ? 'full' : 'targeted', progress: { phase: 'scanning', done: 0, total: 0 } }
        announce()
        let failure: MirrorPause | undefined
        try {
            if (await runSync(sweep)) {
                lastSyncAt = now()
                retries = 0
            } else {
                // Halted part way: what it did not get to is still to do.
                sweepPending = sweepPending || sweep
            }
        } catch (error) {
            failure = classifyMirrorFailure(error)
            // The in-memory view of the folder is suspect after a failure; read it again.
            disk = undefined
            sweepPending = true
        } finally {
            syncing = false
            pass = undefined
        }
        if (failure) {
            if (failure.kind === 'error' && retries < retryDelays.length) {
                const delay = retryDelays[retries++]
                announce()
                schedule(delay)
                return
            }
            paused = failure
            running = false
        }
        announce()
        if (queued && !paused) schedule(debounceMs)
    }

    return {
        start() {
            // A paused mirror is not started over the top of its pause: `resume` is the way back,
            // because a pause is a fact about the folder that starting again would not change.
            if (disposed || running || paused) return
            running = true
            sweepPending = true
            listen()
            announce()
            void pump()
        },
        async sync() {
            if (disposed || paused) return
            running = true
            sweepPending = true
            listen()
            // "Now" means now: a pass already waiting on the debounce is folded into this one.
            if (timer) {
                clearTimeout(timer)
                timer = undefined
            }
            // A pass already under way may be a targeted one that will not sweep. Let it finish,
            // then run the full pass this call asked for, and resolve only once that has ended -
            // a "Mirror now" that resolved while the folder was still being written was a lie.
            if (syncing) {
                queued = true
                await inFlight
                // The pass that just ended saw `queued` and put a follow-up on the debounce. This
                // call IS that follow-up, run now rather than later, so that timer has no job.
                if (timer) {
                    clearTimeout(timer)
                    timer = undefined
                }
            }
            if (sweepPending) await pump()
        },
        stop() {
            running = false
            if (timer) clearTimeout(timer)
            timer = undefined
            detach?.()
            detach = undefined
            announce()
        },
        dispose() {
            disposed = true
            running = false
            if (timer) clearTimeout(timer)
            timer = undefined
            detach?.()
            detach = undefined
            statusListeners.clear()
        },
        status: snapshot,
        onStatus(listener) {
            statusListeners.add(listener)
            return () => statusListeners.delete(listener)
        },
        resume() {
            if (disposed) return
            paused = undefined
            retries = 0
            disk = undefined
            running = true
            sweepPending = true
            listen()
            announce()
            void pump()
        },
    }
}
