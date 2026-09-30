/**
 * One set of words for a plan, its status and its allowances, used on every origin (Corporate's
 * Billing page, the Sync portal, the Client's account card), so an account reads the same wherever
 * it is shown.
 */

import { formatBytes } from '../format/format-bytes'

/** A limit at or above this is no limit: a Sync Server with no plans sets every allowance to it. */
export const UNLIMITED_ALLOWANCE = Number.MAX_SAFE_INTEGER

/**
 * The plan a managed Sync Server reports while it holds no statement from EtherPK for the account
 * yet: a new account whose first Entitlement is still on its way (`provider.ts` in the Sync
 * Server). Read-only with nothing granted, and expected to clear within seconds, because the
 * Server pulls the missing statement as soon as it notices the gap.
 */
export const PLAN_PENDING = 'remote-pending'

/**
 * The plan a managed Sync Server reports when the statement it holds from EtherPK has expired, or
 * when it cannot tell which Billing Account the signed-in principal belongs to. The request path
 * only reads the Server's cache; a fresh statement arrives by Corporate's push or the Server's
 * scheduled pull. Read-only for the moment, not ended.
 */
export const PLAN_UNCONFIRMED = 'remote-unavailable'

/**
 * A plan's name. Plan ids are code names on the wire. `unlimited` and `fixed` are a self-hosted
 * Sync Server's own allowances; `remote-pending` and `remote-unavailable` are what a managed Sync
 * Server reports while it is waiting for, or cannot confirm, the plan with its issuer.
 */
export function planLabel(plan: string): string {
    switch (plan) {
        case 'sync_plus':
            return 'Sync+'
        case 'free':
            return 'Free'
        case 'unlimited':
            return 'Unlimited'
        case 'fixed':
            return 'Fixed limits'
        case PLAN_PENDING:
            return 'Confirming plan…'
        case PLAN_UNCONFIRMED:
            return 'Plan status unavailable'
        default:
            return plan
    }
}

/**
 * A Sync Server's own allowance (`unlimited`, `fixed`) rather than a plan someone holds: there is
 * no plan or status to show for it, only the allowance.
 */
export function isServerAllowance(plan: string): boolean {
    return plan === 'unlimited' || plan === 'fixed'
}

/** What a statement says about a plan's state, for its status label. */
export interface EntitlementState {
    status: string
    /** A payment is outstanding: explains a grace or read-only status. */
    paymentOverdue?: boolean
    /** When a trial ends, while it runs. */
    trialEndsAt?: string
}

/**
 * A status in words: a trial with its end date, and a payment problem named as one. A grace
 * status exists only while a payment is outstanding, so it reads as the failed payment it is.
 */
export function entitlementStatusLabel(state: EntitlementState, formatDate: (iso: string) => string): string {
    switch (state.status) {
        case 'active':
            return state.trialEndsAt ? `Trial, ends ${formatDate(state.trialEndsAt)}` : 'Active'
        case 'grace':
            return 'Payment failed'
        case 'read_only':
            return state.paymentOverdue ? 'Payment overdue' : 'Read-only'
        case 'suspended':
            return 'Suspended'
        case 'identity_disabled':
            return 'Account disabled'
        default: {
            const words = state.status.replaceAll('_', ' ')
            return words.charAt(0).toUpperCase() + words.slice(1)
        }
    }
}

/**
 * The plan and its status on one line: "Sync+ · Trial, ends 7 Oct 2026". A plan still being
 * confirmed is the label alone: its `read_only` status is a stand-in that lasts seconds, and
 * "Read-only" beside it would tell a new account something is wrong.
 */
export function planStatusLine(state: EntitlementState & { plan: string }, formatDate: (iso: string) => string): string {
    if (state.plan === PLAN_PENDING) return planLabel(state.plan)
    return `${planLabel(state.plan)} · ${entitlementStatusLabel(state, formatDate)}`
}

/** An allowance: "Unlimited" where there is none, else a size or a count. */
export function formatLimit(value: number, kind: 'count' | 'bytes'): string {
    if (value >= UNLIMITED_ALLOWANCE) return 'Unlimited'
    return kind === 'bytes' ? formatBytes(value) : value.toLocaleString('en-US')
}

/** Usage against its allowance ("3 of 25", "1.5 KiB of 10 GiB"), or the usage alone where there is no limit. */
export function formatUsage(used: number, limit: number, kind: 'count' | 'bytes'): string {
    const amount = kind === 'bytes' ? formatBytes(used) : used.toLocaleString('en-US')
    return limit >= UNLIMITED_ALLOWANCE ? amount : `${amount} of ${formatLimit(limit, kind)}`
}
