/**
 * The main-thread side of worker conversion. Spawns `convert-worker.ts`, forwards its
 * progress, and resolves with the {@link ConvertedGraph}.
 *
 * Cancellation is `terminate()`: conversion is pure and has written nothing, so there is
 * nothing to unwind and no reason to wait for a checkpoint (ADR 0035 §3).
 *
 * **Falls back to converting inline** when `Worker` is unavailable (node/vitest, or a
 * browser that refuses the module worker). The fallback is not a silent downgrade of
 * correctness - it is the same `convertSource` - only of smoothness, so it threads the
 * caller's `breathe` to stay time-sliced.
 */

import { convertSource } from './convert'
import type { ConvertWorkerRequest, ConvertWorkerResponse } from './convert-worker'
import type { ConvertedGraph, ImportControl, ImportFormat, SourceFile } from './types'

/** Injectable for tests; defaults to the real module worker. */
export type WorkerFactory = () => Worker

function defaultWorker(): Worker {
    return new Worker(new URL('./convert-worker.ts', import.meta.url), { type: 'module' })
}

export async function convertInWorker(
    files: SourceFile[],
    format: ImportFormat,
    control?: ImportControl,
    createWorker: WorkerFactory | null = typeof Worker === 'undefined' ? null : defaultWorker,
): Promise<ConvertedGraph> {
    if (!createWorker) return convertSource(files, format, control)

    let worker: Worker
    try {
        worker = createWorker()
    } catch {
        // A bundler or CSP that will not give us a worker is not a reason to fail an import.
        return convertSource(files, format, control)
    }

    const { signal } = control ?? {}
    return new Promise<ConvertedGraph>((resolve, reject) => {
        const stop = () => {
            worker.terminate()
            signal?.removeEventListener('abort', onAbort)
        }
        const onAbort = () => {
            stop()
            reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
        }
        if (signal?.aborted) return onAbort()
        signal?.addEventListener('abort', onAbort, { once: true })

        worker.addEventListener('message', (event: MessageEvent<ConvertWorkerResponse>) => {
            const message = event.data
            if (message.type === 'progress') {
                control?.onProgress?.(message.progress)
                return
            }
            stop()
            if (message.type === 'done') resolve(message.graph)
            else reject(new Error(message.message))
        })
        // A worker that dies (an import it cannot resolve, an OOM) otherwise hangs the
        // Activity forever on a toast that never moves.
        worker.addEventListener('error', (event) => {
            stop()
            reject(new Error(event.message || 'The conversion worker stopped unexpectedly.'))
        })

        worker.postMessage({ files, format } satisfies ConvertWorkerRequest)
    })
}
