/**
 * The Favourites of a [[Plain Folder]]: the files a person keeps at the top of the file tree. Each
 * is a file of the folder's hidden `.etherpk` folder (plain-state-folder.ts, ADR 0197), so two
 * people who each add one add two files.
 *
 * A favourite names its file by path. One whose file is gone stays listed and says so when it is
 * opened: the file may be on another branch, and removing the favourite is the person's to do.
 */
import { sha1 } from '../document/ebook/sha1'

import type { PlainStateFolder } from './plain-state-folder'

export const FAVOURITES = 'favourites'

/** A favourite's file name: a hash of the path, which can hold characters a file name cannot. */
export function favouriteId(path: string): string {
    return [...sha1(path)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The favourite paths kept in the folder, sorted by name then path. */
export async function readFavourites(folder: PlainStateFolder): Promise<string[]> {
    const paths = new Set<string>()
    for (const item of await folder.list(FAVOURITES)) {
        const path = typeof item.value === 'object' && item.value !== null ? (item.value as { path?: unknown }).path : undefined
        if (typeof path === 'string' && path !== '') paths.add(path)
    }
    return sortFavourites([...paths])
}

const leaf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export function sortFavourites(paths: readonly string[]): string[] {
    return [...paths].sort((a, b) => leaf(a).localeCompare(leaf(b), undefined, { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0))
}

export const addFavourite = (folder: PlainStateFolder, path: string): Promise<void> => folder.put(FAVOURITES, favouriteId(path), { path })
export const removeFavourite = (folder: PlainStateFolder, path: string): Promise<void> => folder.remove(FAVOURITES, favouriteId(path))

/** The favourites a move in the tree changes: each as it was and as it is now. */
export function movedFavourites(paths: readonly string[], from: string, to: string): Array<{ was: string; now: string }> {
    return paths.filter((path) => path === from || path.startsWith(`${from}/`)).map((was) => ({ was, now: to + was.slice(from.length) }))
}
