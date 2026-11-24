/**
 * What a person wrote on a file of a [[Plain Folder]], removed when they delete the file in EtherPK
 * (ADR 0197, amended 2026-11-24): its annotations, form values and highlights in the hidden
 * `.etherpk` folder, and its bookmarks and Favourites by {@link bookmarkGoes} and {@link isUnder}.
 *
 * **The rule** is {@link isAbout} read both ways: an item goes when it is about a file that was
 * deleted and about no file that is left. Two files with the same bytes show the same items, so
 * while a copy is left what is kept by those bytes stays.
 *
 * **In two steps**, because a file's bytes are needed to know what is about it. {@link readDeleted}
 * reads them before the delete, and {@link forgetDeleted} removes the items after it, once the
 * file's tab has closed and its last writes are in the folder. A delete that fails removes nothing.
 *
 * **When in doubt an item stays**: a copy that cannot be read, or a folder too large to look through
 * in full, counts as a file that still has the item. A file that vanishes outside EtherPK never
 * comes here, and keeps everything.
 */
import { sha256Hex } from '../crypto/digest'
import { isReaderFile } from '../document/reader-file'

import type { EntryKind, FolderTreeAdapter } from './folder-tree-adapter'
import { isHiddenEntry } from './file-tree'
import { joinPath } from './plain-path'
import { EBOOK_HIGHLIGHTS, fileOfItem, PDF_ANNOTATIONS, PDF_FORMS } from './plain-reader-state'
import type { PlainStateFolder } from './plain-state-folder'

const KINDS = [PDF_ANNOTATIONS, PDF_FORMS, EBOOK_HIGHLIGHTS] as const
type Kind = (typeof KINDS)[number]
type Tree = Pick<FolderTreeAdapter, 'list' | 'read' | 'stat'>

/** Beyond this many files the folder is not looked through, and what is kept by a file's bytes stays. */
export const SURVIVOR_LIMIT = 20_000

/** Whether `path` is the deleted entry, or a file in it when it was a directory. */
export const isUnder = (path: string, deleted: string): boolean => path === deleted || path.startsWith(`${deleted}/`)

/** The deleted entry, with the hashes and sizes of the PDFs and EBooks that went with it. */
export interface DeletedFiles {
    path: string
    hashes: ReadonlyMap<string, number>
}

/** Which hashes and paths are still in the folder, as far as anyone can tell. */
export interface Survivors {
    hasHash(hash: string): boolean
    hasPath(path: string): boolean
}

/** Whether an item about `file` goes with the deleted entry: about a deleted file, and about none that is left. */
export function itemGoes(file: { path: string; hash: string }, deleted: DeletedFiles, left: Survivors): boolean {
    if (!isUnder(file.path, deleted.path) && !deleted.hashes.has(file.hash)) return false
    return !left.hasHash(file.hash) && !left.hasPath(file.path)
}

/** Whether a page's or a place's bookmark goes: it opens the deleted file, or nothing left holds its bytes. */
export function bookmarkGoes(bookmark: { hash: string; target: string }, deleted: DeletedFiles, left: Survivors): boolean {
    if (isUnder(bookmark.target, deleted.path)) return true
    return deleted.hashes.has(bookmark.hash) && !left.hasHash(bookmark.hash) && !left.hasPath(bookmark.target)
}

async function hashOf(tree: Tree, path: string): Promise<{ hash: string; size: number }> {
    const { bytes, size } = await tree.read(path)
    return { hash: await sha256Hex(bytes), size }
}

/** Every file under `start`, or null when there are more than {@link SURVIVOR_LIMIT}. */
async function filesUnder(tree: Tree, start: string): Promise<string[] | null> {
    const found: string[] = []
    const queue = [start]
    for (let at = 0; at < queue.length; at++) {
        const dir = queue[at]
        const entries = (await tree.list(dir)).filter((entry) => !isHiddenEntry(entry))
        const named = (kind: EntryKind) => entries.filter((entry) => entry.kind === kind).map((entry) => entry.name)
        // Every directory the tree shows, `node_modules` among them: a copy there is a copy.
        queue.push(...named('directory').map((name) => joinPath(dir, name)))
        found.push(...named('file').map((name) => joinPath(dir, name)))
        if (found.length > SURVIVOR_LIMIT) return null
    }
    return found
}

/** Every PDF and EBook under `start`, or null when the files are too many to look through or cannot be listed. */
async function readerFilesUnder(tree: Tree, start: string): Promise<string[] | null> {
    const files = await filesUnder(tree, start).catch(() => null)
    return files?.filter(isReaderFile) ?? null
}

interface KeptItem {
    kind: Kind
    id: string
    file: { path: string; hash: string }
}

async function itemsOf(folder: PlainStateFolder): Promise<KeptItem[]> {
    const items: KeptItem[] = []
    for (const kind of KINDS) {
        for (const { id, value } of await folder.list(kind)) {
            const file = fileOfItem(value)
            if (file) items.push({ kind, id, file })
        }
    }
    return items
}

