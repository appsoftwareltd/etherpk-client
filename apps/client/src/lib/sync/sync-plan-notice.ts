import type { SyncAccountSummary } from '@appsoftwareltd/etherpk-shared'

/**
 * What the Graphs page says about a managed account's plan, beside the plan line:
 *
 * - `payment_failed`: a payment failed and Stripe is retrying; the owner can still write.
 * - `payment_overdue`: read-only because a payment is still outstanding.
 * - `ended`: read-only because Sync+ ended (a cancellation, or retries that ran out).
 * - `unconfirmed`: read-only because the Sync Server cannot confirm the plan with EtherPK.
 * - `upsell`: a Free account that can own no synced graph.
 *
 * A lapsed owner has the Free allowance, so a test for `upsell` on the allowance alone ("owns
 * nothing allowed") would also match every cancelled subscriber and show them the trial pitch
 * instead of the read-only notice. Status decides first; the allowance only after it.
 */
export type SyncPlanNotice = 'payment_failed' | 'payment_overdue' | 'ended' | 'unconfirmed' | 'upsell' | null

/**
 * The plan the Sync Server reports when its cached statement from EtherPK has expired and it
 * cannot fetch a new one (`provider.ts` in the Sync Server). Read-only for a moment, not ended.
 */
const PLAN_UNCONFIRMED = 'remote-unavailable'

export function syncPlanNotice(account: SyncAccountSummary): SyncPlanNotice {
    // A self-hosted Server has no plans to sell or lapse.
    if (account.authentication.mode !== 'managed') return null
    const { status, plan, limits, paymentOverdue } = account.entitlement
    // Grace exists only while a payment is outstanding, whatever the Corporate version.
    if (status === 'grace') return 'payment_failed'
    if (status === 'read_only') {
        if (paymentOverdue) return 'payment_overdue'
        return plan === PLAN_UNCONFIRMED ? 'unconfirmed' : 'ended'
    }
    if (status === 'active' && limits.ownedGraphs === 0) return 'upsell'
    return null
}

/**
 * Whether the Sync Server accepts writes and new Players on graphs this account owns: the same
 * rule as `assertWriteAllowed` in the Server's quota policy. Unknown (no account yet) counts as
 * yes, so nothing is hidden before the account check answers.
 */
export function ownerCanWrite(account: SyncAccountSummary | null): boolean {
    if (!account) return true
    return account.entitlement.status === 'active' || account.entitlement.status === 'grace'
}
