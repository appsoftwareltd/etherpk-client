import 'fake-indexeddb/auto'

import { afterEach, describe, expect, it, vi } from 'vitest'

/** A fresh module, so each test opens its own connection rather than a memoised one. */
async function fresh() {
    vi.resetModules()
    return import('./plain-folder-registry-idb')
}

afterEach(async () => {
    await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase('etherpk-plain-folders')
        request.onsuccess = request.onerror = request.onblocked = () => resolve()
    })
})

describe('the Plain Folder registry in IndexedDB', () => {
    it('keeps folders across a new connection, in a database of its own', async () => {
        const first = (await fresh()).createIdbPlainFolderRegistry()
        await first.add({ id: 'a', name: 'garden', createdAt: 10, handle: { fake: 'a' } })
        await first.add({ id: 'b', name: 'notes', createdAt: 20, handle: { fake: 'b' } })

        const second = (await fresh()).createIdbPlainFolderRegistry()
        expect(await second.list()).toEqual([
            { id: 'a', name: 'garden', createdAt: 10, handle: { fake: 'a' } },
            { id: 'b', name: 'notes', createdAt: 20, handle: { fake: 'b' } },
        ])
        await second.remove('a')
        expect((await (await fresh()).createIdbPlainFolderRegistry().list()).map((folder) => folder.id)).toEqual(['b'])

        // The graph registry's database is never opened, so nothing that reads graphs sees a folder.
        const names = (await indexedDB.databases()).map((database) => database.name)
        expect(names).toContain('etherpk-plain-folders')
        expect(names).not.toContain('etherpk')
    })
})
