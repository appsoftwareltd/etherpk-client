/**
 * Conversion, off the main thread (ADR 0035 / plan §2). Conversion of a large graph is the
 * longest CPU-bound stretch of an [[Import]]; running it here keeps the [[Activity Toast]]
 * and the rest of the app perfectly responsive rather than merely time-sliced.
 *
 * This is viable because the converters are **pure** over `SourceFile[]` and their whole
 * import graph is DOM-free (`wikilink.ts` has no imports at all). `File`/`Blob` structured-
 * clone by reference, so the source bytes are not copied coming in.
 *
 * There is no abort protocol: cancelling conversion is `worker.terminate()` on the client
 * side. Conversion writes nothing and holds nothing but memory, so killing it outright is
 * both correct and instant - a cooperative checkpoint would only be slower.
 */

import { convertSource } from './convert'
import type { ConvertedGraph, ImportFormat, ImportProgress, SourceFile } from './types'

export interface ConvertWorkerRequest {
    files: SourceFile[]
    format: ImportFormat
}

export type ConvertWorkerResponse =
    | { type: 'progress'; progress: ImportProgress }
    | { type: 'done'; graph: ConvertedGraph }
    | { type: 'error'; message: string }

addEventListener('message', (event: MessageEvent<ConvertWorkerRequest>) => {
    const { files, format } = event.data
    void (async () => {
        try {
            // No `breathe` here: the worker owns its thread, so yielding would only slow it
            // down. Progress messages post freely - the main thread renders them.
            const graph = await convertSource(files, format, {
                onProgress: (progress) => postMessage({ type: 'progress', progress } satisfies ConvertWorkerResponse),
            })
            postMessage({ type: 'done', graph } satisfies ConvertWorkerResponse)
        } catch (err) {
            postMessage({
                type: 'error',
                message: err instanceof Error ? err.message : String(err),
            } satisfies ConvertWorkerResponse)
        }
    })()
})
