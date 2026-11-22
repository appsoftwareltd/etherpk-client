import { describe, expect, it } from 'vitest'

import type { KnownFolder } from '../storage/synced/mirror-takeover'

import { type ChosenHandle, examineChosenFolder, registerPlainFolder } from './choose-folder'
import { createMemoryTreeAdapter } from './memory-tree-adapter'
import { type PlainFolderPort, type PlainFolderRecord, createPlainFolderRegistry } from './plain-folder-registry'

/** A stand-in for a directory handle: a name, the files it holds, and identity by `key`. */
interface Folder extends ChosenHandle {
    key: string
    files: Record<string, string>
}
function folder(name: string, files: Record<string, string> = {}, key = name, inside: string[] = []): Folder {
    return {
        name,
        key,
        files,
        isSameEntry: async (other: Folder) => other.key === key,
        // A handle resolves another when that one is inside it.
        resolve: async (other: Folder) => (inside.includes(other.key) ? [other.name] : null),
    }
}

const deps = (plain: PlainFolderRecord[] = [], known: KnownFolder[] = []) => ({
    plainFolders: async () => plain,
    knownFolders: async () => known,
    treeOf: (handle: Folder) => createMemoryTreeAdapter({ now: () => 1, seed: handle.files }),
})

describe('choosing a folder on the Graphs page', () => {
    it('opens the Plain Folder this device already has there, without asking again', async () => {
        const chosen = folder('garden', { 'README.md': 'x' })
        const record: PlainFolderRecord = { id: 'p1', name: 'garden', createdAt: 1, handle: folder('garden', {}, 'garden') }
        expect(await examineChosenFolder(chosen, deps([record]))).toEqual({ kind: 'plain-folder', folder: record })
    })

    it('opens a Graph Folder as a Folder graph, and asks about anything else', async () => {
        expect(await examineChosenFolder(folder('recipes', { 'etherpk/settings.json': '{}' }), deps())).toEqual({ kind: 'folder-graph' })
        expect(await examineChosenFolder(folder('garden', { 'README.md': 'x' }), deps())).toMatchObject({ kind: 'ask', verdict: { preferred: 'plain' } })
        expect(await examineChosenFolder(folder('seeds'), deps())).toMatchObject({ kind: 'ask', verdict: { empty: true, preferred: 'graph' } })
    })

    it('refuses a folder inside a graph’s own folder, naming the graph', async () => {
        const graphFolder = folder('recipes', {}, 'recipes', ['pages-of-recipes'])
        const chosen = folder('pages', { 'Soup.md': 'x' }, 'pages-of-recipes')
        const known: KnownFolder[] = [{ handle: graphFolder, owner: { kind: 'folder-graph', graphId: 'g1', name: 'recipes' } }]
        const outcome = await examineChosenFolder(chosen, deps([], known))
        expect(outcome.kind).toBe('refused')
        expect(outcome).toMatchObject({ message: expect.stringContaining('inside the folder of the graph “recipes”') })
    })

    it('refuses a Local Mirror’s folder', async () => {
        const mirror = folder('home-notes', { 'pages/Garden.md': 'x' })
        const known: KnownFolder[] = [{ handle: mirror, owner: { kind: 'mirror', graphId: 'g2', name: 'Home notes' } }]
        expect(await examineChosenFolder(folder('home-notes', mirror.files), deps([], known))).toMatchObject({ kind: 'refused', message: expect.stringContaining('mirrored') })
    })

    it('registers a Plain Folder under the folder’s own name', async () => {
        const records = new Map<string, PlainFolderRecord>()
        const port: PlainFolderPort = { getAll: async () => [...records.values()], put: async (r) => void records.set(r.id, r), delete: async (id) => void records.delete(id) }
        const chosen = folder('garden')
        const record = await registerPlainFolder(chosen, createPlainFolderRegistry(port), () => 'new-id', () => 42)
        expect(record).toEqual({ id: 'new-id', name: 'garden', createdAt: 42, handle: chosen })
        expect(await createPlainFolderRegistry(port).list()).toEqual([record])
    })
})
