/**
 * One file an installed app's shell gave the Client: opened from the file manager, or shared. Shaped
 * like the file handle a browser gives, as folder-ref.ts is for a folder, and reached through the
 * shell's `files` calls (native-file-adapter.ts).
 */
import type { FileInfo } from '@appsoftwareltd/etherpk-native-bridge'

import { nativeBridge } from './bridge.js'

export class NativeFileRef {
    readonly kind = 'file'
    readonly name: string
    /** The shell's id for the file. */
    readonly nativeId: string
    /** Where the file is, or null where the platform has no path to show. */
    readonly displayPath: string | null

    constructor(name: string, nativeId: string, displayPath: string | null) {
        this.name = name
        this.nativeId = nativeId
        this.displayPath = displayPath
    }
}

export function nativeFileRef(info: FileInfo): NativeFileRef {
    return new NativeFileRef(info.name.normalize('NFC'), info.id, info.displayPath)
}

export function isNativeFile(handle: unknown): handle is NativeFileRef {
    return handle instanceof NativeFileRef
}

/**
 * Give a file back to the shell, which may have kept permission for it since it was opened. Does
 * nothing for a browser's handle. Never rejects: the file is no longer needed either way.
 */
export function releaseFile(handle: unknown): void {
    const bridge = nativeBridge()
    if (!bridge || !isNativeFile(handle)) return
    bridge.call('files.release', { file: handle.nativeId }).catch((error: unknown) => console.warn('[native] an opened file was not released', error))
}
