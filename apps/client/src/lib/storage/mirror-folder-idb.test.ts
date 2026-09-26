import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The remembered mirror folder, over `fake-indexeddb`. What is pinned is that it lives in its own
 * database: a second store in `etherpk` would have meant a version bump, which is how every graph
 * on this machine vanished from `/graphs` for a while on 2026-09-09.
 */
async function api() {
    vi.resetModules()
    return import('./mirror-folder-idb')
}

afterEach(async () => {
    for (const name of ['etherpk-mirrors', 'etherpk']) {
        await new Promise<void>((resolve) => {
            const request = indexedDB.deleteDatabase(name)
            request.onsuccess = () => resolve()
            request.onerror = () => resolve()
            request.onblocked = () => resolve()
        })
    }
})

describe('the mirror folder store', () => {
    it('remembers a folder per graph, and forgets it on request', async () => {
        const { readMirrorFolder, writeMirrorFolder, forgetMirrorFolder } = await api()
        expect(await readMirrorFolder('g1')).toBeUndefined()
        await writeMirrorFolder({ graphId: 'g1', handle: { name: 'notes' }, folder: 'notes' })
        expect(await readMirrorFolder('g1')).toEqual({ graphId: 'g1', handle: { name: 'notes' }, folder: 'notes' })
        expect(await readMirrorFolder('g2')).toBeUndefined()
        await forgetMirrorFolder('g1')
        expect(await readMirrorFolder('g1')).toBeUndefined()
    })

    it('lists every graph’s folder, so a folder already in use can be recognised', async () => {
        const { listMirrorFolders, writeMirrorFolder } = await api()
        expect(await listMirrorFolders()).toEqual([])
        await writeMirrorFolder({ graphId: 'g1', handle: { name: 'a' }, folder: 'a' })
        await writeMirrorFolder({ graphId: 'g2', handle: { name: 'b' }, folder: 'b' })
        expect((await listMirrorFolders()).map((record) => record.graphId).sort()).toEqual(['g1', 'g2'])
    })

    it('never touches the graph registry database', async () => {
        const { writeMirrorFolder } = await api()
        await writeMirrorFolder({ graphId: 'g1', handle: null, folder: 'notes' })
        const databases = await indexedDB.databases()
        expect(databases.map((database) => database.name)).toContain('etherpk-mirrors')
        expect(databases.map((database) => database.name)).not.toContain('etherpk')
    })
})
