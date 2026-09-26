/**
 * How long a synced graph waits before reconnecting to the relay.
 *
 * Each failed attempt doubles the ceiling from half a second up to thirty, and the wait is drawn
 * uniformly below it ("full jitter"), so a crowd of clients dropped together comes back spread
 * over the window rather than in step. A flat 50 ms wait after every close would have a removed
 * member's tab open sixteen to twenty sockets a second, and a Sync Server redeploy would have
 * every connected tab do the same at once. The caller resets the attempt count once a connection
 * has stayed up for {@link STABLE_CONNECTION_MS}.
 *
 * Closes that mean access has ended (4403, a refused token mint) are not retried at all; see
 * `graph-sync.ts`.
 */
export const RECONNECT_BASE_MS = 500
export const RECONNECT_CAP_MS = 30_000
/** A connection that lasted this long was healthy; the next drop starts the schedule again. */
export const STABLE_CONNECTION_MS = 10_000

/** The wait before reconnect attempt `attempt` (1 for the first retry). */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
    // Clamp the exponent: 2 ** 10_000 is Infinity, and Infinity * 0 would be NaN.
    const exponent = Math.min(Math.max(0, attempt - 1), 16)
    const ceiling = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** exponent)
    return Math.floor(random() * ceiling)
}

/**
 * How long a graph waits before sending a write the Sync Server refused on a quota again: a
 * lapsed plan, a storage allowance, or a plan the server could not confirm. The refusal is an
 * answer, not an outage, so the schedule is slower than a reconnect's: the ceiling doubles from
 * ten seconds to two minutes. Half of it is fixed and half drawn below it, so a refused client
 * is never back within milliseconds and a crowd refused together spreads out. `round` counts
 * the retries already made for this refusal, from 1. The workspace also retries at once when the
 * person comes back to the tab, which is when a restarted plan usually shows.
 */
export const REFUSAL_RETRY_BASE_MS = 10_000
export const REFUSAL_RETRY_CAP_MS = 120_000

export function refusalRetryDelayMs(round: number, random: () => number = Math.random): number {
    const exponent = Math.min(Math.max(0, round - 1), 16)
    const ceiling = Math.min(REFUSAL_RETRY_CAP_MS, REFUSAL_RETRY_BASE_MS * 2 ** exponent)
    return Math.floor(ceiling / 2 + random() * (ceiling / 2))
}
