/**
 * Run something *after* a burst of signals settles, but never later than a cap.
 *
 * The [[Tasks View]] re-queries whenever the [[Derived Index]] updates, and the index updates
 * on every ingest — which is every ~150ms while someone types. Re-querying that often makes
 * the list visibly churn for no benefit: nobody reads a task list mid-keystroke, and the
 * answer is stale again before it renders.
 *
 * Plain debouncing is not enough on its own. Someone typing steadily never lets the timer
 * settle, so the list would freeze for as long as they kept typing. Hence the cap: the run
 * happens once the signals stop, OR once `maxWaitMs` has passed since the first unserved
 * signal, whichever comes first.
 */

export interface SettleScheduler {
    /** Note a signal. Runs after the burst settles, or at the cap. */
    schedule(): void
    /** Run now, dropping anything pending (a deliberate user action should not wait). */
    flush(): void
    /** Drop anything pending without running it. */
    cancel(): void
}

export interface SettleOptions {
    /** Quiet period before running. */
    settleMs: number
    /** Longest a continuous stream of signals can hold the run off. */
    maxWaitMs: number
}

export function createSettleScheduler(run: () => void, options: SettleOptions): SettleScheduler {
    let timer: ReturnType<typeof setTimeout> | undefined
    /** When the first signal of the current burst arrived — the cap is measured from here. */
    let burstStartedAt = 0

    function clear(): void {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
    }

    return {
        schedule() {
            const now = Date.now()
            if (timer === undefined) burstStartedAt = now
            else clearTimeout(timer)
            // Shorten the quiet period as the cap approaches, so a steady stream of signals
            // still gets served every `maxWaitMs` rather than being starved indefinitely.
            const remaining = Math.max(0, options.maxWaitMs - (now - burstStartedAt))
            timer = setTimeout(() => {
                timer = undefined
                run()
            }, Math.min(options.settleMs, remaining))
        },
        flush() {
            clear()
            run()
        },
        cancel: clear,
    }
}
