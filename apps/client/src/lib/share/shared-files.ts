/**
 * Files on their way into a [[Quick Note]] that no graph holds yet (ADR 0186): what the device's
 * share sheet handed over, between the service worker that received it and the page that shows
 * it, and what a share carries to the workspace when the graph has to be opened to take it.
 *
 * A share reaches the app as a form post, and a page can only be opened with an address, so the
 * service worker keeps the files here under a random id and puts the id on the address. They are
 * kept in IndexedDB as they arrived: nothing is in a graph, nothing is encrypted, and nothing
 * leaves the device. A set is removed when the note it belongs to is added, and any set older
 * than a day is removed the next time one is written, so a share that was abandoned does not
 * stay. Runs in a page and in the service worker.
 */

const DB_NAME = 'etherpk-shared-files'
const STORE = 'shares'
/** How long an abandoned share is kept: long enough to unlock a graph, not long enough to forget about. */
export const SHARED_FILES_MAX_AGE_MS = 24 * 60 * 60 * 1000

interface StoredFile {
    name: string
    type: string
    lastModified: number
    bytes: ArrayBuffer
}

interface StoredShare {
    id: string
    createdAt: number
    files: StoredFile[]
}

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1)
        request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' })
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('Could not open the shared files store'))
    })
}

/** Run `work` in one transaction and resolve with its request's result once the transaction commits. */
async function inStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    const db = await openDb()
    try {
        return await new Promise<T | undefined>((resolve, reject) => {
            const transaction = db.transaction(STORE, mode)
            const request = work(transaction.objectStore(STORE))
            transaction.oncomplete = () => resolve(request ? request.result : undefined)
            transaction.onerror = () => reject(transaction.error ?? new Error('The shared files store refused the change'))
            transaction.onabort = () => reject(transaction.error ?? new Error('The shared files store refused the change'))
        })
    } finally {
        db.close()
    }
}

/**
 * Keep `files` and resolve with the id they are kept under. Sets older than a day go in the same
 * pass. `id` is given by a caller that has already told someone the id (never by a share).
 */
export async function keepSharedFiles(files: readonly File[], options: { id?: string; now?: number } = {}): Promise<string> {
    const now = options.now ?? Date.now()
    const id = options.id ?? crypto.randomUUID()
    const stored: StoredFile[] = []
    for (const file of files) {
        stored.push({ name: file.name, type: file.type, lastModified: file.lastModified, bytes: await file.arrayBuffer() })
    }
    const all = ((await inStore('readonly', (store) => store.getAll())) ?? []) as StoredShare[]
    await inStore('readwrite', (store) => {
        for (const share of all) if (now - share.createdAt > SHARED_FILES_MAX_AGE_MS) store.delete(share.id)
        store.put({ id, createdAt: now, files: stored } satisfies StoredShare)
    })
    return id
}

/** The files kept under `id`, in the order they arrived; none for an id that names nothing. */
export async function readSharedFiles(id: string): Promise<File[]> {
    const share = (await inStore('readonly', (store) => store.get(id))) as StoredShare | undefined
    return (share?.files ?? []).map((file) => new File([file.bytes], file.name, { type: file.type, lastModified: file.lastModified }))
}

export async function forgetSharedFiles(id: string): Promise<void> {
    await inStore('readwrite', (store) => {
        store.delete(id)
    })
}
