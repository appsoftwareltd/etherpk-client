/**
 * Scan a graph directory into its document registry: list `journals/` and `pages/`, parse each
 * `.md` file's frontmatter, and resolve identity. Pure over the {@link DirectoryAdapter} so it
 * runs in Node over the in-memory fake.
 *
 * A page's identity lives in its frontmatter (`title`, `aliases`; ADR 0007), so learning what a
 * file is means reading it. The first scan reads every file. A later scan is given the entries
 * of the last one and reuses each whose listing mtime and size both match, reading only files
 * that are new or moved; that is the same `(mtime, size)` fast path the store's per-document
 * reconcile keys on, with the same blind spot (an edit that changes neither stamp is seen when
 * the stamps next move, or at the next graph open). Reading only what moved is also what keeps
 * the browser's poll from holding open the very file the store is saving: on Windows a read
 * handle on the target makes the browser's rename of its swap file over it fail
 * ([[Filesystem Backend]] → Reconciliation).
 */

import type { DirectoryAdapter, DirEntry, Subdir } from './directory-adapter'
import { parseFrontmatter } from './frontmatter'
import {
    type DocumentKind,
    aliasesOf,
    conceptKey,
    conceptOf,
    documentKindOf,
    fileStem,
    journalConceptOf,
} from './identity'

export interface DocumentEntry {
    kind: DocumentKind
    /** Display concept name (case-preserving). */
    concept: string
    /** Case-insensitive identity key (`conceptKey(concept)`). */
    key: string
    subdir: Subdir
    fileName: string
    aliases: string[]
    lastModified: number
    /** Bytes on disk, from the listing. With the mtime, the store's "unchanged, skip the read" key. */
    size: number
}

export interface ScanOptions {
    /**
     * The entries of the last scan. One whose file is listed with the same mtime and size is
     * returned as it is - the same object, so stamps the store records on it after its own
     * write carry over - and its file is not read.
     */
    previous?: Iterable<DocumentEntry>
    /**
     * Files the store is writing at this moment. Such a file keeps its previous entry whatever
     * the listing says, because the bytes on disk are the store's own and the entry's stamps
     * are set from the write when it settles; a file with no previous entry is read.
     */
    writeInFlight?: (subdir: Subdir, fileName: string) => boolean
}

const SCANNED_SUBDIRS: Subdir[] = ['journals', 'pages']

/** Whether a listed name is a document file: `.md`, in any case. A `.crswap` swap file is not. */
export function isDocumentFile(name: string): boolean {
    return /\.md$/i.test(name)
}

function fileKey(subdir: Subdir, fileName: string): string {
    return `${subdir}/${fileName}`
}

/** A file's text, or null when it is no longer there. Any other failure is the caller's. */
async function readUnlessGone(adapter: DirectoryAdapter, subdir: Subdir, name: string): Promise<string | null> {
    try {
        return (await adapter.read(subdir, name)).text
    } catch (error) {
        if ((error as DOMException | null)?.name === 'NotFoundError') return null
        throw error
    }
}

/** Where a scan stands: the last scan's entries by file, and the files a save is writing now. */
interface ScanContext {
    adapter: DirectoryAdapter
    previous: Map<string, DocumentEntry>
    writeInFlight: (subdir: Subdir, fileName: string) => boolean
}

/**
 * The entry for one listed document file: the last scan's, when the listing's stamps have not moved
 * (or a save of ours is writing it), else read from the file. Null for a file removed since the
 * listing (a delete or a rename finishing while a reconcile scans): it is gone.
 */
async function entryFor(context: ScanContext, subdir: Subdir, kind: DocumentKind, listed: DirEntry): Promise<DocumentEntry | null> {
    const { name, lastModified, size } = listed
    const known = context.previous.get(fileKey(subdir, name))
    if (known && ((known.lastModified === lastModified && known.size === size) || context.writeInFlight(subdir, name))) return known
    const text = await readUnlessGone(context.adapter, subdir, name)
    if (text === null) return null
    const fm = parseFrontmatter(text)
    const concept = kind === 'journal' ? journalConceptOf(name) : conceptOf(fm, fileStem(name))
    return { kind, concept, key: conceptKey(concept), subdir, fileName: name, aliases: aliasesOf(fm), lastModified, size }
}

export async function scanGraph(adapter: DirectoryAdapter, options: ScanOptions = {}): Promise<DocumentEntry[]> {
    const previous = new Map<string, DocumentEntry>()
    for (const entry of options.previous ?? []) previous.set(fileKey(entry.subdir, entry.fileName), entry)
    const context: ScanContext = { adapter, previous, writeInFlight: options.writeInFlight ?? (() => false) }

    const journals: DocumentEntry[] = []
    const pages: DocumentEntry[] = []

    for (const subdir of SCANNED_SUBDIRS) {
        const kind = documentKindOf(subdir)
        if (!kind) continue
        for (const listed of await adapter.list(subdir)) {
            if (!isDocumentFile(listed.name)) continue
            const entry = await entryFor(context, subdir, kind, listed)
            if (entry) (kind === 'journal' ? journals : pages).push(entry)
        }
    }

    journals.sort((a, b) => b.concept.localeCompare(a.concept)) // dates descending
    pages.sort((a, b) => a.key.localeCompare(b.key)) // concept, case-insensitive ascending
    return [...journals, ...pages]
}
