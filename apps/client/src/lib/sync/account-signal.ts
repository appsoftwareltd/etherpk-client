/**
 * Tells every open tab of this Client when the device's Sync account stops being usable.
 * Without it, signing out or disconnecting would reach one tab only: another tab with a graph
 * open would keep its socket and go on sending edits as the account, with a green dot, until the
 * socket happened to drop.
 *
 * A BroadcastChannel reaches every other channel object of the same name in this origin,
 * including one in the sending tab, so the account menu and an open workspace in one tab hear
 * each other as well as the tabs beside them. Where BroadcastChannel is missing nothing is sent
 * and each tab finds out at its next token request.
 */
const CHANNEL = 'etherpk-sync-account'

/**
 * Why the account stopped being usable on this device:
 * - `signed-out`: the managed session ended (Sign out, or the Client's session is gone).
 * - `disconnected`: this device's Sync connection was removed (Disconnect this device).
 * - `refused`: the Sync Server no longer accepts this device's credential (a revoked access
 *   token, a password reset, a suspended or deleted account).
 */
export type AccountEndReason = 'signed-out' | 'disconnected' | 'refused'

export type AccountSignal =
    | { type: 'ended'; reason: AccountEndReason }
    /** Something saw a refusal it cannot interpret alone; the account menu re-checks. */
    | { type: 'check' }

/** The cause a workspace records when it stops syncing because of a signal from elsewhere. */
export class AccountEnded extends Error {
    constructor(readonly reason: AccountEndReason) {
        super(`The Sync account on this device ${reason === 'refused' ? 'was refused' : reason === 'signed-out' ? 'signed out' : 'was disconnected'}`)
        this.name = 'AccountEnded'
    }
}

function channel(): BroadcastChannel | null {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL)
}

export function announceAccountSignal(signal: AccountSignal): void {
    const sender = channel()
    if (!sender) return
    sender.postMessage(signal)
    sender.close()
}

/** Listen for signals from this and every other tab. Returns the unsubscribe. */
export function onAccountSignal(listener: (signal: AccountSignal) => void): () => void {
    const receiver = channel()
    if (!receiver) return () => {}
    receiver.onmessage = (event: MessageEvent) => {
        const data = event.data as Partial<AccountSignal> | null
        if (data?.type === 'check') listener({ type: 'check' })
        else if (data?.type === 'ended' && (data.reason === 'signed-out' || data.reason === 'disconnected' || data.reason === 'refused')) {
            listener({ type: 'ended', reason: data.reason })
        }
    }
    return () => receiver.close()
}
