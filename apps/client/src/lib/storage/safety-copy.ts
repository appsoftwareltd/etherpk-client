/**
 * A second, survivable copy of small device-identity state, kept in `localStorage`.
 *
 * Everything that makes a device *this* device lives in IndexedDB: the graph registry (which
 * synced graphs are set up here), and the passkey wraps for protected documents. A browser can
 * lose an origin's IndexedDB while leaving its `localStorage` untouched, and on a phone it does:
 * Chromium evicts an origin's quota-managed storage (IndexedDB, Cache, OPFS) under disk pressure
 * unless `navigator.storage.persist()` was granted, which on Android it grants only on engagement
 * heuristics; and when the LevelDB behind an origin's IndexedDB is found corrupt at open, which a
 * process kill mid-write can cause, Chromium deletes the whole origin's IndexedDB and starts
 * empty. `localStorage` is neither quota-managed nor stored in that database, so it survives
 * both. That is the split behind "server access is fine, but every graph says *Not on this
 * device* and my passkeys are gone" (2026-09-10): the sync config, account partition and vault
 * key (all `localStorage`) were intact; the registry and wraps (all IndexedDB) were not.
 *
 * So the records that are tiny and identity-bearing get a copy here, and their primary store
 * heals itself from the copy on the next read. Documents are not copied: they are large and
 * rebuildable from the sync server. Folder handles are not copied: a `FileSystemDirectoryHandle`
 * only exists in IndexedDB.
 *
 * The copy is a safety net, never the record. IndexedDB stays primary; the copy is written after
 * every primary write and removed *before* every primary delete, so a forgotten graph cannot be
 * resurrected by a delete that half-failed. A throwing or absent `localStorage` makes the copy
 * inert, never the caller broken.
 */

const PREFIX = 'etherpk:safety-copy:'

export interface SafetyCopy<T> {
    read(id: string): T | null
    /** Every record in this namespace, keyed by id. */
    readAll(): Map<string, T>
    write(id: string, value: T): void
    remove(id: string): void
}

/** The `localStorage` key for one record. Ids are encoded so a separator inside one cannot collide. */
export function safetyCopyKey(namespace: string, id: string): string {
    return `${PREFIX}${namespace}:${encodeURIComponent(id)}`
}

/** The `localStorage` instance, or null when there is none or touching it throws (SSR, a blocked storage). */
function defaultStorage(): Storage | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage
    } catch {
        return null
    }
}

/**
 * A copy of `parse`-shaped records under `namespace`. `parse` validates what comes back out,
 * because `localStorage` is writable by anything on the origin and a stale or hand-edited entry
 * must read as absent rather than as a record.
 */
export function createSafetyCopy<T>(
    namespace: string,
    parse: (value: unknown) => T | null,
    storage: Storage | null | undefined = defaultStorage(),
): SafetyCopy<T> {
    const namespacePrefix = `${PREFIX}${namespace}:`

    const parseEntry = (raw: string | null): T | null => {
        if (!raw) return null
        try {
            return parse(JSON.parse(raw))
        } catch {
            return null
        }
    }

    return {
        read(id) {
            try {
                return parseEntry(storage?.getItem(safetyCopyKey(namespace, id)) ?? null)
            } catch {
                return null
            }
        },
        readAll() {
            const all = new Map<string, T>()
            if (!storage) return all
            try {
                // Collect the keys first: iterating by index while a parse could, in some
                // browsers, evict an entry would skip its neighbour.
                const keys: string[] = []
                for (let index = 0; index < storage.length; index++) {
                    const key = storage.key(index)
                    if (key?.startsWith(namespacePrefix)) keys.push(key)
                }
                for (const key of keys) {
                    const value = parseEntry(storage.getItem(key))
                    if (value !== null) all.set(decodeURIComponent(key.slice(namespacePrefix.length)), value)
                }
            } catch {
                /* a storage that throws mid-scan yields what was read so far */
            }
            return all
        },
        write(id, value) {
            try {
                storage?.setItem(safetyCopyKey(namespace, id), JSON.stringify(value))
            } catch {
                // Quota, or a storage that refuses writes: the primary still holds the record.
            }
        },
        remove(id) {
            try {
                storage?.removeItem(safetyCopyKey(namespace, id))
            } catch {
                /* nothing to remove, or a storage that refuses: either way there is no copy to resurrect from */
            }
        },
    }
}
