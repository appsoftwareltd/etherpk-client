/**
 * Browser glue for `storage/synced/mirror-takeover.ts`: the folders this device's IndexedDB says
 * belong to something, and a look inside a chosen folder that changes nothing.
 *
 * Browser-only; the decisions themselves are unit-tested in `mirror-takeover.test.ts`, and this
 * file is exercised by the Local Mirror Playwright spec through the OPFS picker stand-in.
 */
import { type FolderHandle, treeAdapterFor } from './folder-access'
import type { Subdir } from './fs/directory-adapter'
import { createIdbGraphStoragePort } from './graph-registry-idb'
import { listMirrorFolders } from './mirror-folder-idb'
import { type FolderReader, type KnownFolder, knownFolders } from './synced/mirror-takeover'

/**
 * Every folder graph's folder and every other graph's mirror on this device. Read from the raw
 * registry records rather than `listGraphs()`, which hides the synced graphs of an account that
 * is not signed in: their mirrors still resume when it is, so their folders are still taken.
 */
export async function readKnownGraphFolders(exceptMirrorOf?: string): Promise<KnownFolder[]> {
    const [graphs, mirrors] = await Promise.all([createIdbGraphStoragePort().getAll(), listMirrorFolders()])
    return knownFolders(graphs, mirrors, exceptMirrorOf)
}

/**
 * Read a folder without creating anything in it. A directory adapter creates each subfolder it is
 * asked about, which is right for a graph's own folder and wrong for one the user may still
 * decline: cancelling the takeover dialog would leave empty journals/ and pages/ folders behind.
 */
export function readOnlyFolder(root: FolderHandle): FolderReader {
    const tree = treeAdapterFor(root)
    return {
        async list(name: Subdir) {
            // Asked before it is listed: a folder that cannot be reached must not read as one with
            // nothing in it, and a listing that fails says the same for both.
            if ((await tree.stat(name))?.kind !== 'directory') return []
            return (await tree.list(name)).filter((entry) => entry.kind === 'file').map((entry) => entry.name)
        },
        async read(name, file) {
            return new TextDecoder().decode((await tree.read(`${name}/${file}`)).bytes)
        },
    }
}
