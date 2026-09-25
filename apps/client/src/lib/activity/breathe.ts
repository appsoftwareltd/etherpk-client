/**
 * The yield-and-cancel checkpoint (plan: 2026-07-27 Import Progress And Activities).
 *
 * A long synchronous loop starves the main thread: Svelte cannot repaint, so a status
 * line jumps from nothing straight to its final value, possibly via the browser's
 * "page unresponsive" prompt. `breathe` hands control back to the event loop.
 *
 * It yields on **elapsed time, not item count**. A graph of one-line journals and a graph
 * of 5000-line pages want wildly different batch sizes, and the thing we actually care
 * about is how long a frame has been blocked - so measure that directly.
 *
 * The yield point is also the natural cancel checkpoint, so cancellation rides along at
 * no extra cost (ADR 0035 §3): callers thread one `AbortSignal` and get both.
 */

/** Longest a loop may hold the thread before yielding. ~3 frames: smooth enough to repaint, coarse enough not to dominate. */
const SLICE_MS = 50

/** Per-call-site state, so two concurrent loops do not starve each other's budget. */
export interface Breather {
    (signal?: AbortSignal): Promise<void>
}

/**
 * Create a breather. Call `await breathe(signal)` inside a loop: it returns immediately
 * while the current slice has budget left, and yields when it does not. It throws the
 * signal's reason as soon as the signal aborts, whether or not it yields.
 */
export function createBreather(now: () => number = () => performance.now()): Breather {
    let lastYield = now()
    return async (signal?: AbortSignal) => {
        signal?.throwIfAborted()
        if (now() - lastYield < SLICE_MS) return
        // setTimeout (a macrotask) rather than queueMicrotask or await Promise.resolve():
        // a microtask does NOT let the browser paint, which is the whole point.
        await new Promise((resolve) => setTimeout(resolve))
        lastYield = now()
        signal?.throwIfAborted()
    }
}
