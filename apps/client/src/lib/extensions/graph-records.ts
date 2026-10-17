/**
 * `context.records` (ADR 0147): what an extension keeps on this device for one graph alone, in
 * IndexedDB. An [[Agent Chat]] keeps the chats there that the person has not deleted, saved or not.
 *
 * One object store holds every extension's records for every graph, each under the key
 * `[graphId, extensionId, key]`, so a graph's records are one key range: removing a graph from the
 * device (`graph-device-memory.ts`) deletes that range, whichever extensions wrote it, and an
 * extension never needs to be running for its records to go with the graph. Nothing here is synced.
 */
import type { ExtensionGraphRecords } from '@appsoftwareltd/etherpk-extension-api'

import { createReopenableConnection, type ReopenableConnection } from '$lib/storage/idb-connection'

const DB_NAME = 'etherpk-extension-records'
const DB_VERSION = 1
const RECORDS = 'records'

/** A record's key, as the API states it. */
const KEY = /^[A-Za-z0-9._:-]{1,200}$/

/** The most one record may hold (the API's 4 MB), so no extension fills the device's storage with one write. */
export const GRAPH_RECORD_LIMIT = 4 * 1024 * 1024

/**
 * About how many bytes a record holds: its text and keys, eight for each other value, and the
 * bytes of every `Blob` and buffer in it, which JSON would count as nothing. Stops counting once
 * it is past the limit, and counts a value met twice once, as the structured clone keeps it.
 */
export function recordSize(value: unknown, seen = new Set<unknown>()): number {
    if (typeof value === 'string') return value.length
    if (value === null || typeof value !== 'object') return 8
    if (seen.has(value)) return 0
    seen.add(value)
    if (value instanceof Blob) return value.size
    if (value instanceof ArrayBuffer) return value.byteLength
    if (ArrayBuffer.isView(value)) return value.byteLength
    let size = 0
    const entries: [unknown, unknown][] = value instanceof Map ? [...value.entries()] : Array.isArray(value) || value instanceof Set ? [...(value as Iterable<unknown>)].map((item) => [null, item]) : Object.entries(value)
    for (const [key, item] of entries) {
        size += (typeof key === 'string' ? key.length : 0) + recordSize(item, seen)
        if (size > GRAPH_RECORD_LIMIT) break
    }
    return size
}

let connection: Promise<ReopenableConnection> | null = null

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION)
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(RECORDS)) request.result.createObjectStore(RECORDS)
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB refused to open the extension records.'))
        request.onblocked = () => reject(new Error('The extension records are held open by another tab of an older version.'))
    })
}

/** The one connection, opened on first use and reopened when the browser closes it. */
function db(): Promise<ReopenableConnection> {
    connection ??= createReopenableConnection(openDb).catch((error: unknown) => {
        // A failed open is not kept, so the next use tries again.
        connection = null
        throw error
    })
    return connection
}

function done<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB refused the request.'))
    })
}

/**
 * Every key of `graphId` (and, given, of `extensionId`) in IndexedDB's order. An array sorts after
 * every string, so `[...prefix, []]` is past every key the prefix starts.
 */
function rangeOf(prefix: string[]): IDBKeyRange {
    return IDBKeyRange.bound(prefix, [...prefix, []])
}

/** One extension's records for one graph. */
export function graphRecords(graphId: string, extensionId: string): ExtensionGraphRecords {
    const at = (key: string) => [graphId, extensionId, key]
    return {
        async get<T>(key: string): Promise<T | undefined> {
            if (!KEY.test(key)) return undefined
            try {
                const transaction = await (await db()).transaction(RECORDS, 'readonly')
                return (await done(transaction.objectStore(RECORDS).get(at(key)))) as T | undefined
            } catch {
                // A refused read answers as if there were nothing, as the API says.
                return undefined
            }
        },
        async set(key, value) {
            if (!KEY.test(key)) throw new Error(`A record's key is letters, digits, ".", "_", ":" and "-", at most 200 of them, not "${key}".`)
            if (recordSize(value) > GRAPH_RECORD_LIMIT) throw new Error(`The record "${key}" holds more than 4 MB, the most one record may hold.`)
            const transaction = await (await db()).transaction(RECORDS, 'readwrite')
            await done(transaction.objectStore(RECORDS).put(value, at(key)))
        },
        async remove(key) {
            if (!KEY.test(key)) return
            const transaction = await (await db()).transaction(RECORDS, 'readwrite')
            await done(transaction.objectStore(RECORDS).delete(at(key)))
        },
        async keys() {
            try {
                const transaction = await (await db()).transaction(RECORDS, 'readonly')
                const keys = await done(transaction.objectStore(RECORDS).getAllKeys(rangeOf([graphId, extensionId])))
                return keys.map((key) => (key as string[])[2]).sort()
            } catch {
                return []
            }
        },
    }
}

/** Delete every extension's records for a graph, as the graph leaves this device. */
export async function deleteGraphRecords(graphId: string): Promise<void> {
    const transaction = await (await db()).transaction(RECORDS, 'readwrite')
    await done(transaction.objectStore(RECORDS).delete(rangeOf([graphId])))
}
