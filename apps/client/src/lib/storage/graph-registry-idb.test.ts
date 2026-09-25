import 'fake-indexeddb/auto'
import { openDB } from 'idb'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GraphRecord } from './graph-registry'

/**
 * The IndexedDB port, over `fake-indexeddb`. Only the thing that cannot be reasoned about from
 * the pure registry is pinned here: which database this build is willing to attach to.
 *
 * A browser that has run a LATER client holds a later database version, and IndexedDB refuses an
 * open that asks for an older one. The refusal is silent in the worst way - `/graphs` renders
 * empty and every graph looks deleted - and it is reachable by a rollback, a dev branch, or two
 * builds on one origin. It happened for real on 2026-09-09.
 */
const DB_NAME = 'etherpk'

function graph(id: string): GraphRecord {
    return { id, name: id, backend: 'filesystem', createdAt: 1, handle: null }
}

/** A fresh module instance, so the port's memoised connection does not leak between cases. */
async function port() {
    vi.resetModules()
    const module = await import('./graph-registry-idb')
    return module.createIdbGraphStoragePort()
}

afterEach(async () => {
    await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(DB_NAME)
        request.onsuccess = () => resolve()
        request.onerror = () => resolve()
        request.onblocked = () => resolve()
    })
})

describe('the IndexedDB graph registry port', () => {
    it('creates its store and round-trips a record', async () => {
        const store = await port()
        await store.put(graph('a'))
        expect((await store.getAll()).map((record) => record.id)).toEqual(['a'])
        await store.delete('a')
        expect(await store.getAll()).toEqual([])
    })

    it('reads a database left behind by a later build rather than hiding every graph', async () => {
        // A newer client was here first: a higher version, and a store this build knows nothing
        // about. Its `graphs` rows are still this build's to read.
        const newer = await openDB(DB_NAME, 2, {
            upgrade(database) {
                database.createObjectStore('graphs', { keyPath: 'id' })
                database.createObjectStore('something-later', { keyPath: 'id' })
            },
        })
        await newer.put('graphs', graph('kept'))
        newer.close()

        const store = await port()
        expect((await store.getAll()).map((record) => record.id)).toEqual(['kept'])
        // And it stays writable, so the person is not left with a read-only list either.
        await store.put(graph('added'))
        expect((await store.getAll()).map((record) => record.id).sort()).toEqual(['added', 'kept'])
    })
})

/** A localStorage stand-in for the safety copy; `fake-indexeddb` gives the node runner no Storage. */
function memoryStorage(): Storage {
    const map = new Map<string, string>()
    return {
        get length() {
            return map.size
        },
        clear: () => map.clear(),
        getItem: (key) => map.get(key) ?? null,
        key: (index) => [...map.keys()][index] ?? null,
        removeItem: (key) => void map.delete(key),
        setItem: (key, value) => void map.set(key, String(value)),
    }
}

async function deleteRegistryDatabase(): Promise<void> {
    await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(DB_NAME)
        request.onsuccess = () => resolve()
        request.onerror = () => resolve()
        request.onblocked = () => resolve()
    })
}

describe('the registry when the browser loses its IndexedDB but keeps localStorage', () => {
    const synced: GraphRecord = {
        id: 'synced',
        name: 'Work',
        backend: 'server',
        createdAt: 1,
        handle: { rootDocId: 'root' },
        serverScope: { serverOrigin: 'https://sync.example.com', principalId: 'p1' },
        membershipActive: true,
    }

    afterEach(() => {
        // @ts-expect-error - the node runner has no localStorage; the tests above install one.
        delete globalThis.localStorage
    })

    it('lists a synced graph again after the database is deleted, and re-creates its row', async () => {
        globalThis.localStorage = memoryStorage()
        const before = await port()
        await before.put(synced)
        await before.put(graph('folder'))
        await deleteRegistryDatabase()

        const after = await port()
        const rows = await after.getAll()

        expect(rows.map((record) => record.id)).toEqual(['synced'])
        expect(rows[0]).toEqual(synced)
        // The row is back in IndexedDB, not only in the answer: a port opened later sees it too.
        expect((await (await port()).getAll()).map((record) => record.id)).toEqual(['synced'])
    })

    it('does not bring back a synced graph the person forgot before the loss', async () => {
        globalThis.localStorage = memoryStorage()
        const before = await port()
        await before.put(synced)
        await before.delete(synced.id)
        await deleteRegistryDatabase()

        expect(await (await port()).getAll()).toEqual([])
    })
})
