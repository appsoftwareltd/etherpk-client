/**
 * What happens when a person chooses a folder on the Graphs page (ADR 0194): the folder is looked
 * at before anything is written, and the answer is a graph to open, a Plain Folder to open, a
 * refusal, or a question for the person.
 *
 * Until now any chosen folder became a Folder graph at once, with four directories and two files
 * written into it. This module is the step in front of that. It writes nothing itself; the page
 * acts on what it returns.
 */
import { findFolderOwner, type FolderOwner, type KnownFolder, openAsFolderGraphRefusal } from '../storage/synced/mirror-takeover'

import { type FolderVerdict, classifyFolder, probeFolder } from './classify-folder'
import type { FolderTreeAdapter } from './folder-tree-adapter'
import type { PlainFolderRecord, PlainFolderRegistry } from './plain-folder-registry'

/** The slice of a directory handle this needs: its name, and how it stands to another folder. */
export interface ChosenHandle {
    readonly name: string
    isSameEntry(other: never): Promise<boolean>
    /** The path from this folder down to `possibleDescendant`, or null when it is not inside. */
    resolve(possibleDescendant: never): Promise<string[] | null>
}

export type ChosenFolder =
    /** This device already has the folder as a Plain Folder: open that. */
    | { kind: 'plain-folder'; folder: PlainFolderRecord }
    /** Open it as a Folder graph: it is one, or this device already has it as one. */
    | { kind: 'folder-graph' }
    | { kind: 'refused'; message: string }
    | { kind: 'ask'; verdict: Extract<FolderVerdict, { kind: 'ask' }> }

export interface ExamineDeps<Handle extends ChosenHandle> {
    /** This device's Plain Folders. */
    plainFolders: () => Promise<PlainFolderRecord[]>
    /** This device's graph folders and Local Mirrors (`readKnownGraphFolders`). */
    knownFolders: () => Promise<KnownFolder[]>
    /** The read half of a tree adapter over the handle. */
    treeOf: (handle: Handle) => Pick<FolderTreeAdapter, 'list' | 'read'>
}

/** Why a folder that belongs to something else here cannot be opened, in words for the person. */
export function refusalFor(folder: string, reason: 'mirror' | 'inside-graph', owner: FolderOwner): string {
    if (reason === 'mirror') return openAsFolderGraphRefusal(folder, owner)
    return `“${folder}” is inside the folder of the graph “${owner.name}”, so opening it by itself would change that graph's files behind its back. Open “${owner.name}” instead.`
}

/** Look at a chosen folder and say what to do with it. Nothing is written. */
export async function examineChosenFolder<Handle extends ChosenHandle>(handle: Handle, deps: ExamineDeps<Handle>): Promise<ChosenFolder> {
    for (const folder of await deps.plainFolders()) {
        const held = folder.handle as Partial<ChosenHandle> | null
        try {
            if (typeof held?.isSameEntry === 'function' && (await held.isSameEntry(handle as never))) return { kind: 'plain-folder', folder }
        } catch {
            // A handle that cannot be compared is not this folder.
        }
    }
    const owner = await findFolderOwner(handle, await deps.knownFolders())
    const verdict = classifyFolder(await probeFolder(deps.treeOf(handle)), owner)
    if (verdict.kind === 'refuse') return { kind: 'refused', message: refusalFor(handle.name, verdict.reason, verdict.owner) }
    if (verdict.kind === 'ask') return { kind: 'ask', verdict }
    return { kind: 'folder-graph' }
}

/** Add a chosen folder to this device's Plain Folders. Its name is the folder's own. */
export async function registerPlainFolder(handle: ChosenHandle, registry: PlainFolderRegistry, newId: () => string, now: () => number): Promise<PlainFolderRecord> {
    return registry.add({ id: newId(), name: handle.name, createdAt: now(), handle })
}
