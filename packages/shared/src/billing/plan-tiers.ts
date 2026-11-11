/**
 * The plans EtherPK sells on the managed service, cheapest first. Each is a tier of Sync+: the
 * same service with a different allowance. A deployment's plan catalogue (`MANAGED_PLANS_JSON` on
 * Corporate) sets each tier's limits and prices, and an Entitlement names the tier an account
 * holds in `plan`. The ids are fixed here so every app can name a tier without the catalogue.
 */
export const SYNC_PLUS_PLAN = 'sync_plus'
export const SYNC_PLUS_PRO_PLAN = 'sync_plus_pro'
export const PAID_PLAN_IDS = [SYNC_PLUS_PLAN, SYNC_PLUS_PRO_PLAN] as const

export type PaidPlanId = (typeof PAID_PLAN_IDS)[number]

/** Whether `plan` is a tier of Sync+: a plan someone pays for, whatever its allowance. */
export function isPaidPlan(plan: string): plan is PaidPlanId {
    return (PAID_PLAN_IDS as readonly string[]).includes(plan)
}
