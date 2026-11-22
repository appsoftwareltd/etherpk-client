/**
 * The address of a [[Plain Folder]] and of a file in it: `/folder/<name>/f/<path>` (ADR 0194).
 *
 * `/graph` names graphs only (ADR 0192), so a Plain Folder has its own first segment. The name is
 * the folder's own name, as a Folder graph's is, and the file's path is in the address so that a
 * reload, Back and a copied link all return to the same file. Two folders can share a name; the
 * address then names both and the person is asked which one (`resolvePlainAddress`).
 *
 * Pure.
 */
import { normalisePath } from './plain-path'
import type { PlainFolderRecord } from './plain-folder-registry'

const PREFIX = '/folder/'

/** `/folder/<name>`: the folder itself. */
export function plainFolderUrl(name: string): string {
    return `${PREFIX}${encodeURIComponent(name)}`
}

/** `/folder/<name>/f/<path>`: one file. Each segment is escaped, so a slash stays a separator. */
export function plainFileUrl(name: string, path: string): string {
    return `${plainFolderUrl(name)}/f/${path.split('/').map(encodeURIComponent).join('/')}`
}

/** True for any address under `/folder/`. */
export function isPlainFolderPath(pathname: string): boolean {
    return pathname.startsWith(PREFIX) && pathname.length > PREFIX.length
}

function decoded(text: string): string | null {
    try {
        return decodeURIComponent(text)
    } catch {
        return null
    }
}

/**
 * The folder name and file path an address names. `path` is null for the folder itself. Null for
 * an address that is not a Plain Folder's, or whose path would leave the folder.
 */
export function parsePlainUrl(pathname: string): { name: string; path: string | null } | null {
    const match = /^\/folder\/([^/]+)(?:\/(.*))?$/.exec(pathname)
    if (!match) return null
    const name = decoded(match[1])
    if (name === null || name === '') return null
    const rest = match[2] ?? ''
    if (rest === '') return { name, path: null }
    if (!rest.startsWith('f/')) return null
    const parts = rest.slice(2).split('/').map(decoded)
    if (parts.some((part) => part === null)) return null
    const path = normalisePath(parts.join('/'))
    if (path === null) return null
    return { name, path: path === '' ? null : path }
}

/**
 * What a navigation to a folder's address carries in its history entry, to say which folder was
 * chosen: two folders with one name have one address, as two Folder graphs do (ADR 0192).
 */
export function chosenPlainFolderState(folder: Pick<PlainFolderRecord, 'id'>): { etherpkPlainFolder: string } {
    return { etherpkPlainFolder: folder.id }
}

/** Which of this device's Plain Folders an address names. */
export type PlainAddressResolution =
    | { kind: 'held'; folder: PlainFolderRecord }
    /** More than one folder has the name: the person says which. */
    | { kind: 'choice'; folders: PlainFolderRecord[] }
    | { kind: 'not-held' }

export function resolvePlainAddress(name: string, folders: readonly PlainFolderRecord[]): PlainAddressResolution {
    const named = folders.filter((folder) => folder.name === name)
    if (named.length === 0) return { kind: 'not-held' }
    return named.length === 1 ? { kind: 'held', folder: named[0] } : { kind: 'choice', folders: named }
}
