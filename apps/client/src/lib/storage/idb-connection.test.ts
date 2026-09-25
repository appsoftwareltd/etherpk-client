import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createReopenableConnection, isClosedConnectionError } from './idb-connection'

const DB = 'reopen-test'
const STORE = 'rows'

function openRaw(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB, 1)
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE)) {
                request.result.createObjectStore(STORE, { keyPath: 'key' })
            }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

async function put(transaction: IDBTransaction, key: string): Promise<void> {
    transaction.objectStore(STORE).put({ key })
    await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
    })
}

async function count(transaction: IDBTransaction): Promise<number> {
    const request = transaction.objectStore(STORE).count()
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

afterEach(async () => {
    await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(DB)
        request.onsuccess = () => resolve()
        request.onerror = () => resolve()
        request.onblocked = () => resolve()
    })
})

describe('createReopenableConnection', () => {
    it('hands out transactions on the open connection without reopening', async () => {
        const open = vi.fn(openRaw)
        const connection = await createReopenableConnection(open)

        await put(await connection.transaction(STORE, 'readwrite'), 'a')
        expect(await count(await connection.transaction(STORE, 'readonly'))).toBe(1)
        expect(open).toHaveBeenCalledTimes(1)
        connection.dispose()
    })

    // The browser closes a connection underneath a page when it evicts or reclaims storage,
    // when a tab is discarded and restored, or on a version change from another tab. Every
    // later `transaction()` on that handle throws InvalidStateError; before 2026-09-01 nothing
    // reopened it, so a page that stayed open kept failing every save until a reload.
    it('reopens after the connection was closed underneath it and completes the work', async () => {
        const open = vi.fn(openRaw)
        const connection = await createReopenableConnection(open)
        await put(await connection.transaction(STORE, 'readwrite'), 'before')

        const live = await connection.current()
        live.close() // what the browser does; the `close` event is not fired for our own close()
        expect(() => live.transaction(STORE, 'readonly')).toThrow()

        await put(await connection.transaction(STORE, 'readwrite'), 'after')
        expect(await count(await connection.transaction(STORE, 'readonly'))).toBe(2)
        expect(open).toHaveBeenCalledTimes(2)
        connection.dispose()
    })

    it('marks the connection closed when the browser fires the close event, so the next use reopens', async () => {
        const open = vi.fn(openRaw)
        const connection = await createReopenableConnection(open)
        const live = await connection.current()

        live.close()
        // fake-indexeddb does not simulate an abnormal termination, so deliver the event the
        // browser would to the handler the connection installed.
        live.onclose?.call(live, new Event('close'))

        expect(await count(await connection.transaction(STORE, 'readonly'))).toBe(0)
        expect(open).toHaveBeenCalledTimes(2)
        connection.dispose()
    })

    it('never reopens after dispose, and says so', async () => {
        const open = vi.fn(openRaw)
        const connection = await createReopenableConnection(open)
        connection.dispose()

        await expect(connection.transaction(STORE, 'readonly')).rejects.toThrow(/disposed/)
        expect(open).toHaveBeenCalledTimes(1)
    })

    it('reports a failed reopen once, rather than retrying forever', async () => {
        let calls = 0
        const open = vi.fn(async () => {
            calls += 1
            if (calls === 1) return openRaw()
            throw new DOMException('The requested version is less than the existing version.', 'VersionError')
        })
        const connection = await createReopenableConnection(open)
        ;(await connection.current()).close()

        await expect(connection.transaction(STORE, 'readonly')).rejects.toMatchObject({ name: 'VersionError' })
        // A later attempt tries again (the browser may have finished its upgrade), but the
        // failure above did not spin.
        expect(open).toHaveBeenCalledTimes(2)
        connection.dispose()
    })
})

describe('isClosedConnectionError', () => {
    it("recognises Chromium's closing-connection InvalidStateError", () => {
        expect(
            isClosedConnectionError(
                new DOMException(
                    "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
                    'InvalidStateError',
                ),
            ),
        ).toBe(true)
    })

    it('ignores other InvalidStateErrors and other exceptions', () => {
        expect(isClosedConnectionError(new DOMException('A mutation operation was attempted on a database that did not allow mutations.', 'ReadOnlyError'))).toBe(false)
        expect(isClosedConnectionError(new Error('closing'))).toBe(false)
    })
})
