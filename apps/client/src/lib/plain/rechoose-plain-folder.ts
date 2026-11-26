/**
 * A [[Plain Folder]] an installed app can no longer reach, and the folder the person chose in its
 * place. It keeps its id, so its Layout and what else this device keeps for it stay with it.
 */
import { type FolderHandle, treeAdapterFor } from '../storage/folder-access'
import { readKnownGraphFolders } from '../storage/folder-ownership'
import { releaseFolder } from '../storage/release-folder'

import { examineChosenFolder } from './choose-folder'
import type { PlainFolderRecord } from './plain-folder-registry'
import { createIdbPlainFolderRegistry } from './plain-folder-registry-idb'

export type RechosenPlainFolder = { kind: 'refused'; message: string } | { kind: 'folder'; folder: PlainFolderRecord }

export async function rechoosePlainFolder(lost: PlainFolderRecord, chosen: FolderHandle): Promise<RechosenPlainFolder> {
    const registry = createIdbPlainFolderRegistry()
    const answer = await examineChosenFolder(chosen, { plainFolders: () => registry.list(), knownFolders: () => readKnownGraphFolders(), treeOf: treeAdapterFor })
    if (answer.kind === 'refused') return answer
    if (answer.kind === 'folder-graph') return { kind: 'refused', message: `“${chosen.name}” is an EtherPK graph. Open it from the Graphs page.` }
    // Already here under another id: that one is opened, and the lost one stays on the list.
    if (answer.kind === 'plain-folder' && answer.folder.id !== lost.id) return { kind: 'folder', folder: answer.folder }
    const folder = { ...lost, name: chosen.name, handle: chosen }
    await registry.replaceFolder(folder)
    await releaseFolder(lost.handle)
    return { kind: 'folder', folder }
}
