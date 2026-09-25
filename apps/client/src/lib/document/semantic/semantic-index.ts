/**
 * [[Semantic Search]] over one graph: a `RemoteGraphIndex` (which holds the vectors and runs
 * the scan) plus an `EmbeddingModel` (which makes them), and the two things that join them -
 * the **build loop** and the **query** ([[2026-09-16 Semantic Search]] → The build is a
 * background job; ADR 0076).
 *
 * The build is resumable by construction: its queue is "live passages with no vector under
 * this model", asked of the index afresh each turn, so a killed process, a swapped model or a
 * closed tab loses the batch in flight and nothing else. It runs wherever the caller runs -
 * the [[Headless Client]]'s process today, a worker of the browser's own later - and never in
 * the index worker's serial lane: the index only ever stores what it is handed.
 *
 * A query embeds the text once (one model call) and asks the index for the nearest passages;
 * the answer carries the store's status so a surface can say "partial" honestly while the
 * build is still running.
 */

import type { RemoteGraphIndex, SemanticSearchResult } from '../index-worker/client'
import type { EmbeddingRow, SemanticStatus } from './embedding-db'
import { type EmbeddingModel, quantise } from './embedding-model'

/**
 * Cosine similarity below which a passage is not a result at all. A scan always has a nearest
 * passage - "asdf" is closest to something - so unlike FTS there is no natural "no match" and
 * one has to be declared. Tuned against the evaluation set (apps/mcp/src/semantic-eval.test.ts);
 * MiniLM-class models place unrelated text near 0 and paraphrases above 0.5.
 */
export const SEMANTIC_FLOOR = 0.25

/** Passages fetched from the index per build turn. */
export const BUILD_BATCH = 128
/** Passages per model call: batching amortises per-call overhead; sorting by length limits padding. */
export const EMBED_BATCH = 32
/**
 * Quiet time after each model call. The build is a background job on a machine someone is
 * using: this hands the event loop back to the agent and the relay between calls and keeps the
 * runtime's threads from being the hottest thing on a laptop for the whole first pass. About a
 * tenth of the build's time at the measured call cost.
 */
export const EMBED_PAUSE_MS = 100

export interface SemanticIndexOptions {
    index: RemoteGraphIndex
    model: EmbeddingModel
    floor?: number
    /** After every stored batch, with the store's state. */
    onProgress?: (status: SemanticStatus) => void
    /** A failed build turn; the loop stops and the next `build()` resumes it. */
    onError?: (error: Error) => void
    /** Quiet time after an index change before the build re-runs; edits arrive in bursts. */
    settleMs?: number
    /** Pause after each model call; see {@link EMBED_PAUSE_MS}. Tests pass 0. */
    pauseMs?: number
}

export interface SemanticIndex {
    readonly model: EmbeddingModel
    status(): Promise<SemanticStatus>
    /** Nearest documents to `query`; embeds it first. Answers from whatever is built so far. */
    search(query: string, offset: number, limit: number): Promise<SemanticSearchResult>
    /**
     * Embed every passage that has no vector, then sweep unreferenced vectors. Resolves when
     * the queue is empty. A build already running is joined, not doubled; a change arriving
     * mid-build queues one more pass.
     */
    build(): Promise<void>
    /** Build now and again after every index change, until disposed. */
    follow(): void
    /** Stop following and abandon any build in flight after its current model call. */
    dispose(): void
}

export function createSemanticIndex(options: SemanticIndexOptions): SemanticIndex {
    const { index, model } = options
    const floor = options.floor ?? SEMANTIC_FLOOR
    const settleMs = options.settleMs ?? 1_500
    const pauseMs = options.pauseMs ?? EMBED_PAUSE_MS
    let disposed = false
    let running: Promise<void> | undefined
    let again = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: (() => void) | undefined

    async function runBuild(): Promise<void> {
        for (;;) {
            if (disposed) return
            const pending = await index.semantic.pending(model.id, BUILD_BATCH)
            if (pending.length === 0) break
            // Similar lengths per call: the runtime pads a batch to its longest text.
            const sorted = [...pending].sort((a, b) => a.text.length - b.text.length)
            const rows: EmbeddingRow[] = []
            for (let at = 0; at < sorted.length; at += EMBED_BATCH) {
                const slice = sorted.slice(at, at + EMBED_BATCH)
                const vectors = await model.embed(slice.map((passage) => passage.text))
                if (disposed) return
                slice.forEach((passage, n) => rows.push({ hash: passage.hash, ...quantise(vectors[n]) }))
                if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs))
            }
            await index.semantic.put(model.id, model.dims, rows)
            if (options.onProgress) options.onProgress(await index.semantic.status(model.id))
        }
        await index.semantic.sweep(model.id)
    }

    function build(): Promise<void> {
        if (running) {
            again = true
            return running
        }
        running = runBuild()
            .catch((error: unknown) => options.onError?.(error instanceof Error ? error : new Error(String(error))))
            .finally(() => {
                running = undefined
                if (again && !disposed) {
                    again = false
                    void build()
                }
            })
        return running
    }

    function scheduleBuild(): void {
        if (disposed) return
        clearTimeout(timer)
        timer = setTimeout(() => void build(), settleMs)
    }

    return {
        model,
        status: () => index.semantic.status(model.id),
        async search(query, offset, limit) {
            const [vector] = await model.embed([query])
            return index.semantic.search(model.id, vector, offset, limit, floor)
        },
        build,
        follow() {
            if (unsubscribe || disposed) return
            unsubscribe = index.onUpdated(scheduleBuild)
            void build()
        },
        dispose() {
            disposed = true
            clearTimeout(timer)
            unsubscribe?.()
            unsubscribe = undefined
        },
    }
}
