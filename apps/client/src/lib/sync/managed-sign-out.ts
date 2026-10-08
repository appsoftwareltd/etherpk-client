import { clearManagedAccessToken } from '$lib/auth/managed-token'
import { announceAccountSignal } from './account-signal'
import { clearSyncAccount } from './account-scope'
import { listSyncConnections } from './sync-connection'
import { lockVault } from './vault-session'

/**
 * This browser's part of **Sign out of EtherPK**, wherever the sign-out started: the Client's own
 * menu, or the account site or the Sync portal, whose sign-out passes through a Client page to
 * run this. It forgets the access token held in memory, locks Managed Sync's Encryption Keys
 * (locking needs the account's scope, so it comes before the account record is cleared), and tells
 * every open Client tab, whose graphs on that server stop syncing at once. A custom server's
 * account is its own, so it is left alone.
 */
export function endManagedSessionInThisBrowser(): void {
    clearManagedAccessToken()
    const managed = listSyncConnections().find((held) => held.kind === 'managed')
    if (managed) {
        lockVault(managed.origin)
        clearSyncAccount(managed.origin)
    }
    announceAccountSignal({ type: 'ended', reason: 'signed-out', ...(managed ? { serverOrigin: managed.origin } : {}) })
}
