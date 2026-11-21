/**
 * What a synced workspace's sync status says: whether this device's edits have reached the server.
 * Without it, edits made offline or refused by the server would look saved, and the docs' advice
 * to check a graph is caught up before clearing data would have nothing on screen to check. The
 * status answers from the graph session's own state (`GraphSync.activity`) and the browser's
 * online flag.
 *
 * Two functions: {@link describeSyncActivity} says what is true now, and
 * {@link createIndicatorSettle} holds back states that normally pass in a moment (an ack on its
 * way, a reconnect) so the status does not flicker with every keystroke.
 */
import type { SyncActivity } from './graph-sync'
import type { HandoutOutcome } from './key-handouts'

export type SyncIndicatorState =
    | 'synced'
    | 'sending'
    | 'connecting'
    | 'reconnecting'
    | 'turned-away'
    | 'offline'
    | 'refused'
    | 'waiting-for-key'
    | 'ended'

export interface SyncIndicator {
    state: SyncIndicatorState
    /** One or two words for the status row. */
    label: string
    /** The whole story, for the status's panel and its accessible name. */
    detail: string
    /** Documents with changes the server has not acknowledged. */
    unsent: number
}

/** Something the status's panel offers. Here rather than in the component: an instance script cannot export a type. */
export interface SyncStatusAction {
    id: string
    label: string
    /** A link (Billing, on another origin) opens in a new tab; otherwise `run` is called. */
    href?: string
    run?: () => void
    disabled?: boolean
}

/** How long a passing state must last before the status shows it. */
export const INDICATOR_SETTLE_MS = 2_000

/** States that normally clear by themselves within a moment. */
const PASSING: ReadonlySet<SyncIndicatorState> = new Set(['sending', 'connecting', 'reconnecting'])

function documents(count: number): string {
    return count === 1 ? '1 document' : `${count.toLocaleString()} documents`
}

/**
 * Why this device does not hold a new Graph Key epoch's key yet (ADR 0127), from what became of
 * the copy waiting for this account when the workspace last collected it. Null: no copy came, or
 * collecting it failed.
 */
export function describeKeyWait(outcome: HandoutOutcome | null): string {
    const owner = (email: string | null) => email ?? 'the graph’s owner'
    switch (outcome?.kind) {
        case 'owner-key-changed':
            return `The copy that arrived is signed with new Encryption Keys for ${owner(outcome.ownerEmail)}. Compare their fingerprint on the Graphs page, and EtherPK uses it once you confirm it.`
        case 'unverifiable':
            return `The copy that arrived does not carry a valid signature from ${owner(outcome.ownerEmail)}, so EtherPK did not use it. Ask them to rotate the graph’s key again.`
        case 'conflict':
            return 'The copy that arrived holds a key that differs from one this device already has, so EtherPK did not use it. Tell the graph’s owner.'
        default:
            return 'The graph’s owner sends it, and EtherPK keeps asking for it.'
    }
}

/**
 * What a tab the relay turned away says, under the status dot and in the Sync status dialog alike.
 * The last sentence holds because a session sends what the Local Cache still holds when it opens.
 */
export const TURNED_AWAY_NOTICE =
    'Not syncing: this graph is open in too many tabs or devices. Your changes are kept on this device and sync once one of the other tabs is closed. If you close this tab your edits will sync when a newly opened tab next syncs.'

/** The connection states in which no socket is open yet, each with its label and its sentence. */
const WAITING_TO_CONNECT: Partial<Record<SyncActivity['connection'], { label: string; detail: (kept: string) => string }>> = {
    // The relay closed the socket as it opened: this account's connections to the graph are all taken.
    'turned-away': {
        label: 'Not syncing',
        detail: () => TURNED_AWAY_NOTICE,
    },
    connecting: {
        label: 'Connecting',
        detail: (kept) => `Connecting to the sync server. ${kept} until it answers.`,
    },
    reconnecting: {
        label: 'Reconnecting',
        detail: (kept) => `The connection to the sync server dropped and EtherPK is reconnecting. ${kept} until it does.`,
    },
}

/** Whether the status offers **Try again now**: a refused write, or a tab the server turned away. */
export function syncRetryOffered(activity: SyncActivity): boolean {
    return activity.refusal !== null || activity.connection === 'turned-away'
}

/**
 * @param online `navigator.onLine`: false is reliable ("certainly offline"), true is not, which is
 *   why an open socket, not this flag, is what makes the status say Synced.
 * @param refusalReason Why the server refuses, worded for this person (write-refusal.ts).
 * @param keyWaitReason Why the device is still waiting for a new key ({@link describeKeyWait}).
 */
export function describeSyncActivity(activity: SyncActivity, online: boolean, refusalReason?: string, keyWaitReason?: string): SyncIndicator {
    const unsent = activity.unsentDocuments
    const kept = unsent > 0 ? `Changes to ${documents(unsent)} are kept on this device` : 'Changes you make are kept on this device'
    if (activity.connection === 'ended') {
        return { state: 'ended', label: 'Not syncing', detail: 'This graph no longer syncs on this device.', unsent }
    }
    if (activity.refusal) {
        const reason = refusalReason ? ` ${refusalReason}` : ''
        return {
            state: 'refused',
            label: 'Not syncing',
            detail: `The sync server is not accepting changes to this graph.${reason}${unsent > 0 ? ` ${kept}.` : ''}`,
            unsent,
        }
    }
    if (!online) {
        return {
            state: 'offline',
            label: 'Offline',
            detail: `This device is offline. ${kept} and sync when the connection returns.`,
            unsent,
        }
    }
    if (activity.waitingForKey !== null) {
        return {
            state: 'waiting-for-key',
            label: 'Waiting for key',
            detail: `This graph has a new key that this device does not have yet. ${keyWaitReason ?? describeKeyWait(null)} ${kept} and sync once it arrives.`,
            unsent,
        }
    }
    const waiting = WAITING_TO_CONNECT[activity.connection]
    if (waiting) return { state: activity.connection as SyncIndicatorState, label: waiting.label, detail: waiting.detail(kept), unsent }
    if (unsent > 0) {
        return {
            state: 'sending',
            label: 'Sending',
            detail: `Changes to ${documents(unsent)} are on their way to the sync server.`,
            unsent,
        }
    }
    return { state: 'synced', label: 'Synced', detail: 'Every change on this device has reached the sync server.', unsent }
}

/**
 * Hold passing states back until they have lasted {@link INDICATOR_SETTLE_MS}; show everything
 * else at once. A passing state that clears in time is never shown, and one that outlasts the
 * wait is shown as it stands by then.
 */
export function createIndicatorSettle(show: (indicator: SyncIndicator) => void, settleMs = INDICATOR_SETTLE_MS) {
    let shown: SyncIndicator | null = null
    let latest: SyncIndicator | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const display = (indicator: SyncIndicator) => {
        shown = indicator
        show(indicator)
    }
    return {
        update(next: SyncIndicator): void {
            latest = next
            // Settled news, or a passing state already on screen whose count changed.
            if (!PASSING.has(next.state) || shown?.state === next.state) {
                clearTimeout(timer)
                timer = undefined
                display(next)
                return
            }
            timer ??= setTimeout(() => {
                timer = undefined
                if (latest) display(latest)
            }, settleMs)
        },
        dispose(): void {
            clearTimeout(timer)
            timer = undefined
        },
    }
}
