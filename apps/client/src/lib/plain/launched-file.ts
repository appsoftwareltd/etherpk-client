/**
 * Reading a launch from the device's file manager (the manifest's `file_handlers`): which file it
 * carries, and where that file is inside a folder the person then chooses.
 */

import { isNativeFile, type NativeFileRef } from '../native/file-ref'
import { type FileHandle, type FolderHandle, isNativeFolder, nativeFolderPath, type NativeFolderRef, shell } from '../native/folder-ref'

import { baseName } from './plain-path'

/** What the launch queue carries besides an address: the files, for a launch from a file. */
export interface FileLaunch {
    files?: readonly FileSystemHandle[]
}

/** The first file of a launch, or null for a launch that carries none. */
export function fileOfLaunch(launch: FileLaunch): FileSystemFileHandle | null {
    const file = launch.files?.find((handle) => handle.kind === 'file')
    return (file as FileSystemFileHandle | undefined) ?? null
}

/** Where `file` is inside `folder`, as a path, or null when the folder does not hold it. */
export async function pathInFolder(folder: FolderHandle, file: FileHandle): Promise<string | null> {
    if (isNativeFolder(folder) || isNativeFile(file)) return isNativeFolder(folder) && isNativeFile(file) ? findInFolder(folder, file) : null
    const segments = await folder.resolve(file)
    return segments === null || segments.length === 0 ? null : segments.map((segment) => segment.normalize('NFC')).join('/')
}

/** How far a folder is searched for a file of one name. */
const SEARCH_LIMIT = 20_000
/** How many files of that name are read in one call, so a folder of many copies is not read in one. */
const READ_AT_ONCE = 50

/** The folder has more files than are searched, so the file may be in it and was not found. */
export class FolderTooLargeToSearch extends Error {
    constructor(readonly limit: number) {
        super(`The folder has more than ${limit} files.`)
        this.name = 'FolderTooLargeToSearch'
    }
}

/**
 * Where an installed app's file is in a folder. The shell gave an id for each and neither says where
 * it is, so the file is the one of its name that holds its bytes. A folder that holds two such files
 * cannot say which was opened, and the paths shown to the person decide where the platform has them.
 */
async function findInFolder(folder: NativeFolderRef, file: NativeFileRef): Promise<string | null> {
    const bridge = shell()
    const { files, truncated } = await bridge.call('fs.walk', { folder: folder.nativeId, path: '', skip: ['.git', 'node_modules'], limit: SEARCH_LIMIT })
    const named = files.filter((path) => baseName(path) === file.name)
    // Not found in part of a folder is not "not in this folder".
    if (named.length === 0 && truncated) throw new FolderTooLargeToSearch(SEARCH_LIMIT)
    if (named.length === 0) return null
    const opened = await bridge.call('files.read', { file: file.nativeId })
    const same: string[] = []
    for (let at = 0; at < named.length; at += READ_AT_ONCE) {
        const run = named.slice(at, at + READ_AT_ONCE)
        const found = await bridge.call('fs.readMany', { folder: folder.nativeId, paths: run })
        run.forEach((path, index) => {
            const read = found[index]
            if (read !== null && sameBytes(read.bytes, opened.bytes)) same.push(path)
        })
    }
    if (same.length === 1) return same[0]
    if (same.length === 0 && truncated) throw new FolderTooLargeToSearch(SEARCH_LIMIT)
    const shown = await nativeFolderPath(folder)
    return same.find((path) => shown !== null && file.displayPath === shownPath(shown, path)) ?? null
}

/** The path shown for what is at `path` in the folder shown as `folder`, with the folder's own separator. */
function shownPath(folder: string, path: string): string {
    const separator = folder.includes('\\') ? '\\' : '/'
    return [folder.replace(/[\\/]+$/, ''), ...path.split('/')].join(separator)
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((byte, index) => byte === b[index])
}
