/**
 * Files and folders dropped on a window. The paths come from the page's process, which the main
 * process does not trust: a page that had been taken over could send any path at all. So nothing is
 * granted until the person says yes to a dialog of the main process's own, which names every path.
 */
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { COPY } from '../copy.ts'

/** More than this in one drop are not listed one by one. */
export const MOST_LISTED = 10
/** A drop of more than this is not a person's. */
export const MOST_DROPPED = 100

export interface DropQuestion { message: string; detail: string }

export interface DropParts {
    /** Ask the person, in a dialog of the main process. True for yes. */
    ask(question: DropQuestion): Promise<boolean>
    /** Hand the paths on, to be opened as the system's launches are. */
    open(paths: string[]): Promise<void>
    log(message: string, error?: unknown): void
}

/** What the dialog says about these paths, of which `folders` are folders. */
export function dropQuestion(paths: readonly string[], folders: number): DropQuestion {
    const listed = paths.length > MOST_LISTED ? [...paths.slice(0, MOST_LISTED), COPY.dropMore(paths.length - MOST_LISTED)] : paths
    return { message: COPY.dropTitle(paths.length, basename(paths[0]) || paths[0]), detail: COPY.dropDetail(listed, folders) }
}

/** The paths of a drop as the page sent them, or null for something that is not one. */
export function droppedPaths(sent: unknown): string[] | null {
    if (!Array.isArray(sent) || sent.length === 0 || sent.length > MOST_DROPPED) return null
    if (!sent.every((path): path is string => typeof path === 'string' && path !== '')) return null
    return [...new Set(sent)]
}

async function countFolders(paths: readonly string[]): Promise<number> {
    let folders = 0
    for (const path of paths) if ((await stat(path).catch(() => null))?.isDirectory()) folders++
    return folders
}

export async function takeDrop(sent: unknown, parts: DropParts): Promise<void> {
    const paths = droppedPaths(sent)
    if (paths === null) return parts.log('A drop that is not one was refused.')
    if (!(await parts.ask(dropQuestion(paths, await countFolders(paths))))) return
    await parts.open(paths)
}
