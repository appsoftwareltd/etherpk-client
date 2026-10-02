/**
 * Replacing a file's whole contents through a web file handle, by whichever means the browser has.
 *
 * `createWritable()` is the File System API's way, in Chromium, Firefox and Safari from 26. Safari
 * before 26 lacks it, and so does every browser on iOS 18 or older, since they all run WebKit.
 * There the only way to write a file is a sync access handle in a dedicated worker
 * (sync-handle-write-worker.ts), which reaches the file by its path from the Origin Private File
 * System root. That covers every file such a browser can write: it has no folder picker, so its
 * only graph files are the [[Demo Graph]]'s, in OPFS (ADR 0069).
 */

import type { SyncHandleWriteRequest, SyncHandleWriteResponse } from './sync-handle-write-worker'
import { writeWithOneRetry } from './write-retry'

export type FileContents = string | Uint8Array<ArrayBuffer>

/** Writes `bytes` over the OPFS file at `path` from the worker. */
export type WorkerFileWriter = (path: string[], bytes: Uint8Array<ArrayBuffer>) => Promise<void>

/** Injected by tests; the browser's own by default. */
export interface FileWriteDeps {
    opfsRoot?: () => Promise<FileSystemDirectoryHandle>
    writeInWorker?: WorkerFileWriter
}

/**
 * The worker writer: one worker, started on the first write and kept for the rest, each write
 * settled by the reply carrying its id. A worker that dies fails every write waiting on it, and
 * the next write starts a fresh one.
 */
export function createSyncHandleWriter(createWorker: () => Worker): WorkerFileWriter {
    let worker: Worker | undefined
    let nextId = 0
    const waiting = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()

    function start(): Worker {
        const started = createWorker()
        started.addEventListener('message', (event: MessageEvent<SyncHandleWriteResponse>) => {
            const pending = waiting.get(event.data.id)
            if (!pending) return
            waiting.delete(event.data.id)
            if (event.data.type === 'ok') pending.resolve()
            // Rebuilt as a DOMException of the same name, so the save notice can tell a full disk
            // from a locked file (save-error-copy.ts) just as it can for createWritable.
            else pending.reject(new DOMException(event.data.message, event.data.name))
        })
        started.addEventListener('error', (event) => {
            const error = new Error(event.message || 'The file writer stopped unexpectedly.')
            for (const { reject } of waiting.values()) reject(error)
            waiting.clear()
            started.terminate()
            if (worker === started) worker = undefined
        })
        return started
    }

    return (path, bytes) => {
        const target = (worker ??= start())
        const id = nextId++
        return new Promise<void>((resolve, reject) => {
            waiting.set(id, { resolve, reject })
            target.postMessage({ id, path, bytes } satisfies SyncHandleWriteRequest, [bytes.buffer])
        })
    }
}

const writeInSyncHandleWorker = createSyncHandleWriter(
    () => new Worker(new URL('./sync-handle-write-worker.ts', import.meta.url), { type: 'module' }),
)

/** Replace the file's contents with `contents`; text is written as UTF-8. */
export async function writeFileContents(
    fileHandle: FileSystemFileHandle,
    contents: FileContents,
    deps: FileWriteDeps = {},
): Promise<void> {
    if (typeof (fileHandle as Partial<FileSystemFileHandle>).createWritable === 'function') {
        // close() renames the swap file over the target; on Windows another process's read handle
        // on the target refuses that, so the whole write is tried once more (write-retry.ts).
        await writeWithOneRetry(async () => {
            const writable = await fileHandle.createWritable()
            await writable.write(contents)
            await writable.close()
        })
        return
    }

    const root = await (deps.opfsRoot ?? (() => navigator.storage.getDirectory()))()
    const path = await root.resolve(fileHandle)
    if (!path) throw new Error('This browser cannot write files outside its own private storage.')
    // A fresh array either way: the bytes are transferred to the worker, which empties the buffer
    // they came from, and the adapter hands the caller's own array back as what was written.
    const bytes = typeof contents === 'string' ? new TextEncoder().encode(contents) : contents.slice()
    await (deps.writeInWorker ?? writeInSyncHandleWorker)(path, bytes)
}
