/**
 * How the Client's Graphs page and the Sync portal's dashboard wait on a plan the managed Sync
 * Server has not confirmed yet: when to ask again, and when to stop calling it pending.
 *
 * A new account's first statement usually reaches the Sync Server within a second or two of
 * registration (Corporate pushes it, and the Server pulls it itself when it notices the gap), so
 * the first re-checks come quickly. If it has still not arrived after a minute, something is wrong
 * between the two services: the page says the plan cannot be confirmed and keeps checking at a
 * pace that costs the server nothing.
 *
 * Framework-free, so both surfaces share one schedule and it is tested here.
 */

import type { SyncPlanNotice } from './plan-notice'

/** How long a pending plan shows as pending before the page says it cannot be confirmed. */
export const PLAN_PENDING_PATIENCE_MS = 60_000

/** The pace of re-checks after the quick ones, and for a plan that is unconfirmed outright. */
export const PLAN_RECHECK_INTERVAL_MS = 30_000

/**
 * The quick re-checks of a pending plan. They add up to exactly `PLAN_PENDING_PATIENCE_MS`, so the
 * last of them is the check on which the patience runs out: the page then switches to the
 * unconfirmed notice on an answer it has just had.
 */
const PENDING_RECHECK_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000] as const

/**
 * The delay before re-check number `attempt` (0 for the first) of a pending plan: 1, 2, 4, 8, 15,
 * 15 and 15 seconds, then `PLAN_RECHECK_INTERVAL_MS` for as long as it stays pending.
 */
export function planRecheckDelayMs(attempt: number): number {
    const index = Math.max(0, Math.trunc(attempt))
    return PENDING_RECHECK_DELAYS_MS[index] ?? PLAN_RECHECK_INTERVAL_MS
}

/**
 * The delay before the next re-check for the notice the Sync Server gave, or null when the plan is
 * known and there is nothing to wait for. `notice` is the Server's answer from `syncPlanNotice`, not
 * the displayed one: a plan still pending past its patience keeps the pending pace.
 */
export function nextPlanRecheckMs(notice: SyncPlanNotice, attempt: number): number | null {
    if (notice === 'pending') return planRecheckDelayMs(attempt)
    if (notice === 'unconfirmed') return PLAN_RECHECK_INTERVAL_MS
    return null
}

/**
 * The notice to show. A plan the Sync Server has reported pending since `pendingSinceMs` shows as
 * `unconfirmed` once `PLAN_PENDING_PATIENCE_MS` has passed by `nowMs`, so a wait that has stopped
 * being normal is said plainly and offers Check again. `pendingSinceMs` is null until the page has
 * seen the plan pending (a server render has no clock of its own for this), and the plan then
 * shows as pending.
 */
export function displayedPlanNotice(notice: SyncPlanNotice, pendingSinceMs: number | null, nowMs: number): SyncPlanNotice {
    if (notice !== 'pending' || pendingSinceMs === null) return notice
    return nowMs - pendingSinceMs >= PLAN_PENDING_PATIENCE_MS ? 'unconfirmed' : 'pending'
}
