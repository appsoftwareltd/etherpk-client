/**
 * Browser glue for `storage/server/mirror-takeover.ts`: the folders this device's IndexedDB says
 * belong to something, and a look inside a chosen folder that changes nothing.
 *
 * Browser-only; the decisions themselves are unit-tested in `mirror-takeover.test.ts`, and this
 * file is exercised by the Local Mirror Playwright spec through the OPFS picker stand-in.
 */
import type { Subdir } from './fs/directory-adapter'
import { createIdbGraphStoragePort } from './graph-registry-idb'
import { listMirrorFolders } from './mirror-folder-idb'
import { type FolderReader, type KnownFolder, knownFolders } from './server/mirror-takeover'

/**
 * Every local graph's folder and every other graph's mirror on this device. Read from the raw
 * registry records rather than `listGraphs()`, which hides the synced graphs of an account that
 * is not signed in: their mirrors still resume when it is, so their folders are still taken.
 */
export async function readKnownGraphFolders(exceptMirrorOf?: string): Promise<KnownFolder[]> {
    const [graphs, mirrors] = await Promise.all([createIdbGraphStoragePort().getAll(), listMirrorFolders()])
    return knownFolders(graphs, mirrors, exceptMirrorOf)
}

/**
 * Read a folder without creating anything in it. The web-fs adapter creates each subfolder it is
 * asked about, which is right for a graph's own folder and wrong for one the user may still
 * decline: cancelling the takeover dialog would leave empty journals/ and pages/ folders behind.
 */
export function readOnlyFolder(root: FileSystemDirectoryHandle): FolderReader {
    async function subdir(name: Subdir): Promise<FileSystemDirectoryHandle | null> {
        try {
            return await root.getDirectoryHandle(name)
        } catch (error) {
            if ((error as DOMException)?.name === 'NotFoundError' || (error as DOMException)?.name === 'TypeMismatchError') {
                return null
            }
            throw error
        }
    }
    return {
        async list(name) {
            const dir = await subdir(name)
            if (!dir) return []
            const names: string[] = []
            for await (const entry of dir.values()) if (entry.kind === 'file') names.push(entry.name)
            return names
        },
        async read(name, file) {
            const dir = await subdir(name)
            if (!dir) throw new DOMException(`${name}/${file} is not there`, 'NotFoundError')
            return (await (await dir.getFileHandle(file)).getFile()).text()
        },
    }
}