/**
 * Read what `path` is, before it is deleted. A PDF or an EBook that cannot be read is left out: what
 * was written on it through this path is still found by the path. Nothing is read in a folder that
 * keeps nothing by a file's bytes.
 */
export async function readDeleted(tree: Tree, folder: PlainStateFolder, path: string, bookmarks: readonly unknown[] = []): Promise<DeletedFiles> {
    const hashes = new Map<string, number>()
    if (bookmarks.length === 0 && (await itemsOf(folder)).length === 0) return { path, hashes }
    const entry = await tree.stat(path)
    const files = entry?.kind === 'directory' ? ((await readerFilesUnder(tree, path)) ?? []) : [path].filter(isReaderFile)
    for (const file of files) {
        const read = await hashOf(tree, file).catch(() => null)
        if (read) hashes.set(read.hash, read.size)
    }
    return { path, hashes }
}

/**
 * What is left in the folder, the deleted entry aside, asked of `hashes` and `paths` only. A file is
 * read only when its size could be one of the hashes': a hash whose size is not known (what an older
 * version of a file held) has every PDF and EBook read.
 */
export async function survivorsOf(tree: Tree, deleted: DeletedFiles, hashes: ReadonlySet<string>, paths: ReadonlySet<string>): Promise<Survivors> {
    const left = new Set<string>()
    for (const path of paths) if (!isUnder(path, deleted.path) && (await tree.stat(path))?.kind === 'file') left.add(path)
    const held = await hashesLeft(tree, deleted, hashes)
    return { hasHash: (hash) => held === null || held.has(hash), hasPath: (path) => left.has(path) }
}

/** Which of `hashes` a file left in the folder has, or null when nobody can tell. */
async function hashesLeft(tree: Tree, deleted: DeletedFiles, hashes: ReadonlySet<string>): Promise<ReadonlySet<string> | null> {
    if (hashes.size === 0) return new Set()
    const files = await readerFilesUnder(tree, '')
    if (files === null) return null
    const sizes = new Set([...hashes].map((hash) => deleted.hashes.get(hash)))
    const couldBe = (size: number) => sizes.has(undefined) || sizes.has(size)
    const held = new Set<string>()
    for (const file of files.filter((path) => !isUnder(path, deleted.path))) {
        try {
            const stat = await tree.stat(file)
            if (stat?.kind === 'file' && couldBe(stat.size)) held.add((await hashOf(tree, file)).hash)
        } catch {
            // Closed to us, or going as it is read: it may hold any of the bytes asked about.
            return null
        }
    }
    return held
}

interface Going {
    items: KeptItem[]
    left: Survivors
}

/** The items that go with the deleted entry, and what is left to judge bookmarks of `hashes` by. */
async function goingWith(tree: Tree, folder: PlainStateFolder, deleted: DeletedFiles, bookmarks: readonly { hash: string; target: string }[]): Promise<Going> {
    const about = (file: { path: string; hash: string }) => isUnder(file.path, deleted.path) || deleted.hashes.has(file.hash)
    const items = (await itemsOf(folder)).filter((item) => about(item.file))
    const marks = bookmarks.filter((mark) => deleted.hashes.has(mark.hash))
    const left = await survivorsOf(
        tree,
        deleted,
        new Set([...items.map((item) => item.file.hash), ...marks.map((mark) => mark.hash)]),
        new Set([...items.map((item) => item.file.path), ...marks.map((mark) => mark.target)]),
    )
    return { items: items.filter((item) => itemGoes(item.file, deleted, left)), left }
}

/**
 * What would go with the entry at `path`, for the question a delete asks: "3 annotations",
 * "1 highlight", both, or null when nothing would.
 */
export async function notesGoingWith(tree: Tree, folder: PlainStateFolder, path: string): Promise<string | null> {
    const { items } = await goingWith(tree, folder, await readDeleted(tree, folder, path), [])
    const count = (kind: Kind, word: string) => {
        const held = items.filter((item) => item.kind === kind).length
        return held === 0 ? [] : [`${held} ${word}${held === 1 ? '' : 's'}`]
    }
    const said = [...count(PDF_ANNOTATIONS, 'annotation'), ...count(EBOOK_HIGHLIGHTS, 'highlight')]
    if (said.length === 0 && items.length > 0) return 'form entries'
    return said.length === 0 ? null : said.join(' and ')
}

/**
 * Remove what was written on the files that were deleted. Call it after the delete, with their tabs
 * closed. Answers what is left, which the bookmark lists and the reading places are judged by.
 */
export async function forgetDeleted(tree: Tree, folder: PlainStateFolder, deleted: DeletedFiles, bookmarks: readonly { hash: string; target: string }[]): Promise<Survivors> {
    // A highlight made just before the delete is in the folder before its items are read.
    await folder.settled()
    const { items, left } = await goingWith(tree, folder, deleted, bookmarks)
    for (const { kind, id } of items) await folder.remove(kind, id)
    return left
}
