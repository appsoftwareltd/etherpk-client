/**
 * A [[Publish Folder]] an installed app reaches through its shell, as the publisher writes to one
 * (document/publish/host/site-writer.ts).
 */
import type { NativeBridge } from '@appsoftwareltd/etherpk-native-bridge'

import type { SiteFolder } from '../document/publish/host/site-writer.js'
import { writeWithOneRetry } from '../storage/fs/write-retry.js'
import { type NativeFolderRef, shell } from './folder-ref.js'

/** More files than any site has. A folder with more is not a site's, and half a list would leave strays. */
const FILE_LIMIT = 200_000

export function nativeSiteFolder(root: NativeFolderRef, bridge: () => NativeBridge = shell): SiteFolder {
    const folder = root.nativeId

    async function readBytes(path: string): Promise<Uint8Array | null> {
        // Null for what is not there. A file that could not be read throws, so it is not taken for a
        // seeded file that has never been written.
        return (await bridge().call('fs.readMany', { folder, paths: [path] }))[0]?.bytes ?? null
    }

    return {
        readBytes,
        async readText(path) {
            const bytes = await readBytes(path)
            return bytes === null ? null : new TextDecoder().decode(bytes)
        },
        async writeFile(path, content) {
            const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content)
            await writeWithOneRetry(() => bridge().call('fs.write', { folder, path, bytes, createDirectories: true }))
        },
        remove: (path) => bridge().call('fs.remove', { folder, path }),
        async listFiles() {
            const { files, truncated } = await bridge().call('fs.walk', { folder, path: '', skip: ['.git'], limit: FILE_LIMIT })
            if (truncated) throw new Error(`EtherPK does not publish into a folder that holds more than ${FILE_LIMIT} files. Choose a folder for the site alone.`)
            return files
        },
    }
}
