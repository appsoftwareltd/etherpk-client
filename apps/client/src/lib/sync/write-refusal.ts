/**
 * What to tell someone whose edits the Sync Server is refusing.
 *
 * The relay refuses a write on a quota: the graph owner's plan has ended, a payment is overdue,
 * the plan cannot be confirmed with EtherPK, or the owner's storage allowance is used up. Nothing
 * is lost: the refused operations stay in the durable outbox and are sent again until the server
 * accepts one (graph-sync.ts). What differs is who can do something about it. An owner can
 * restart the plan or fix the payment; a Player can only wait for the owner. The kinds of plan
 * notice are the Graphs page's (sync-plan-notice.ts), so the two surfaces never disagree.
 *
 * Pure, so each case is unit tested rather than read off a screenshot.
 */
import type { QuotaErrorCode } from '@appsoftwareltd/etherpk-shared'
import type { WriteRefusal } from './graph-sync'
import type { SyncPlanNotice } from './sync-plan-notice'

export interface WriteRefusalContext {
    refusal: WriteRefusal
    /** Whether this account owns the graph; null when that could not be checked. */
    owner: boolean | null
    /** This account's plan notice, when the account was checked (managed only). */
    plan: SyncPlanNotice
    /** Managed Sync, where plans are bought on EtherPK's Billing page. */
    managed: boolean
}

export interface WriteRefusalCopy {
    /** Why the server refuses, as one sentence. */
    reason: string
    /** Where the changes are and what makes them sync, as one sentence. */
    next: string
    /** The Billing page link to offer, and its label; null when Billing cannot help this person. */
    billing: { label: string } | null
}

const KEPT = 'Your changes are kept on this device and sync'

export function describeWriteRefusal({ refusal, owner, plan, managed }: WriteRefusalContext): WriteRefusalCopy {
    const code = refusal.quotaCode
    if (code === 'entitlement_inactive') {
        if (owner === false) {
            return {
                reason: "The owner's plan does not allow changes to this graph at the moment.",
                next: `${KEPT} once the owner's plan is active again.`,
                billing: null,
            }
        }
        if (managed && plan === 'unconfirmed') {
            return {
                reason: 'The sync server cannot confirm your plan with EtherPK at the moment.',
                next: `${KEPT} on their own once it can.`,
                billing: null,
            }
        }
        if (managed && owner === true && plan === 'payment_overdue') {
            return {
                reason: 'A Sync+ payment is overdue, so the graphs you own are read-only.',
                next: `${KEPT} once the payment is fixed.`,
                billing: { label: 'Fix payment' },
            }
        }
        if (managed && owner === true) {
            return {
                reason: 'Your Sync+ subscription has ended, so the graphs you own are read-only.',
                next: `${KEPT} once you restart Sync+.`,
                billing: { label: 'Restart Sync+' },
            }
        }
        return {
            reason: managed
                ? "The graph owner's plan does not allow changes at the moment."
                : 'This sync server’s limits do not allow changes to this graph at the moment.',
            next: `${KEPT} on their own once it does.`,
            billing: null,
        }
    }
    if (code === 'owned_storage_limit') {
        if (owner === true) {
            return {
                reason: managed ? 'You have reached your plan’s storage allowance.' : 'You have reached your storage allowance on this sync server.',
                next: `${KEPT} once there is room: delete unused documents or assets${managed ? ', or move to a larger plan' : ''}.`,
                billing: managed ? { label: 'Open Billing' } : null,
            }
        }
        return {
            reason: managed
                ? 'The graph owner has reached their plan’s storage allowance.'
                : 'The graph owner has reached their storage allowance on this sync server.',
            next: `${KEPT} once the owner makes room.`,
            billing: null,
        }
    }
    return {
        reason: managed
            ? 'A plan limit does not allow more changes to this graph at the moment.'
            : 'A plan limit on this sync server does not allow more changes at the moment.',
        next: `${KEPT} on their own once it does.`,
        billing: null,
    }
}

const AGENT_REASONS: Partial<Record<QuotaErrorCode, string>> = {
    entitlement_inactive: "the graph owner's plan does not allow changes at the moment (a lapsed, unpaid or unconfirmed plan)",
    owned_storage_limit: "the graph owner's storage allowance is used up",
}

/**
 * The Headless Client's refusal, for an agent: the edit was refused, not lost in transit, and it
 * needs no retry from the agent. The connection-loss wording ("will be delivered when the
 * connection recovers") is untrue of a refusal.
 */
export function writeRefusalForAgent(refusal: WriteRefusal, outstanding: number): string {
    const reason = (refusal.quotaCode && AGENT_REASONS[refusal.quotaCode]) ?? 'a plan limit was reached'
    const held = outstanding === 1 ? '1 operation is held' : `${outstanding} operations are held`
    return `The Sync Server refused the edit: ${reason}. ${held} here and sent automatically once the server accepts changes again.`
}
