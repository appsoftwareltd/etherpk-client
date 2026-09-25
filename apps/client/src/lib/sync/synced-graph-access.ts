/**
 * How a device reaches a synced graph from outside an open workspace: the sync connection it
 * is configured with, and the graph's keyring out of the vault it already holds unlocked.
 *
 * One place for what three callers used to work out separately - the workspace's open path,
 * the Graphs page's rename and name-read sessions, and the Share Target's direct write - so
 * the rule for "can this device act on this graph without asking anything" is written once.
 * Nothing here prompts: a missing configuration, a locked vault or an absent keyring reads as
 * `null`, and the caller decides between falling back to the workspace (which owns the unlock
 * prompt, the Recovery Code ritual and every notice) and giving up.
 */
import { fromBase64Url, openVault, type GraphKeyring, type OpenedVault } from '$lib/crypto'

import { relayUrlFrom, readSyncConfig } from './sync-config'
import { resolveSyncConnection } from './sync-connection'
import { createSyncApi, type SyncApi } from './sync-api'
import { createSyncTokenSource, type SyncTokenSource } from './sync-token'
import { getVaultWrapKey, setVaultWrapKey } from './vault-session'

export interface SyncedGraphConnection {
    api: SyncApi
    serverBaseUrl: string
    /** The `ws(s)://…/sync` relay derived from the server origin. */
    relayUrl: string
    /**
     * A refreshing token source for `graphId`, never a captured token: a socket reconnects and
     * uploads run for longer than one token's fifteen minutes.
     */
    token: SyncTokenSource
}

/** The device's sync connection, ready to act on `graphId`; null when no sync is configured. */
export function resolveSyncedGraphConnection(graphId: string): SyncedGraphConnection | null {
    const config = readSyncConfig()
    const connection = config ? resolveSyncConnection(config) : null
    if (!connection) return null
    const api = createSyncApi({ baseUrl: connection.serverBaseUrl, token: connection.token })
    return {
        api,
        serverBaseUrl: connection.serverBaseUrl,
        relayUrl: relayUrlFrom(connection.serverBaseUrl),
        token: createSyncTokenSource(() => api.mintSyncToken(graphId)),
    }
}

/**
 * The account's vault opened under the key this device holds, or null when the device holds
 * no key (the vault is locked here) or the account has no vault yet. A key that does not open
 * the vault is an error, not "locked": the caller must not read a stale or foreign key as a
 * clean miss. Opening re-caches the vault key itself, which survives a Recovery Code
 * regenerate where a code-derived wrap key would not.
 */
export async function openHeldVault(
    api: Pick<SyncApi, 'getVault'>,
    wrapKey: Uint8Array | null = getVaultWrapKey(),
): Promise<OpenedVault | null> {
    if (!wrapKey) return null
    const existing = await api.getVault()
    if (!existing) return null
    const opened = await openVault(fromBase64Url(existing.vault), wrapKey)
    try {
        setVaultWrapKey(opened.vaultKey)
    } catch {
        // No active account partition to cache under (a test, or a device mid sign-out):
        // the vault still opened, and caching is only a convenience for the next time.
    }
    return opened
}

/** `graphId`'s keyring from the held vault, or null when the vault is locked here or lacks one. */
export async function heldGraphKeyring(
    api: Pick<SyncApi, 'getVault'>,
    graphId: string,
    wrapKey: Uint8Array | null = getVaultWrapKey(),
): Promise<GraphKeyring | null> {
    const opened = await openHeldVault(api, wrapKey)
    return opened?.vault.keyrings.find((k) => k.graphId === graphId) ?? null
}
