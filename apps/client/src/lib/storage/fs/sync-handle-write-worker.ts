/**
 * Writes Origin Private File System files for a browser without `createWritable()`: Safari before
 * 26, and so every browser on iOS 18 or older, since they all run WebKit. A sync access handle is
 * the only other way to write an OPFS file, and it exists only in a dedicated worker, so
 * file-write.ts sends each write here.
 *
 * Each request names its file by its path from the OPFS root rather than by a handle, because
 * every Safari that needs this can resolve a handle's path but not all of them can post a handle.
 * Requests run one at a time in the order they arrive: a sync access handle locks its file, so two
 * overlapping writes to one file would refuse each other.
 */

export interface SyncHandleWriteRequest {
    id: number
    /** The file's path from the OPFS root, its own name last; the folders must already exist. */
    path: string[]
    /** The file's whole new contents. */
    bytes: Uint8Array<ArrayBuffer>
}

export type SyncHandleWriteResponse =
    | { id: number; type: 'ok' }
    /** `name` is the DOMException's, which the save notice reads (save-error-copy.ts). */
    | { id: number; type: 'error'; name: string; message: string }

async function writeFile(path: string[], bytes: Uint8Array): Promise<void> {
    const name = path.at(-1)
    if (!name) throw new Error('No file was named to write.')
    let directory = await navigator.storage.getDirectory()
    for (const folder of path.slice(0, -1)) directory = await directory.getDirectoryHandle(folder)
    const handle = await (await directory.getFileHandle(name, { create: true })).createSyncAccessHandle()
    // Safari before 16.4 returned promises from truncate, flush and close, which the spec has since
    // made synchronous. Awaiting each covers both, and costs nothing where they return nothing.
    try {
        let written = 0
        // A sync handle may write fewer bytes than asked; the rest goes on the next call.
        while (written < bytes.length) {
            const count = handle.write(bytes.subarray(written), { at: written })
            if (count <= 0) throw new Error('The file would not take more bytes.')
            written += count
        }
        // Cut whatever a longer previous version leaves past the new end. After the write rather
        // than before, so a reader never finds the file empty.
        await handle.truncate(bytes.length)
        await handle.flush()
    } finally {
        await handle.close()
    }
}

let queue: Promise<void> = Promise.resolve()

addEventListener('message', (event: MessageEvent<SyncHandleWriteRequest>) => {
    const { id, path, bytes } = event.data
    // Both outcomes are handled, so the queue never rejects and one failed write does not stop the next.
    queue = queue
        .then(() => writeFile(path, bytes))
        .then(
            () => postMessage({ id, type: 'ok' } satisfies SyncHandleWriteResponse),
            (error: unknown) =>
                postMessage({
                    id,
                    type: 'error',
                    name: error instanceof Error ? error.name : 'Error',
                    message: error instanceof Error ? error.message : String(error),
                } satisfies SyncHandleWriteResponse),
        )
})
