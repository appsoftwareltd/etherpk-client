/**
 * Writes an [[Export]]'s scratch file (ADR 0092). A sync access handle is the one way to write an
 * OPFS file that every browser without a save picker offers - Firefox, Safari and Android Chrome
 * included - and it is only usable in a dedicated worker, so this is that worker. One file per
 * worker: open, append each chunk, then close or abort.
 */

import { EXPORT_SCRATCH_DIRECTORY } from './export-scratch'

export type ScratchWorkerRequest =
    | { id: number; type: 'open'; name: string }
    | { id: number; type: 'write'; chunk: Uint8Array }
    | { id: number; type: 'close' }
    | { id: number; type: 'abort' }

export type ScratchWorkerResponse = { id: number; type: 'ok' } | { id: number; type: 'error'; message: string }

let directory: FileSystemDirectoryHandle | undefined
let name = ''
let handle: FileSystemSyncAccessHandle | undefined
let position = 0

function reply(response: ScratchWorkerResponse): void {
    postMessage(response)
}

async function handleRequest(request: ScratchWorkerRequest): Promise<void> {
    switch (request.type) {
        case 'open': {
            directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(EXPORT_SCRATCH_DIRECTORY, { create: true })
            name = request.name
            const file = await directory.getFileHandle(name, { create: true })
            handle = await file.createSyncAccessHandle()
            handle.truncate(0)
            position = 0
            return
        }
        case 'write': {
            if (!handle) throw new Error('no file is open')
            let written = 0
            // A sync handle may write fewer bytes than asked; the rest goes on the next call.
            while (written < request.chunk.length) {
                const n = handle.write(request.chunk.subarray(written), { at: position })
                if (n <= 0) throw new Error('the scratch file would not take more bytes')
                written += n
                position += n
            }
            return
        }
        case 'close': {
            handle?.flush()
            handle?.close()
            handle = undefined
            return
        }
        case 'abort': {
            handle?.close()
            handle = undefined
            await directory?.removeEntry(name).catch(() => {})
            return
        }
    }
}

addEventListener('message', (event: MessageEvent<ScratchWorkerRequest>) => {
    const request = event.data
    void handleRequest(request).then(
        () => reply({ id: request.id, type: 'ok' }),
        (error: unknown) => reply({ id: request.id, type: 'error', message: error instanceof Error ? error.message : String(error) }),
    )
})
