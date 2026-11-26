/**
 * Reading and writing the one file an installed app was given, as the single-file adapter needs it
 * (plain/single-file-adapter.ts).
 */
import type { NativeBridge } from '@appsoftwareltd/etherpk-native-bridge'

import type { SingleFile } from '../plain/single-file-adapter.js'
import { writeWithOneRetry } from '../storage/fs/write-retry.js'
import type { NativeFileRef } from './file-ref.js'
import { shell } from './folder-ref.js'

export function nativeSingleFile(file: NativeFileRef, bridge: () => NativeBridge = shell): SingleFile {
    const read = () => bridge().call('files.read', { file: file.nativeId })
    return {
        name: file.name,
        // The shell has no call for a file's stamps alone, and a file opened on its own is small.
        async stat() {
            const { lastModified, size } = await read()
            return { lastModified, size }
        },
        async read() {
            const { bytes, lastModified, size } = await read()
            return { bytes, lastModified, size }
        },
        write: (bytes, ifStamp) => writeWithOneRetry(() => bridge().call('files.write', { file: file.nativeId, bytes, ...(ifStamp ? { ifStamp } : {}) })),
    }
}
