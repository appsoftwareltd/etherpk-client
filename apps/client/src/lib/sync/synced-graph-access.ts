/**
 * How a device reaches a synced graph from outside an open workspace: the Sync Connection for the
 * server the graph lives on (ADR 0111), and the graph's keyring out of that server's vault, which
 * the device already holds unlocked.
 *
 * One place for what three callers used to work out separately - the workspace's open path,
 * the Graphs page's rename and name-read sessions, and the Share Target's direct write - so
 * the rule for "can this device act on this graph without asking anything" is written once.
 * Nothing here prompts: a missing configuration, a locked vault or an absent keyring reads as
 * `null`, and the caller decides between falling back to the workspace (which owns the unlock
 * prompt, the Recovery Code ritual and every notice) and giving up.
 */
import { fromBase64Url, openVault, type GraphKeyring, type OpenedVault } from '$lib/crypto'

import { relayUrlFrom } from './sync-connections'
import { syncApiFor, syncConnectionFor } from './sync-connection'
import type { SyncApi } from './sync-api'
import { createSyncTokenSource, type SyncTokenSource } from './sync-token'
import { getVaultWrapKey, setVaultWrapKey } from './vault-session'

export interface SyncedGraphConnection {
    api: SyncApi
    /** The graph's server: whose account partition its vault key is cached under. */
    origin: string
    serverBaseUrl: string
    /** The `ws(s)://…/sync` relay derived from the server origin. */
    relayUrl: string
    /**
     * A refreshing token source for `graphId`, never a captured token: a socket reconnects and
     * uploads run for longer than one token's fifteen minutes.
     */
    token: SyncTokenSource
}

/**
 * The connection to `serverOrigin` - the server `graphId` lives on, from its registry record -
 * ready to act on the graph; null when this device holds no connection to that server.
 */
export function resolveSyncedGraphConnection(graphId: string, serverOrigin: string): SyncedGraphConnection | null {
    const connection = syncConnectionFor(serverOrigin)
    if (!connection) return null
    const api = syncApiFor(connection)
    return {
        api,
        origin: connection.origin,
        serverBaseUrl: connection.serverBaseUrl,
        relayUrl: relayUrlFrom(connection.serverBaseUrl),
        token: createSyncTokenSource(() => api.mintSyncToken(graphId)),
    }
}

/** A server's Sync API and its origin: enough to read its vault and cache what opens it. */
export interface VaultAccess {
    api: Pick<SyncApi, 'getVault'>
    origin: string
}

/**
 * The vault of the account on `access.origin`, opened under the key this device holds, or null
 * when the device holds no key (the vault is locked here) or the account has no vault yet. A key that does not open
 * the vault is an error, not "locked": the caller must not read a stale or foreign key as a
 * clean miss. Opening re-caches the vault key itself, which survives a Recovery Code
 * regenerate where a code-derived wrap key would not.
 */
export async function openHeldVault(
    access: VaultAccess,
    wrapKey: Uint8Array | null = getVaultWrapKey(access.origin),
): Promise<OpenedVault | null> {
    if (!wrapKey) return null
    const existing = await access.api.getVault()
    if (!existing) return null
    const opened = await openVault(fromBase64Url(existing.vault), wrapKey)
    try {
        setVaultWrapKey(access.origin, opened.vaultKey)
    } catch {
        // No confirmed account on that server to cache under (a test, or a device mid sign-out):
        // the vault still opened, and caching is only a convenience for the next time.
    }
    return opened
}

/** `graphId`'s keyring from the held vault, or null when the vault is locked here or lacks one. */
export async function heldGraphKeyring(
    access: VaultAccess,
    graphId: string,
    wrapKey: Uint8Array | null = getVaultWrapKey(access.origin),
): Promise<GraphKeyring | null> {
    const opened = await openHeldVault(access, wrapKey)
    return opened?.vault.keyrings.find((k) => k.graphId === graphId) ?? null
}
