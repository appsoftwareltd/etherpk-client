/**
 * Where a Filesystem graph's folder sits on **this device**, as an absolute path - what "Copy
 * full file path" on a document tab joins the file's name onto, so the path can be handed to a
 * tool outside the browser (an AI agent, an editor) that edits the file directly.
 *
 * The browser does not know this. The File System Access API hands back a
 * `FileSystemDirectoryHandle` whose only name is the folder's leaf (`notes`, never
 * `/home/you/notes`), deliberately: a site is not told where on disk a picked folder lives.
 * So the path is typed once by the user and remembered here, per device and per graph in
 * localStorage - the same home as [[Recents]] and reading positions (ADR 0013), because a path
 * on one machine means nothing on another and must never travel with the graph.
 *
 * Convenience, never load-bearing: nothing reads or writes the graph through it. It is only ever
 * pasted somewhere else, so a wrong value costs a wrong paste, not data.
 */

import type { Subdir } from './directory-adapter'

export const FOLDER_PATH_KEY_PREFIX = 'etherpk-folder-path:'

/** The remembered absolute path of the graph's folder on this device, or null when none is set. */
export function readGraphFolderPath(
    graphId: string,
    storage: Storage | undefined = globalThis.localStorage,
): string | null {
    try {
        const raw = storage?.getItem(`${FOLDER_PATH_KEY_PREFIX}${graphId}`)?.trim()
        return raw ? raw : null
    } catch {
        return null
    }
}

/** Remember the folder's path for this device. Blank forgets it. */
export function writeGraphFolderPath(
    graphId: string,
    path: string,
    storage: Storage | undefined = globalThis.localStorage,
): void {
    const key = `${FOLDER_PATH_KEY_PREFIX}${graphId}`
    const trimmed = path.trim()
    // Best-effort, as with every per-device convenience: a blocked or full store must not
    // break the copy that asked for the path.
    try {
        if (trimmed === '') storage?.removeItem(key)
        else storage?.setItem(key, trimmed)
    } catch {
        /* storage blocked - the caller still has the value for this copy */
    }
}

/**
 * The full path of a file in the graph: the folder path, then the content subdirectory, then
 * the file name. The separator follows the folder path - backslashes only when it uses them and
 * nothing else, so a Windows path pastes back as it was typed and everything else gets `/`.
 */
export function joinGraphPath(folderPath: string, subdir: Subdir, fileName: string): string {
    const folder = folderPath.trim()
    const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/'
    const base = folder.replace(/[\\/]+$/, '')
    return [base, subdir, fileName].join(separator)
}
