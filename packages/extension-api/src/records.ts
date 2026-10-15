/**
 * Records an extension keeps on this device for the open graph alone (ADR 0147): never synced,
 * never seen by another device or another member, and deleted when the graph's data is removed
 * from the device. For what is the person's work on this device, such as a chat they have not
 * saved, rather than a preference that should follow them (`personStorage`).
 */

/**
 * The extension's records for the open graph on this device.
 *
 * Each record is stored as the browser's structured clone of the value, so it may hold a `Blob`,
 * an `ArrayBuffer`, a `Date` or plain data, but no function. Records live in the browser's
 * IndexedDB, which a private window or a full disk may refuse: a refused write rejects, and a
 * refused read answers as if there were nothing.
 *
 * @beta
 */
export interface ExtensionGraphRecords {
    /** The record under `key`, or undefined when there is none. */
    get<T>(key: string): Promise<T | undefined>
    /**
     * Keep a record under `key`: letters, digits, `.`, `_`, `:` and `-`, at most 200 of them.
     * Rejects when the key is not one of those or the browser refuses the write.
     */
    set(key: string, value: unknown): Promise<void>
    /** Remove the record under `key`. */
    remove(key: string): Promise<void>
    /** The keys of every record the extension keeps for the open graph, sorted. */
    keys(): Promise<string[]>
}
