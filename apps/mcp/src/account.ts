/**
 * The account side of the [[Headless Client]]: the same REST bridge and vault the browser uses,
 * driven from a config file instead of a session. A [[Personal Access Token]] authenticates; the
 * vault key decrypts. Neither is minted here - `login.ts` obtains the second, the portal the first.
 */

import { fromBase64Url, openVault, type GraphKeyring, type KeyVault } from '$lib/crypto'
import { createSyncApi, type ServerGraphRecord, type SyncApi } from '$lib/sync/sync-api'
import { relayUrlFrom } from '$lib/sync/sync-config'
import { createSyncTokenSource, type SyncTokenSource } from '$lib/sync/sync-token'

import type { ServerCredentials } from './config'

export interface HeadlessAccount {
    readonly api: SyncApi
    readonly serverBaseUrl: string
    readonly relayUrl: string
    /** Who the PAT resolves to, for the login summary. */
    readonly principal: { id: string; email: string | null; name: string | null }
    /** The EtherPK Client for this deployment, when the Server declares one (older ones do not). */
    readonly clientUrl: string | null
    /** A token source for one graph, re-minted on every reconnect (a session outlives a token). */
    tokenFor(graphId: string): SyncTokenSource
}

export function createHeadlessAccount(config: Pick<ServerCredentials, 'syncServer' | 'pat'>): Omit<HeadlessAccount, 'principal' | 'clientUrl'> {
    const api = createSyncApi({ baseUrl: config.syncServer, token: config.pat })
    return {
        api,
        serverBaseUrl: config.syncServer,
        relayUrl: relayUrlFrom(config.syncServer),
        tokenFor: (graphId) => createSyncTokenSource(() => api.mintSyncToken(graphId)),
    }
}

/** Resolve the PAT to its principal; a graph-scoped or revoked token fails here, in words. */
export async function connectAccount(config: Pick<ServerCredentials, 'syncServer' | 'pat'>): Promise<HeadlessAccount> {
    const account = createHeadlessAccount(config)
    const me = await account.api.me()
    return {
        ...account,
        principal: { id: me.principal.id, email: me.principal.email, name: me.principal.name },
        clientUrl: me.clientUrl ?? null,
    }
}

/**
 * Open the account vault with the cached vault key. Never writes: a device that only reads the
 * vault cannot create keyrings, mint a Recovery Code or upgrade a blob, which is right for a
 * process that exists to serve one graph.
 */
export async function openAccountVault(api: SyncApi, vaultKey: Uint8Array): Promise<KeyVault> {
    const stored = await api.getVault()
    if (!stored) {
        throw new Error('This account has no encryption keys yet. Open EtherPK, create or accept a synced graph, and save the Recovery Code first.')
    }
    return (await openVault(fromBase64Url(stored.vault), vaultKey)).vault
}

export interface ResolvedGraph {
    record: ServerGraphRecord
    keyring: GraphKeyring
}

/**
 * The graph the user named, by id, from the graphs the PAT can see and the keyrings the vault
 * holds. A graph the account is a member of but has no keyring for is an invite not yet
 * accepted in EtherPK - said so, rather than reported as "not found".
 */
export function resolveGraphById(graphs: ServerGraphRecord[], vault: KeyVault, graphId: string): ResolvedGraph {
    const record = graphs.find((graph) => graph.id === graphId)
    if (!record) {
        throw new Error(`No synced graph with id ${graphId} is reachable with this token. Run \`etherpk-mcp graphs\` to list them.`)
    }
    const keyring = vault.keyrings.find((entry) => entry.graphId === graphId)
    if (!keyring) {
        throw new Error(`This account holds no key for graph ${graphId}. Open the graph in EtherPK (accept its invite if there is one) so the key lands in your vault, then try again.`)
    }
    return { record, keyring }
}
