/**
 * What an open graph tells the person when its sync session ends for good: the member left in
 * another tab or was removed, the account signed out or disconnected elsewhere, or the Sync
 * Server refused a revoked token. Without the notice the tab would stay editable with a green
 * dot, and in the first case its edits would replay into the shared graph after a re-invite.
 */
import { ManagedTokenError } from '$lib/auth/managed-token'
import { AccountEnded } from './account-signal'
import type { SyncAccessLoss } from './graph-sync'

export type WorkspaceAccessLoss =
    /** The account can no longer reach this graph; `unsentDocuments` hold changes that will never be sent. */
    | { reason: 'membership'; unsentDocuments: number }
    /** The managed session ended, here or in another tab. */
    | { reason: 'signed-out' }
    /** This device's Sync connection was removed, here or in another tab. */
    | { reason: 'disconnected'; server: string | null }
    /** The Sync Server refused this device's credential. */
    | { reason: 'refused'; managed: boolean; server: string | null }

/** Turn the sync session's reason into the one the workspace shows. */
export function workspaceAccessLoss(
    loss: SyncAccessLoss,
    context: { managed: boolean; server: string | null; unsentDocuments: number },
): WorkspaceAccessLoss {
    if (loss.kind === 'membership') return { reason: 'membership', unsentDocuments: context.unsentDocuments }
    const cause = loss.cause
    if (cause instanceof AccountEnded) {
        if (cause.reason === 'signed-out') return { reason: 'signed-out' }
        if (cause.reason === 'disconnected') return { reason: 'disconnected', server: context.server }
    }
    // The Client's own server answered 401 for the managed token: its session is gone.
    if (cause instanceof ManagedTokenError) return { reason: 'signed-out' }
    return { reason: 'refused', managed: context.managed, server: context.server }
}

export interface AccessLossNotice {
    title: string
    body: string
    /** The way back in, when there is one; "Back to graphs" is always offered beside it. */
    primary?: { label: string; href: string }
    /** Offer to download the changes that will not be sent. */
    canDownload: boolean
}

const SIGN_IN = { label: 'Sign in again', href: '/auth/login' }
const CONNECT = { label: 'Connect again', href: '/graphs?sync=connect' }
const KEPT = 'Changes you made here are kept on this device and sync when you are back in.'

export function describeAccessLoss(loss: WorkspaceAccessLoss): AccessLossNotice {
    switch (loss.reason) {
        case 'membership': {
            const unsent = loss.unsentDocuments === 1
                ? ' Changes made on this device to 1 document were not saved to the server and will not be sent.'
                : loss.unsentDocuments > 1
                    ? ` Changes made on this device to ${loss.unsentDocuments.toLocaleString()} documents were not saved to the server and will not be sent.`
                    : ''
            return {
                title: 'You no longer have access to this graph',
                body: `You left it in another tab, the owner removed you, or the owner deleted it, so it has stopped syncing.${unsent}${unsent ? ' Download a copy to keep them.' : ''}`,
                canDownload: loss.unsentDocuments > 0,
            }
        }
        case 'signed-out':
            return {
                title: 'You are signed out',
                body: `This graph stopped syncing because you signed out of EtherPK, in this tab or another. ${KEPT}`,
                primary: SIGN_IN,
                canDownload: false,
            }
        case 'disconnected':
            return {
                title: 'This device was disconnected',
                body: `Sync was disconnected on this device${loss.server ? ` from ${loss.server}` : ''}, in this tab or another, so this graph stopped syncing. ${KEPT}`,
                primary: CONNECT,
                canDownload: false,
            }
        case 'refused':
            return loss.managed
                ? {
                      title: 'Your sign-in is no longer accepted',
                      body: `The Sync Server refused this device's sign-in. That happens after a password reset, or when the account is suspended or deleted. ${KEPT}`,
                      primary: SIGN_IN,
                      canDownload: false,
                  }
                : {
                      title: 'The access token on this device no longer works',
                      body: `${loss.server ?? 'The Sync Server'} refused it: it was revoked or has expired, or the account's password was reset. Create a new token under Access tokens on the server and connect again. ${KEPT}`,
                      primary: CONNECT,
                      canDownload: false,
                  }
    }
}
