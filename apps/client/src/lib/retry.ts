/**
 * Bounded retry with exponential backoff, for network calls whose failure would cost far
 * more than the wait.
 *
 * The motivating loss (2026-07-27 live drive): a synced import of a 7 GB graph uploaded 4592
 * assets over fifteen minutes, hit ONE failed request, and unwound the lot - `mapWithPool`
 * rejects on the first error and `runServerImport` deletes the graph it had just filled.
 * Twenty minutes of upload has to survive a blip; a transient failure is not a decision.
 *
 * Deliberately NOT a blanket retry: `shouldRetry` decides, and callers pass a predicate that
 * knows which failures are the server's or the network's (5xx, 429, a dropped connection)
 * rather than ours (a 400 will be a 400 every time, and retrying it just delays the message).
 */

/** Attempts including the first: three retries is enough for a blip, short of a hang. */
const DEFAULT_ATTEMPTS = 4
const DEFAULT_BASE_DELAY_MS = 500

export interface RetryOptions {
    /** Total attempts INCLUDING the first. Default 4. Values below 1 are treated as 1. */
    attempts?: number
    /** The first backoff; each subsequent wait doubles it. Default 500ms. */
    baseDelayMs?: number
    /** Whether an error is worth another attempt. Default: retry everything. */
    shouldRetry?: (error: unknown) => boolean
    /** Observation only (logging, telemetry) - never control flow. */
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void
    /** A cancelled [[Import]] must not sit out a backoff, so the wait aborts with it. */
    signal?: AbortSignal
    /** Test seams. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
    random?: () => number
}

/** Rejects with the signal's reason the moment it aborts, rather than running the timer out. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason)
            return
        }
        const onAbort = () => {
            clearTimeout(timer)
            reject(signal!.reason)
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

/**
 * Run `task`, retrying on failure until it succeeds, the attempts run out, `shouldRetry`
 * declines, or the signal aborts. The last error is rethrown as-is: a caller that wraps
 * failures in its own message still gets the real cause.
 *
 * Backoff carries equal jitter (half fixed, half random). Asset upload runs six at a time,
 * so a shared outage would otherwise retry all six in lockstep and hit the server as a wave.
 */
export async function withRetry<T>(task: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
    const attempts = Math.max(1, Math.floor(options.attempts ?? DEFAULT_ATTEMPTS))
    const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
    const sleep = options.sleep ?? delay
    const random = options.random ?? Math.random
    const shouldRetry = options.shouldRetry ?? (() => true)

    for (let attempt = 1; ; attempt++) {
        if (options.signal?.aborted) throw options.signal.reason
        try {
            return await task(attempt)
        } catch (error) {
            // Cancellation reads as cancellation, never as the failure it interrupted.
            if (options.signal?.aborted) throw options.signal.reason
            if (attempt >= attempts || !shouldRetry(error)) throw error
            const full = base * 2 ** (attempt - 1)
            const wait = Math.round(full / 2 + random() * (full / 2))
            options.onRetry?.(error, attempt, wait)
            await sleep(wait, options.signal)
        }
    }
}
