/**
 * A folder an installed app's shell gave the Client, shaped like the directory handle a browser
 * gives, so that the records that keep a folder and the checks that compare two need one shape.
 *
 * It holds no path. The shell's id is all there is, and only the shell knows what it leads to. It has
 * no `queryPermission`, which the permission checks read as a folder that needs no asking: the shell
 * keeps the permission the person gave when they chose it. It has none of the methods that read or
 * write either. What reads a folder takes an adapter, and folder-access.ts chooses which.
 */
import type { FolderInfo } from '@appsoftwareltd/etherpk-native-bridge'

import { nativeBridge } from './bridge.js'
import type { NativeFileRef } from './file-ref.js'

export class NativeFolderRef {
    readonly kind = 'directory'
    readonly name: string
    /** The shell's id for the folder. */
    readonly nativeId: string

    constructor(name: string, nativeId: string) {
        this.name = name
        this.nativeId = nativeId
    }

    /** Whether `other` is this same folder on disk. False for a browser's handle. */
    async isSameEntry(other: unknown): Promise<boolean> {
        if (!isNativeFolder(other)) return false
        if (other.nativeId === this.nativeId) return true
        return (await shell().call('folders.relation', { a: this.nativeId, b: other.nativeId })).same
    }

    /** The path from this folder down to `other`, or null when it is not inside. */
    async resolve(other: unknown): Promise<string[] | null> {
        if (!isNativeFolder(other)) return null
        if (other.nativeId === this.nativeId) return []
        return (await shell().call('folders.relation', { a: this.nativeId, b: other.nativeId })).path
    }
}

/** Any folder the Client keeps: a browser's handle, or a shell's folder. */
export type FolderHandle = FileSystemDirectoryHandle | NativeFolderRef
/** Any single file the Client was given. */
export type FileHandle = FileSystemFileHandle | NativeFileRef

export function nativeFolderRef(info: FolderInfo): NativeFolderRef {
    return new NativeFolderRef(info.name.normalize('NFC'), info.id)
}

export function isNativeFolder(handle: unknown): handle is NativeFolderRef {
    return handle instanceof NativeFolderRef
}

/** The shell, for a caller that holds something only a shell gives. */
export function shell() {
    const bridge = nativeBridge()
    // A record a shell made, read where there is none. It reads as a folder that cannot be reached.
    if (!bridge) throw new DOMException('This folder is reached through the EtherPK app.', 'NotFoundError')
    return bridge
}

/** What a record keeps in IndexedDB in place of the folder: its id, and the name to show before the shell is asked. */
export interface StoredNativeFolder {
    nativeFolder: string
    name: string
}

function isStoredNativeFolder(value: unknown): value is StoredNativeFolder {
    if (typeof value !== 'object' || value === null) return false
    const { nativeFolder, name } = value as Partial<StoredNativeFolder>
    return typeof nativeFolder === 'string' && typeof name === 'string'
}

/** What to keep for a folder in IndexedDB. A browser's handle is kept as it is. */
export function toStoredFolder(handle: unknown): unknown {
    return isNativeFolder(handle) ? ({ nativeFolder: handle.nativeId, name: handle.name } satisfies StoredNativeFolder) : handle
}

/**
 * What a kept folder stands for. The shell is not asked whether the folder is still there: a folder
 * that has gone is still its graph's, and opening it is what says so.
 */
export function fromStoredFolder(stored: unknown): unknown {
    return isStoredNativeFolder(stored) ? new NativeFolderRef(stored.name, stored.nativeFolder) : stored
}

/**
 * Whether the shell can still reach the folder. False when it was deleted, moved or renamed, when it
 * is on a drive that is not there, or when the person took the permission back.
 */
export async function nativeFolderIsThere(folder: NativeFolderRef): Promise<boolean> {
    const bridge = nativeBridge()
    return bridge !== null && (await bridge.call('folders.get', { folder: folder.nativeId })) !== null
}

/** Where the folder is, for display and to hand to another program, or null where there is no path to show. */
export async function nativeFolderPath(folder: NativeFolderRef): Promise<string | null> {
    return (await nativeBridge()?.call('folders.get', { folder: folder.nativeId }))?.displayPath ?? null
}

/** Show what is at `path` in the folder in the device's file manager. */
export function showNativeFile(folder: NativeFolderRef, path: string): Promise<void> {
    return shell().call('shell.showInFileManager', { folder: folder.nativeId, path })
}
