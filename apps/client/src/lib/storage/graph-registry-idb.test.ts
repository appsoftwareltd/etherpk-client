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

/**
 * Folder permission, over handles that answer as the File System Access API does. The browser
 * refuses a request made without a user gesture by throwing, not by answering `denied`.
 */
describe('folder permission', () => {
    const noGesture = () =>
        new DOMException("Failed to execute 'requestPermission' on 'FileSystemHandle': User activation is required to request permissions.", 'SecurityError')

    function handle(query: PermissionState, request: () => Promise<PermissionState>) {
        return { queryPermission: vi.fn(async () => query), requestPermission: vi.fn(request) }
    }

    async function permissions() {
        const { ensurePermission, hasPermission, tryEnsurePermission } = await import('./graph-registry-idb')
        return { ensurePermission, hasPermission, tryEnsurePermission }
    }

    describe('ensurePermission', () => {
        it('does not ask when the permission is already held', async () => {
            const { ensurePermission } = await permissions()
            const held = handle('granted', async () => 'denied')
            expect(await ensurePermission(held)).toBe(true)
            expect(held.requestPermission).not.toHaveBeenCalled()
        })

        it('asks otherwise, and answers what the person chose', async () => {
            const { ensurePermission } = await permissions()
            expect(await ensurePermission(handle('prompt', async () => 'granted'))).toBe(true)
            expect(await ensurePermission(handle('prompt', async () => 'denied'))).toBe(false)
        })

        it('treats a handle with no permission model as usable', async () => {
            const { ensurePermission } = await permissions()
            expect(await ensurePermission({})).toBe(true)
        })

        it('lets the browser’s refusal to ask reach its caller, which holds a gesture', async () => {
            const { ensurePermission } = await permissions()
            await expect(ensurePermission(handle('prompt', async () => Promise.reject(noGesture())))).rejects.toThrow(/User activation/)
        })
    })

    describe('hasPermission', () => {
        it('only ever queries', async () => {
            const { hasPermission } = await permissions()
            const unheld = handle('prompt', async () => 'granted')
            expect(await hasPermission(unheld)).toBe(false)
            expect(unheld.requestPermission).not.toHaveBeenCalled()
            expect(await hasPermission(handle('granted', async () => 'denied'))).toBe(true)
        })
    })

    describe('tryEnsurePermission', () => {
        it('answers as ensurePermission does when the browser can ask', async () => {
            const { tryEnsurePermission } = await permissions()
            expect(await tryEnsurePermission(handle('granted', async () => 'denied'))).toBe(true)
            expect(await tryEnsurePermission(handle('prompt', async () => 'granted'))).toBe(true)
            expect(await tryEnsurePermission(handle('prompt', async () => 'denied'))).toBe(false)
        })

        it('answers not granted when there is no gesture for the browser to ask on', async () => {
            const { tryEnsurePermission } = await permissions()
            expect(await tryEnsurePermission(handle('prompt', async () => Promise.reject(noGesture())))).toBe(false)
        })

        it('still throws a fault that is not about the gesture', async () => {
            const { tryEnsurePermission } = await permissions()
            const fault = new DOMException('The folder is gone', 'NotFoundError')
            await expect(tryEnsurePermission(handle('prompt', async () => Promise.reject(fault)))).rejects.toBe(fault)
        })
    })
})
