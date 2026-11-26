/**
 * Choosing a folder, and the adapter for the folder chosen: the one place the Client asks whether it
 * is in a browser or in an installed app.
 *
 * A browser gives a directory handle, and the browser's adapters read and write through it. An
 * installed app's shell gives a folder of its own (native/folder-ref.ts), and the native adapters ask
 * the shell. Which adapter is decided by what the folder IS, never by where the page runs: the Demo
 * Graph is in private storage in an installed app too.
 *
 * The shell is asked first. Electron has `showDirectoryPicker`, and a WebView may have one that always
 * cancels, so its presence says nothing in an installed app.
 *
 * Browser only.
 */
import { nativeBridge } from '../native/bridge.js'
import { isNativeFile } from '../native/file-ref.js'
import { type FileHandle, type FolderHandle, isNativeFolder, nativeFolderIsThere, nativeFolderRef } from '../native/folder-ref.js'
import { createNativeDirectoryAdapter } from '../native/native-directory-adapter.js'
import { nativeSingleFile } from '../native/native-file-adapter.js'
import { createNativeTreeAdapter } from '../native/native-tree-adapter.js'
import type { FolderTreeAdapter } from '../plain/folder-tree-adapter.js'
import { browserSingleFile, createSingleFileAdapter } from '../plain/single-file-adapter.js'
import { createWebTreeAdapter } from '../plain/web-tree-adapter.js'
import type { DirectoryAdapter } from './fs/directory-adapter.js'
import { createWebFsDirectoryAdapter, isFsaSupported, isOnDisk, pickGraphDirectory } from './fs/web-fs-adapter.js'

export type { FileHandle, FolderHandle } from '../native/folder-ref.js'

/** Whether this device can open a folder of the person's own. */
export function canPickFolder(): boolean {
    return nativeBridge() !== null || isFsaSupported()
}

/** Ask the person for a folder, to read and write. Rejects with `AbortError` when they cancel. */
export async function pickFolder(): Promise<FolderHandle> {
    const bridge = nativeBridge()
    return bridge ? nativeFolderRef(await bridge.call('folders.pick', {})) : pickGraphDirectory()
}

/** The flat adapter a Folder graph and a Local Mirror use. */
export function directoryAdapterFor(folder: FolderHandle): DirectoryAdapter {
    return isNativeFolder(folder) ? createNativeDirectoryAdapter(folder) : createWebFsDirectoryAdapter(folder)
}

/** The adapter over a folder of any depth, which a Plain Folder uses. */
export function treeAdapterFor(folder: FolderHandle): FolderTreeAdapter {
    return isNativeFolder(folder) ? createNativeTreeAdapter(folder) : createWebTreeAdapter(folder)
}

/** One file opened on its own, as a folder that holds nothing else. */
export function singleFileTreeFor(file: FileHandle): FolderTreeAdapter {
    return createSingleFileAdapter(isNativeFile(file) ? nativeSingleFile(file) : browserSingleFile(file))
}

/** Remove a file or a directory directly inside the folder, with everything in it. */
export async function removeFromFolder(folder: FolderHandle, name: string): Promise<void> {
    if (isNativeFolder(folder)) await treeAdapterFor(folder).remove(name)
    else await folder.removeEntry(name, { recursive: true })
}

/** Whether a folder is one on disk, with a path another program could use, rather than in private storage. */
export async function isFolderOnDisk(folder: FolderHandle): Promise<boolean> {
    return isNativeFolder(folder) || isOnDisk(folder)
}

/**
 * Whether a folder this device keeps can no longer be reached, so that the person has to choose it
 * again. Only an installed app can be sure of that before the folder is used: a browser's handle says
 * it when it is read.
 */
export async function isFolderLost(folder: unknown): Promise<boolean> {
    return isNativeFolder(folder) && !(await nativeFolderIsThere(folder))
}
