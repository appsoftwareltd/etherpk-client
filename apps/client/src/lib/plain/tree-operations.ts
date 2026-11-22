/**
 * What the file tree does to a [[Plain Folder]]: create a file or a directory, rename or move an
 * entry, and delete one (ADR 0194).
 *
 * These are the only writes EtherPK makes that the person did not type into a file, so each is
 * something they asked for by name. Open files follow a move and are dropped by a delete
 * (plain-folder-store.ts), and a delete says what goes before it happens: the File System Access
 * API has no bin, so a deleted file is gone.
 *
 * Every failure is an `Error` whose message is a sentence for the person.
 */
import type { FolderTreeAdapter } from './folder-tree-adapter'
import type { PlainFolderStore } from './plain-folder-store'
import { baseName, dirOf, joinPath, normalisePath } from './plain-path'

/** Characters no file system here takes in a name, or that would mean something else in a path. */
const FORBIDDEN = /[\\/:*?"<>|]/
/** A control character: a tab or a newline pasted into a name, which no listing would show. */
const hasControlCharacter = (text: string) => [...text].some((char) => char.charCodeAt(0) < 0x20)

/** Why `name` cannot be a file's or a directory's name, as a sentence, or null when it can. */
export function nameProblem(name: string): string | null {
    const trimmed = name.trim()
    if (trimmed === '') return 'Type a name.'
    if (trimmed === '.' || trimmed === '..') return 'That name means a folder, not a file in it.'
    if (FORBIDDEN.test(trimmed) || hasControlCharacter(trimmed)) return 'A name cannot hold any of \\ / : * ? " < > |.'
    if (trimmed.endsWith('.') || trimmed.endsWith(' ')) return 'A name cannot end with a dot or a space.'
    return null
}

type Tree = Pick<FolderTreeAdapter, 'stat' | 'write' | 'createDirectory' | 'move' | 'remove' | 'list'>
type Store = Pick<PlainFolderStore, 'settleUnder' | 'moved' | 'removed'>

async function freePath(tree: Tree, dir: string, name: string): Promise<string> {
    const problem = nameProblem(name)
    if (problem) throw new Error(problem)
    const path = joinPath(dir, name.trim().normalize('NFC'))
    if ((await tree.stat(path)) !== null) throw new Error(`“${baseName(path)}” is already here. Choose another name.`)
    return path
}

/** Create an empty file named `name` in `dir`. Resolves with its path. */
export async function createFile(tree: Tree, dir: string, name: string): Promise<string> {
    const path = await freePath(tree, dir, name)
    await tree.write(path, new Uint8Array(0))
    return path
}

/** Create a directory named `name` in `dir`. Resolves with its path. */
export async function createFolder(tree: Tree, dir: string, name: string): Promise<string> {
    const path = await freePath(tree, dir, name)
    await tree.createDirectory(path)
    return path
}

/**
 * Move or rename the entry at `from` to the path `to`, creating the directories `to` sits in.
 * Unsaved edits to files under `from` are saved first, and those files stay open under their new
 * paths. Resolves with the new path.
 */
export async function moveEntry(tree: Tree, store: Store, from: string, to: string): Promise<string> {
    const target = normalisePath(to.trim())
    if (target === null) throw new Error('That path leaves the folder.')
    if (target === '') throw new Error('Type a name.')
    const problem = target.split('/').map(nameProblem).find((found) => found !== null)
    if (problem) throw new Error(problem)
    if (target === from) return from
    if (target.startsWith(`${from}/`)) throw new Error('A folder cannot be moved into itself.')
    const there = await tree.stat(target)
    // A change of case alone names the same entry on a file system that ignores case.
    if (there !== null && target.toLowerCase() !== from.toLowerCase()) throw new Error(`“${baseName(target)}” is already there. Choose another name.`)
    await store.settleUnder(from)
    await tree.createDirectory(dirOf(target))
    await tree.move(from, target)
    store.moved(from, target)
    return target
}

/** The walk that counts what a delete would take stops here: beyond it the sentence says "more than". */
const COUNT_LIMIT = 2000

/**
 * The sentence a delete is confirmed with: what goes, and that it cannot be undone. A directory
 * names how many files go with it.
 */
export async function deleteSentence(tree: Tree, path: string, kind: 'file' | 'directory'): Promise<string> {
    const name = baseName(path)
    if (kind === 'file') return `Delete “${name}”? This cannot be undone: the file is removed from the folder, not moved to a bin.`
    const { files, more } = await countFilesUnder(tree, path)
    const holds = files === 0 ? 'which is empty' : `and the ${more ? 'more than ' : ''}${files} ${files === 1 ? 'file' : 'files'} in it`
    return `Delete the folder “${name}” ${holds}? This cannot be undone: they are removed, not moved to a bin.`
}

async function countFilesUnder(tree: Tree, path: string): Promise<{ files: number; more: boolean }> {
    let files = 0
    const pending = [path]
    while (pending.length > 0) {
        const dir = pending.pop()!
        for (const entry of await tree.list(dir)) {
            if (entry.kind === 'directory') pending.push(joinPath(dir, entry.name))
            else if (++files >= COUNT_LIMIT) return { files, more: true }
        }
    }
    return { files, more: false }
}

/** Delete the entry at `path`, a directory with everything in it. Open files there are closed. */
export async function deleteEntry(tree: Tree, store: Store, path: string): Promise<void> {
    await tree.remove(path)
    store.removed(path)
}
