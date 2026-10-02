import { describe, expect, it, vi } from 'vitest'

import { createSyncHandleWriter, writeFileContents, type FileWriteDeps } from './file-write'
import type { SyncHandleWriteRequest, SyncHandleWriteResponse } from './sync-handle-write-worker'

/** A file handle from a browser with `createWritable()`, recording what reached it. */
function writableHandle() {
    const written: unknown[] = []
    const calls: string[] = []
    const handle = {
        async createWritable() {
            calls.push('open')
            return {
                async write(data: unknown) {
                    calls.push('write')
                    written.push(data)
                },
                async close() {
                    calls.push('close')
                },
            }
        },
    } as unknown as FileSystemFileHandle
    return { handle, written, calls }
}

/** A file handle from Safari before 26: no `createWritable()`. */
const handleWithoutWritable = () => ({}) as FileSystemFileHandle

/** An OPFS root that places every handle it is asked about at `path`, or outside it when null. */
function opfsRootPlacing(path: string[] | null): () => Promise<FileSystemDirectoryHandle> {
    return async () => ({ resolve: async () => path }) as unknown as FileSystemDirectoryHandle
}

function workerDeps(path: string[] | null) {
    const writeInWorker = vi.fn<NonNullable<FileWriteDeps['writeInWorker']>>(async () => {})
    return { deps: { opfsRoot: opfsRootPlacing(path), writeInWorker }, writeInWorker }
}

describe('writeFileContents', () => {
    it('writes through createWritable when the browser has it, and never starts the worker', async () => {
        const { handle, written, calls } = writableHandle()
        const { deps, writeInWorker } = workerDeps(['pages', 'A.md'])

        await writeFileContents(handle, 'hello', deps)

        expect(calls).toEqual(['open', 'write', 'close'])
        expect(written).toEqual(['hello'])
        expect(writeInWorker).not.toHaveBeenCalled()
    })

    it('without createWritable, hands the worker the file path from the OPFS root and the text as UTF-8', async () => {
        const { deps, writeInWorker } = workerDeps(['graph-demo-graph', 'pages', 'Café.md'])

        await writeFileContents(handleWithoutWritable(), 'café ✓', deps)

        expect(writeInWorker).toHaveBeenCalledTimes(1)
        const [path, bytes] = writeInWorker.mock.calls[0]
        expect(path).toEqual(['graph-demo-graph', 'pages', 'Café.md'])
        expect(new TextDecoder().decode(bytes)).toBe('café ✓')
    })

    it('hands the worker a copy of binary bytes, so the transfer leaves the caller its array', async () => {
        const { deps, writeInWorker } = workerDeps(['graph-demo-graph', 'assets', 'x.bin'])
        const bytes = new Uint8Array([0, 1, 255])

        await writeFileContents(handleWithoutWritable(), bytes, deps)

        const [, sent] = writeInWorker.mock.calls[0]
        expect([...sent]).toEqual([0, 1, 255])
        expect(sent.buffer).not.toBe(bytes.buffer)
    })

    it('without createWritable, refuses a file outside the OPFS root rather than writing somewhere else', async () => {
        const { deps, writeInWorker } = workerDeps(null)

        await expect(writeFileContents(handleWithoutWritable(), 'text', deps)).rejects.toThrow(/cannot write/)
        expect(writeInWorker).not.toHaveBeenCalled()
    })
})

/** Stands in for the dedicated worker: records what it is sent, and answers when told to. */
class FakeWorker extends EventTarget {
    posted: SyncHandleWriteRequest[] = []
    transferred: Transferable[][] = []
    terminated = false

    postMessage(request: SyncHandleWriteRequest, transfer: Transferable[] = []): void {
        this.posted.push(request)
        this.transferred.push(transfer)
    }

    terminate(): void {
        this.terminated = true
    }

    reply(response: SyncHandleWriteResponse): void {
        this.dispatchEvent(new MessageEvent('message', { data: response }))
    }

    crash(message: string): void {
        this.dispatchEvent(Object.assign(new Event('error'), { message }))
    }
}

function writerWithFakeWorkers() {
    const workers: FakeWorker[] = []
    const write = createSyncHandleWriter(() => {
        const worker = new FakeWorker()
        workers.push(worker)
        return worker as unknown as Worker
    })
    return { write, workers }
}

describe('createSyncHandleWriter', () => {
    it('starts one worker on the first write, transfers the bytes, and settles each write by its own reply', async () => {
        const { write, workers } = writerWithFakeWorkers()
        const first = write(['pages', 'A.md'], new Uint8Array([1]))
        const second = write(['pages', 'B.md'], new Uint8Array([2]))

        expect(workers).toHaveLength(1)
        const [worker] = workers
        expect(worker.posted.map((request) => request.path)).toEqual([
            ['pages', 'A.md'],
            ['pages', 'B.md'],
        ])
        expect(worker.transferred[0]).toEqual([worker.posted[0].bytes.buffer])

        let firstSettled = false
        void first.then(() => (firstSettled = true))
        worker.reply({ id: worker.posted[1].id, type: 'ok' })
        await second
        expect(firstSettled).toBe(false)
        worker.reply({ id: worker.posted[0].id, type: 'ok' })
        await first
    })

    it('rejects with a DOMException of the name the browser gave, so the save notice reads it', async () => {
        const { write, workers } = writerWithFakeWorkers()
        const pending = write(['pages', 'A.md'], new Uint8Array([1]))
        const [worker] = workers
        worker.reply({ id: worker.posted[0].id, type: 'error', name: 'QuotaExceededError', message: 'The disk is full.' })

        const error = await pending.catch((caught: unknown) => caught)
        expect(error).toBeInstanceOf(DOMException)
        expect((error as DOMException).name).toBe('QuotaExceededError')
        expect((error as DOMException).message).toBe('The disk is full.')
    })

    it('rejects every pending write when the worker dies, and starts a fresh one for the next write', async () => {
        const { write, workers } = writerWithFakeWorkers()
        const pending = [write(['pages', 'A.md'], new Uint8Array([1])), write(['pages', 'B.md'], new Uint8Array([2]))]
        workers[0].crash('worker script failed')

        for (const failed of pending) await expect(failed).rejects.toThrow(/worker script failed/)
        expect(workers[0].terminated).toBe(true)

        const next = write(['pages', 'C.md'], new Uint8Array([3]))
        expect(workers).toHaveLength(2)
        workers[1].reply({ id: workers[1].posted[0].id, type: 'ok' })
        await next
    })
})
