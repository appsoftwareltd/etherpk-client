/**
 * The [[Plain Folder]]s this device has been given, kept apart from the graph registry (ADR 0194).
 *
 * A Plain Folder is not a graph, so it is not a graph record. Every reader of the graph registry
 * assumes a graph (the Share Target, Quick notes, graph order, the last graph), and a Client from
 * before Plain Folders, still cached in a browser, would open a record it took for a Folder graph
 * and write a graph's layout into the folder. Its own registry means none of them ever sees one.
 *
 * Pure over a storage port, so it is tested in Node with a map behind it. The browser's port is in
 * plain-folder-registry-idb.ts.
 */

/** One Plain Folder on this device. */
export interface PlainFolderRecord {
    id: string
    /** The folder's own name, which is also its name in its address. */
    name: string
    /** When it was added, in epoch milliseconds: the order of the list. */
    createdAt: number
    /** A `FileSystemDirectoryHandle` or an installed app's folder; opaque here, as the graph registry's are. */
    handle: unknown
}

export interface PlainFolderPort {
    getAll(): Promise<PlainFolderRecord[]>
    put(record: PlainFolderRecord): Promise<void>
    delete(id: string): Promise<void>
}

export interface PlainFolderRegistry {
    /** Every Plain Folder, oldest first. */
    list(): Promise<PlainFolderRecord[]>
    get(id: string): Promise<PlainFolderRecord | undefined>
    /** Add a folder. Adding an id that is already there changes nothing and returns the kept record. */
    add(record: PlainFolderRecord): Promise<PlainFolderRecord>
    /** Keep another folder under an id that is already there: the folder was lost and chosen again. */
    replaceFolder(record: PlainFolderRecord): Promise<void>
    /** Forget a folder on this device. Its files are not touched. */
    remove(id: string): Promise<void>
}

export function createPlainFolderRegistry(port: PlainFolderPort): PlainFolderRegistry {
    const list = async () => (await port.getAll()).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    return {
        list,
        async get(id) {
            return (await port.getAll()).find((record) => record.id === id)
        },
        async add(record) {
            const kept = (await port.getAll()).find((existing) => existing.id === record.id)
            if (kept) return kept
            await port.put(record)
            return record
        },
        replaceFolder(record) {
            return port.put(record)
        },
        remove(id) {
            return port.delete(id)
        },
    }
}
