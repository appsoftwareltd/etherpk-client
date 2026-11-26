/**
 * Giving a folder back to an installed app's shell, so that the app no longer holds permission for a
 * folder the person has forgotten. The folder and its files are not touched.
 *
 * A shell may know one folder by one id however often it is chosen, and one folder can be two things
 * here (a graph's, and the source of an import), so an id any record still holds is kept.
 */
import { nativeBridge } from '../native/bridge'
import { isNativeFolder } from '../native/folder-ref'
import { createIdbPlainFolderRegistry } from '../plain/plain-folder-registry-idb'
import { createIdbGraphStoragePort } from './graph-registry-idb'
import { listMirrorFolders } from './mirror-folder-idb'
import { listPublicationDestinations } from './publication-destination-idb'

async function heldElsewhere(nativeId: string): Promise<boolean> {
    const [graphs, plain, mirrors, publications] = await Promise.all([
        createIdbGraphStoragePort().getAll(),
        createIdbPlainFolderRegistry().list(),
        listMirrorFolders(),
        listPublicationDestinations(),
    ])
    const handles = [...graphs, ...plain, ...mirrors, ...publications].map((record) => ('handle' in record ? record.handle : null))
    return handles.some((handle) => isNativeFolder(handle) && handle.nativeId === nativeId)
}

/** Let go of a folder no record holds any more. Never rejects: what asked for it has been done. */
export async function releaseFolder(handle: unknown): Promise<void> {
    const bridge = nativeBridge()
    if (!bridge || !isNativeFolder(handle)) return
    try {
        if (!(await heldElsewhere(handle.nativeId))) await bridge.call('folders.forget', { folder: handle.nativeId })
    } catch (error) {
        console.warn('[folders] a folder could not be given back to the app’s shell', error)
    }
}
