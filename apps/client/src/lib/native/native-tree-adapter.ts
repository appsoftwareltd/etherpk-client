/**
 * The {@link FolderTreeAdapter} of an installed app: a [[Plain Folder]] reached through the shell.
 *
 * The shell answers each of these in one call: what is at a path, the folder's own spelling of one,
 * a move of a whole directory, a change of case alone. The browser's adapter (web-tree-adapter.ts)
 * has to work all of them out from handles.
 */
import type { NativeBridge } from '@appsoftwareltd/etherpk-native-bridge'

import type { FolderTreeAdapter } from '../plain/folder-tree-adapter.js'
import { writeWithOneRetry } from '../storage/fs/write-retry.js'
import { type NativeFolderRef, nativeFolderRef, shell } from './folder-ref.js'

const composed = (path: string) => path.normalize('NFC')

export function createNativeTreeAdapter(root: NativeFolderRef, bridge: () => NativeBridge = shell): FolderTreeAdapter {
    const folder = root.nativeId
    return {
        async list(dir) {
            const entries = await bridge().call('fs.list', { folder, path: composed(dir), stamps: false })
            return entries.map(({ name, kind }) => ({ name, kind }))
        },
        stat: (path) => bridge().call('fs.stat', { folder, path: composed(path) }),
        canonicalPath: (path) => bridge().call('fs.canonicalPath', { folder, path: composed(path) }),
        read: (path) => bridge().call('fs.read', { folder, path: composed(path) }),
        write: (path, bytes, ifStamp) =>
            writeWithOneRetry(() => bridge().call('fs.write', { folder, path: composed(path), bytes, ...(ifStamp ? { ifStamp } : {}) })),
        async createDirectory(path) {
            if (path !== '') await bridge().call('fs.createDirectory', { folder, path: composed(path) })
        },
        remove: (path) => bridge().call('fs.remove', { folder, path: composed(path) }),
        move: (from, to) => bridge().call('fs.move', { folder, from: composed(from), to: composed(to) }),
        async directoryHandle(path) {
            return path === '' ? root : nativeFolderRef(await bridge().call('folders.child', { folder, path: composed(path) }))
        },
    }
}
