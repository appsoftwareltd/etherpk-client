/**
 * Bounded-concurrency `map`, used to stop serial [[Asset]] upload dominating an [[Import]].
 *
 * Measured on a real 3.83 GB Logseq graph (plan: 2026-07-27 Import Progress And Activities):
 * uploading assets was 84% of a synced import's wall-clock at ~0.58 MB/s, because the
 * asset-to-asset loop was serial while each asset costs three round trips (begin, chunk
 * PUTs, complete). The chunks within one asset were already parallel; the outer loop was not.
 *
 * Two limits, not one:
 *  - **`limit`** caps tasks in flight, which is what recovers the round-trip latency.
 *  - **`maxBytesInFlight`** caps their combined size. This matters because the same drive
 *    measured a 724 MB peak heap: a graph holding several 100 MB+ assets would otherwise
 *    put all of them in memory at once and turn a latency win into an out-of-memory. An item
 *    bigger than the budget still runs (alone), so nothing can deadlock.
 */

export interface PoolOptions<T> {
    /** Maximum tasks in flight. Values below 1 are treated as 1. */
    limit: number
    /** Maximum combined size of in-flight items. Ignored when nothing else is running. */
    maxBytesInFlight?: number
    /** Size of an item, for {@link maxBytesInFlight}. Defaults to 0 (count-only bounding). */
    sizeOf?: (item: T) => number
    signal?: AbortSignal
}

/**
 * Run `task` over `items` with bounded concurrency, resolving to the results **in input
 * order** (not completion order).
 *
 * Rejects with the first error; no further items are admitted after a failure, though tasks
 * already in flight are awaited so nothing is left running behind the caller's back.
 */
export async function mapWithPool<T, R>(
    items: readonly T[],
    task: (item: T, index: number) => Promise<R>,
    options: PoolOptions<T>,
): Promise<R[]> {
    const results = new Array<R>(items.length)
    if (items.length === 0) return results

    const limit = Math.max(1, Math.floor(options.limit))
    const maxBytes = options.maxBytesInFlight ?? Number.POSITIVE_INFINITY
    const sizeOf = options.sizeOf ?? (() => 0)

    let next = 0
    let active = 0
    let bytesInFlight = 0
    let failure: unknown = null

    return new Promise<R[]>((resolve, reject) => {
        const pump = (): void => {
            if (failure === null && options.signal?.aborted) failure = options.signal.reason
            if (failure !== null) {
                if (active === 0) reject(failure)
                return
            }
            if (next >= items.length) {
                if (active === 0) resolve(results)
                return
            }

            while (next < items.length && active < limit) {
                const size = sizeOf(items[next])
                // `active > 0` guard: an item larger than the whole budget must still be
                // admitted when the pool is idle, or it would never run at all.
                if (active > 0 && bytesInFlight + size > maxBytes) break

                const index = next++
                active += 1
                bytesInFlight += size
                // `.then` always defers to a microtask, so this cannot re-enter `pump`
                // synchronously and blow the while-loop's invariants.
                task(items[index], index).then(
                    (result) => {
                        results[index] = result
                        active -= 1
                        bytesInFlight -= size
                        pump()
                    },
                    (error: unknown) => {
                        failure ??= error
                        active -= 1
                        bytesInFlight -= size
                        pump()
                    },
                )
            }
        }
        pump()
    })
}
