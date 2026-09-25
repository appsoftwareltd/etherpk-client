/**
 * The worker wrapper. The converters themselves are pure and tested directly; what needs
 * pinning here is the message protocol, the terminate-on-cancel path, and the inline
 * fallback - a bundler or CSP that refuses a worker must degrade, not fail an import.
 */
import { describe, expect, it, vi } from 'vitest'

import { convertInWorker } from './convert-client'
import type { ConvertWorkerResponse } from './convert-worker'
import type { SourceFile } from './types'

function src(path: string, content: string): SourceFile {
    return { path, data: new Blob([content]) }
}

/** A stand-in Worker whose script is supplied by the test. */
function stubWorker(script: (post: (m: ConvertWorkerResponse) => void) => void) {
    const listeners = new Map<string, ((e: unknown) => void)[]>()
    const terminate = vi.fn()
    const worker = {
        terminate,
        addEventListener: (type: string, cb: (e: unknown) => void) => {
            listeners.set(type, [...(listeners.get(type) ?? []), cb])
        },
        postMessage: () => {
            script((message) => {
                for (const cb of listeners.get('message') ?? []) cb({ data: message })
            })
        },
    } as unknown as Worker
    return { worker, terminate, fire: (type: string, event: unknown) => {
        for (const cb of listeners.get(type) ?? []) cb(event)
    } }
}

describe('convertInWorker', () => {
    it('forwards progress and resolves with the graph', async () => {
        const progress: string[] = []
        const { worker, terminate } = stubWorker((post) => {
            post({ type: 'progress', progress: { label: 'Converting documents', done: 1, total: 2 } })
            post({ type: 'done', graph: { documents: [], assets: [], report: [] } })
        })

        const graph = await convertInWorker(
            [src('pages/a.md', 'hi')],
            'etherpk',
            { onProgress: (p) => progress.push(p.label) },
            () => worker,
        )

        expect(graph.documents).toEqual([])
        expect(progress).toEqual(['Converting documents'])
        expect(terminate).toHaveBeenCalledOnce() // never leak the worker
    })

    it('rejects with the worker\'s message on a conversion error', async () => {
        const { worker } = stubWorker((post) => post({ type: 'error', message: 'bad frontmatter' }))
        await expect(convertInWorker([src('pages/a.md', 'hi')], 'etherpk', undefined, () => worker)).rejects.toThrow(
            'bad frontmatter',
        )
    })

    it('rejects rather than hanging when the worker dies', async () => {
        // A worker that OOMs or fails to resolve an import would otherwise leave the
        // Activity stuck forever on a toast that never moves.
        const { worker, fire } = stubWorker(() => {})
        const pending = convertInWorker([src('pages/a.md', 'hi')], 'etherpk', undefined, () => worker)
        fire('error', { message: 'out of memory' })
        await expect(pending).rejects.toThrow('out of memory')
    })

    it('terminates the worker when the Activity is cancelled', async () => {
        // Conversion is pure and has written nothing, so terminate is both correct and
        // instant - a cooperative checkpoint would only be slower (ADR 0035 §3).
        const { worker, terminate } = stubWorker(() => {})
        const controller = new AbortController()
        const pending = convertInWorker([src('pages/a.md', 'hi')], 'etherpk', { signal: controller.signal }, () => worker)
        controller.abort()
        await expect(pending).rejects.toThrow()
        expect(terminate).toHaveBeenCalled()
    })

    it('rejects immediately when the signal is already aborted', async () => {
        const { worker } = stubWorker(() => {})
        const controller = new AbortController()
        controller.abort()
        await expect(
            convertInWorker([src('pages/a.md', 'hi')], 'etherpk', { signal: controller.signal }, () => worker),
        ).rejects.toThrow()
    })

    it('converts inline when no worker is available', async () => {
        // Not a downgrade of correctness - the same convertSource - only of smoothness.
        const graph = await convertInWorker([src('pages/Foo.md', '- body')], 'etherpk', undefined, null)
        expect(graph.documents.map((d) => d.concept)).toEqual(['Foo'])
    })

    it('falls back inline when constructing the worker throws', async () => {
        const graph = await convertInWorker([src('pages/Foo.md', '- body')], 'etherpk', undefined, () => {
            throw new Error('CSP blocked worker-src')
        })
        expect(graph.documents.map((d) => d.concept)).toEqual(['Foo'])
    })
})
