/**
 * Where an [[Export]]'s bytes go (ADR 0092, decision 4): two sinks behind one interface.
 *
 * On Chromium desktop the save picker names a file and the archive streams into it through a
 * writable whose changes land only on `close()` and are thrown away on `abort()`, which is what
 * lets the archive be finished but not handed over until the report is in. Everywhere else - no
 * picker - the archive is written to a scratch file in the Origin Private File System by a
 * worker holding a sync access handle, and handing over means downloading that file from its
 * object URL, which the browser streams from disk. Nothing in either path holds the archive.
 */

import { downloadBlob } from '$lib/document/publish/host/zip'

import { EXPORT_SCRATCH_DIRECTORY } from './export-scratch'
import type { ScratchWorkerRequest, ScratchWorkerResponse } from './export-scratch-worker'
import type { ExportSink } from './graph-export'

declare global {
    interface Window {
        showSaveFilePicker(options?: {
            suggestedName?: string
            types?: Array<{ description?: string; accept: Record<string, string[]> }>
        }): Promise<FileSystemFileHandle>
    }
}

/** A finished archive's second half: giving it to the person, or not. */
export interface DeliverableSink extends ExportSink {
    /** Hand the finished archive over under `fileName`. The picker's file was named at the pick, so there the name is ignored. */
    handOver(fileName: string): Promise<void>
}

/** `Omit` over a union keeps only the shared keys; this keeps each member's own. */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never

export function saveFilePickerAvailable(): boolean {
    return typeof window !== 'undefined' && 'showSaveFilePicker' in window
}

/** Ask for the file the archive will stream into. Needs a user gesture. */
export async function pickExportFile(suggestedName: string): Promise<FileSystemFileHandle> {
    return window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }],
    })
}

/** The slice of `FileSystemWritableFileStream` a sink uses, so a test can stand one in. */
export interface WritableTarget {
    write(chunk: Uint8Array<ArrayBuffer>): Promise<void>
    close(): Promise<void>
    abort(): Promise<void>
}

/**
 * The save-picker sink. The writable is opened on the first byte, so a pick that never gets that
 * far leaves the file as the picker made it, and `finish` does nothing: the swap file the
 * browser keeps until `close()` IS the not-yet-handed-over archive.
 */
export function createSaveFileSink(open: () => Promise<WritableTarget>): DeliverableSink {
    let writable: Promise<WritableTarget> | undefined
    let settled = false
    return {
        async write(chunk) {
            if (settled) throw new Error('the export file is closed')
            writable ??= open()
            await (await writable).write(chunk)
        },
        async finish() {
            // Complete on the swap file; committed by handOver, dropped by discard.
        },
        async handOver() {
            if (settled) return
            settled = true
            if (writable) await (await writable).close()
        },
        async discard() {
            if (settled) return
            settled = true
            if (writable) await (await writable).abort()
        },
    }
}

export interface ScratchSinkDeps {
    /** The scratch file's name, `<graphId>.zip`. */
    name: string
    createWorker?: () => Worker
    /** How the finished file reaches the person; the object-URL download by default. */
    download?: (file: Blob, fileName: string) => void
    /** The scratch directory, for the download and for a discard the worker cannot do. */
    directory?: () => Promise<FileSystemDirectoryHandle>
}

function defaultWorker(): Worker {
    return new Worker(new URL('./export-scratch-worker.ts', import.meta.url), { type: 'module' })
}

async function defaultDirectory(): Promise<FileSystemDirectoryHandle> {
    return (await navigator.storage.getDirectory()).getDirectoryHandle(EXPORT_SCRATCH_DIRECTORY, { create: true })
}

/**
 * The scratch-file sink. Each chunk is copied and transferred to the worker, which writes it at
 * the file's end and answers, so a slow disk holds the pass back rather than a queue growing in
 * memory. The bytes are copied, not moved, because the pass writes one asset's bytes under every
 * name the documents use for it, and a transferred buffer is empty afterwards.
 */
export function createScratchFileSink(deps: ScratchSinkDeps): DeliverableSink {
    const directory = deps.directory ?? defaultDirectory
    const download = deps.download ?? downloadBlob
    let worker: Worker | undefined
    let nextId = 0
    const waiting = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
    let opened: Promise<void> | undefined
    let closed = false

    function send(request: WithoutId<ScratchWorkerRequest>, transfer: Transferable[] = []): Promise<void> {
        if (!worker) throw new Error('the export worker is gone')
        const id = nextId++
        return new Promise<void>((resolve, reject) => {
            waiting.set(id, { resolve, reject })
            worker!.postMessage({ ...request, id } as ScratchWorkerRequest, transfer)
        })
    }

    function stopWorker(): void {
        worker?.terminate()
        worker = undefined
        for (const { reject } of waiting.values()) reject(new Error('the export worker stopped'))
        waiting.clear()
    }

    function open(): Promise<void> {
        worker = (deps.createWorker ?? defaultWorker)()
        worker.addEventListener('message', (event: MessageEvent<ScratchWorkerResponse>) => {
            const pending = waiting.get(event.data.id)
            if (!pending) return
            waiting.delete(event.data.id)
            if (event.data.type === 'ok') pending.resolve()
            else pending.reject(new Error(event.data.message))
        })
        worker.addEventListener('error', (event) => {
            for (const { reject } of waiting.values()) reject(new Error(event.message || 'the export worker stopped unexpectedly'))
            waiting.clear()
        })
        return send({ type: 'open', name: deps.name })
    }

    return {
        async write(chunk) {
            if (closed) throw new Error('the export file is closed')
            opened ??= open()
            await opened
            const copy = chunk.slice()
            await send({ type: 'write', chunk: copy }, [copy.buffer])
        },
        async finish() {
            if (closed) return
            closed = true
            if (!opened) opened = open()
            await opened
            await send({ type: 'close' })
            stopWorker()
        },
        async handOver(fileName) {
            const file = await (await (await directory()).getFileHandle(deps.name)).getFile()
            download(file, fileName)
        },
        async discard() {
            closed = true
            if (worker) {
                try {
                    if (opened) {
                        await opened
                        await send({ type: 'abort' })
                    }
                } catch {
                    // The worker could not remove it; the directory can.
                }
                stopWorker()
            }
            await (await directory()).removeEntry(deps.name).catch(() => {})
        },
    }
}
