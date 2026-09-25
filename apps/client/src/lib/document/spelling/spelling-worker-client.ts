/**
 * The main thread's handle on the spelling worker (`spelling-worker.ts`), which holds one Hunspell
 * instance per loaded language. Loading German is around 60 ms and a long compound can take
 * 13 ms to check, so none of it runs on the thread that paints the editor.
 *
 * `SpellChecker` is the interface the spell service depends on; `inProcessChecker` runs the same
 * engine without a worker, which is what the Node tests use.
 */

import type { SpellEngine } from './engine'

export interface SpellChecker {
    load(tag: string, aff: string, dic: string): Promise<void>
    unload(tag: string): void
    setWords(words: readonly string[]): void
    check(words: readonly string[]): Promise<boolean[]>
    suggest(word: string, limit?: number): Promise<string[]>
    dispose(): void
}

/** Messages to the worker. Those with an `id` are answered with the same `id`. */
export type SpellingRequest =
    | { type: 'load'; id: number; tag: string; aff: string; dic: string }
    | { type: 'unload'; tag: string }
    | { type: 'words'; words: string[] }
    | { type: 'check'; id: number; words: string[] }
    | { type: 'suggest'; id: number; word: string; limit: number }

/** A request without its id, one member of the union at a time (a plain `Omit` would merge them). */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never

export type SpellingResponse =
    | { id: number; ok: true; result?: boolean[] | string[] }
    | { id: number; ok: false; error: string }

/** The engine behind the same interface, on this thread. */
export function inProcessChecker(engine: SpellEngine): SpellChecker {
    return {
        load: (tag, aff, dic) => engine.load(tag, aff, dic),
        unload: (tag) => engine.unload(tag),
        setWords: (words) => engine.setWords(words),
        check: async (words) => engine.check(words),
        suggest: async (word, limit) => engine.suggest(word, limit),
        dispose: () => {
            for (const tag of engine.loaded()) engine.unload(tag)
        },
    }
}

/** The engine in a dedicated worker. */
export function workerChecker(): SpellChecker {
    const worker = new Worker(new URL('./spelling-worker.ts', import.meta.url), { type: 'module' })
    let nextId = 1
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()

    worker.onmessage = (event: MessageEvent<SpellingResponse>) => {
        const reply = event.data
        const waiter = pending.get(reply.id)
        if (!waiter) return
        pending.delete(reply.id)
        if (reply.ok) waiter.resolve(reply.result)
        else waiter.reject(new Error(reply.error))
    }
    // A worker that fails to start (a blocked script, an out-of-memory tab) fails every waiter
    // rather than leaving the editor waiting on a check that will never come back.
    worker.onerror = (event) => {
        for (const waiter of pending.values()) waiter.reject(new Error(event.message || 'The spelling worker failed.'))
        pending.clear()
    }

    function request<T>(message: WithoutId<Extract<SpellingRequest, { id: number }>>): Promise<T> {
        const id = nextId++
        return new Promise<T>((resolve, reject) => {
            pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
            worker.postMessage({ ...message, id })
        })
    }

    return {
        load: (tag, aff, dic) => request<void>({ type: 'load', tag, aff, dic }),
        unload: (tag) => worker.postMessage({ type: 'unload', tag } satisfies SpellingRequest),
        setWords: (words) => worker.postMessage({ type: 'words', words: [...words] } satisfies SpellingRequest),
        check: (words) => request<boolean[]>({ type: 'check', words: [...words] }),
        suggest: (word, limit = 5) => request<string[]>({ type: 'suggest', word, limit }),
        dispose: () => worker.terminate(),
    }
}
