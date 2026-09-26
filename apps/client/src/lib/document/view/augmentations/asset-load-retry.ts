/**
 * Resolve an image's asset, and keep asking while the failure is one that passes.
 *
 * A synced asset is downloaded and decrypted before it can be shown, so a dropped connection or a
 * server failing for a moment rejects the resolve. That is not a missing image: the widget says
 * it is retrying and asks again, after a growing wait with jitter (`withRetry`), capped at a
 * minute, or at once when the browser reports it is online again. An answer is final either way,
 * found or `null` for missing, and so is a failure `retryable` does not accept (a damaged file):
 * retrying that would download it again for ever. The widget cancels when it leaves the document.
 */
import { withRetry } from '$lib/retry'

/** The first wait after a failed attempt; each later one doubles, up to {@link ASSET_RETRY_MAX_DELAY_MS}. */
export const ASSET_RETRY_BASE_DELAY_MS = 2_000
export const ASSET_RETRY_MAX_DELAY_MS = 60_000

export interface AssetLoadHandlers<T> {
    resolved(value: T): void
    missing(): void
    /** An attempt failed in a way that may pass; another follows. */
    unavailable(error: unknown): void
    /** A failure no retry will change: nothing follows. */
    failed(error: unknown): void
}

export interface AssetLoadOptions {
    /** Whether a failure may pass, so the resolve is worth asking again. */
    retryable(error: unknown): boolean
    /** Call `listener` when the browser reports it is online again; returns the unsubscribe. */
    onOnline?(listener: () => void): () => void
    /** Test seam: the jitter's randomness (`withRetry`). */
    random?: () => number
}

/** Start resolving; the function returned cancels it for good. */
export function loadAssetWithRetry<T>(
    resolve: () => Promise<T | null>,
    handlers: AssetLoadHandlers<T>,
    options: AssetLoadOptions,
): () => void {
    const stop = new AbortController()
    const onOnline = options.onOnline ?? browserOnline
    withRetry(() => resolve(), {
        attempts: Number.POSITIVE_INFINITY,
        baseDelayMs: ASSET_RETRY_BASE_DELAY_MS,
        maxDelayMs: ASSET_RETRY_MAX_DELAY_MS,
        shouldRetry: options.retryable,
        onRetry: (error) => handlers.unavailable(error),
        signal: stop.signal,
        sleep: (ms, signal) => waitOrWake(ms, onOnline, signal),
        ...(options.random ? { random: options.random } : {}),
    }).then(
        (value) => {
            if (stop.signal.aborted) return
            if (value === null) handlers.missing()
            else handlers.resolved(value)
        },
        (error: unknown) => {
            if (!stop.signal.aborted) handlers.failed(error)
        },
    )
    return () => stop.abort()
}

/** Wait `ms`, or less if the browser comes back online first; rejects when `signal` aborts. */
function waitOrWake(ms: number, onOnline: (listener: () => void) => () => void, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason)
            return
        }
        const settle = (outcome: () => void) => {
            clearTimeout(timer)
            stopListening()
            signal?.removeEventListener('abort', aborted)
            outcome()
        }
        const woken = () => settle(resolve)
        const aborted = () => settle(() => reject(signal!.reason))
        const timer = setTimeout(woken, ms)
        const stopListening = onOnline(woken)
        signal?.addEventListener('abort', aborted, { once: true })
    })
}

function browserOnline(listener: () => void): () => void {
    window.addEventListener('online', listener)
    return () => window.removeEventListener('online', listener)
}
