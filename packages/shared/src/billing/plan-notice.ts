import type { SyncAccountSummary } from '../managed-service'
import { PLAN_PENDING, PLAN_UNCONFIRMED } from './plan-display'

/**
 * What the Client's Graphs page and the Sync portal's dashboard say about a managed account's plan,
 * beside the plan line:
 *
 * - `payment_failed`: a payment failed and Stripe is retrying; the owner can still write.
 * - `payment_overdue`: read-only because a payment is still outstanding.
 * - `ended`: read-only because Sync+ ended (a cancellation, or retries that ran out).
 * - `pending`: read-only for a few seconds while the Sync Server waits for a new account's first
 *   statement from EtherPK. The surfaces re-check it and fall back to `unconfirmed` if it lasts
 *   (`displayedPlanNotice` in plan-recheck.ts).
 * - `unconfirmed`: read-only because the Sync Server cannot confirm the plan with EtherPK.
 * - `upsell`: a Free account that can own no synced graph.
 *
 * A lapsed owner has the Free allowance, so a test for `upsell` on the allowance alone ("owns
 * nothing allowed") would also match every cancelled subscriber and show them the trial pitch
 * instead of the read-only notice. Status decides first; the allowance only after it.
 */
export type SyncPlanNotice = 'payment_failed' | 'payment_overdue' | 'ended' | 'pending' | 'unconfirmed' | 'upsell' | null

export function syncPlanNotice(account: SyncAccountSummary): SyncPlanNotice {
    // A self-hosted Server has no plans to sell or lapse.
    if (account.authentication.mode !== 'managed') return null
    const { status, plan, limits, paymentOverdue } = account.entitlement
    // Grace exists only while a payment is outstanding, whatever the Corporate version.
    if (status === 'grace') return 'payment_failed'
    if (status === 'read_only') {
        // A statement from EtherPK that says a payment is overdue is the most specific answer.
        // The Server's two stand-in plans never carry the flag, so this order cannot hide them.
        if (paymentOverdue) return 'payment_overdue'
        if (plan === PLAN_PENDING) return 'pending'
        return plan === PLAN_UNCONFIRMED ? 'unconfirmed' : 'ended'
    }
    if (status === 'active' && limits.ownedGraphs === 0) return 'upsell'
    return null
}

/**
 * What each plan notice says, in the same sentences on the Client's Graphs page and the Sync
 * portal's dashboard. The offer to a Free account is each surface's own, since what Free can do
 * there differs.
 */
export const PLAN_NOTICE_TEXT = {
    payment_failed:
        'Your last Sync+ payment failed. Fix it from Billing to keep syncing: if it is not paid, the graphs you own become read-only.',
    payment_overdue:
        'A Sync+ payment is overdue, so the graphs you own are read-only. You can still open, export and delete them. Fix the payment from Billing to make them writable again.',
    ended:
        'Your Sync+ subscription has ended, so the graphs you own are read-only. You can still open, export and delete them. Owned graphs are deleted from the managed service after a retention period, so export anything you want to keep.',
    pending: 'Confirming your plan with EtherPK…',
    // Both surfaces re-check an unconfirmed plan on their own and offer Check again, so this
    // asks nothing of the reader.
    unconfirmed:
        'Your plan cannot be confirmed right now, so the graphs you own are read-only for the moment. Nothing is lost. This page keeps checking.',
} as const satisfies Record<Exclude<SyncPlanNotice, 'upsell' | null>, string>

/**
 * Whether the Sync Server accepts writes and new Players on graphs this account owns: the same
 * rule as `assertWriteAllowed` in the Server's quota policy. Unknown (no account yet) counts as
 * yes, so nothing is hidden before the account check answers.
 */
export function ownerCanWrite(account: SyncAccountSummary | null): boolean {
    if (!account) return true
    return account.entitlement.status === 'active' || account.entitlement.status === 'grace'
}
