/**
 * One set of words for a plan, its status and its allowances, used on every origin (Corporate's
 * Billing page, the Sync portal, the Client's account card), so an account reads the same wherever
 * it is shown.
 */

import { formatBytes } from '../format/format-bytes'

/** A limit at or above this is no limit: a Sync Server with no plans sets every allowance to it. */
export const UNLIMITED_ALLOWANCE = Number.MAX_SAFE_INTEGER

/**
 * A plan's name. Plan ids are code names on the wire. `unlimited` and `fixed` are a self-hosted
 * Sync Server's own allowances; `remote-unavailable` is what a Sync Server reports while it cannot
 * confirm the plan with its issuer.
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
        case 'remote-unavailable':
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
