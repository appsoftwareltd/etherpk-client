/**
 * Why a Server Backend graph did not resolve from this device's registry, so the workspace
 * can say which case it is and offer the repair that fits.
 *
 * `getGraph()` returns `undefined` whenever the registry hides a record: no record at all, a
 * record stamped with a different account scope, a record the server last said this Principal
 * is no longer a member of, or any record at all while this browser has not yet confirmed which
 * account it is signed in as. Only the first is "not in this browser", and each needs a
 * different answer. The account is confirmed here before anything is concluded, so a record
 * hidden only because that check had not landed yet is reported as `ready`, not as someone
 * else's.
 */
import { ManagedTokenError } from '$lib/auth/managed-token'
import type { GraphRecord, ServerGraphScope } from '$lib/storage'
import { sameScope } from '$lib/storage/graph-registry'
import { SyncApiError, type ServerGraphRecord } from '$lib/sync/sync-api'

export type MissingGraphDiagnosis =
    /**
     * The device holds the graph for the account now confirmed and the server lists it: the
     * record was hidden only until the account was confirmed, or by an old membership answer.
     * Recording `memberships` under `scope` makes it visible again.
     */
    | { kind: 'ready'; scope: ServerGraphScope; memberships: string[] }
    /** The server lists this account as a member; the device holds no record of it for this account. */
    | { kind: 'available'; rootDocId: string; role: string; staleRecord: boolean }
    /** A record exists under a different Sync Principal, and the server does not list it for this one. */
    | { kind: 'other-account'; recordPrincipalId: string; activePrincipalId: string }
    /** This account held the graph on this device, and the server no longer lists it. */
    | { kind: 'no-longer-member'; rootDocId: string; name: string }
    /** Neither this device nor the server knows this account to be a member. */
    | { kind: 'not-a-member' }
    /** Managed Sync, and this browser is not signed in. */
    | { kind: 'signed-out' }
    /** The Sync Server refused this device's access token. */
    | { kind: 'token-rejected'; serverOrigin: string }
    /** The device holds the graph for a Sync Server it has no connection to. */
    | { kind: 'not-connected'; serverOrigin: string }
    /** The question could not be asked, so no conclusion is offered. */
    | { kind: 'unknown'; reason: 'no-sync-config' | 'server-unreachable' }

export interface MissingGraphDeps {
    /** Every record the device holds, regardless of the visibility filter. */
    allRecords(): Promise<GraphRecord[]>
    /** How this device reaches a Sync Server, or null when it has no connection. */
    connection: { managed: boolean; serverOrigin: string } | null
    /** The Managed Sync server's origin when this deployment offers Managed Sync, else null. */
    managedServerOrigin: string | null
    /** The account the connection authenticates as; fails as the Sync API does. */
    currentAccount(): Promise<ServerGraphScope>
    /** The authenticated account's memberships; fails as the Sync API does. */
    listServerGraphs(): Promise<ServerGraphRecord[]>
}

export async function diagnoseMissingGraph(
    graphId: string,
    deps: MissingGraphDeps,
): Promise<MissingGraphDiagnosis> {
    const found = (await deps.allRecords()).find((record) => record.id === graphId)
    const local = found?.backend === 'server' ? found : undefined

    if (!deps.connection) {
        const origin = local?.serverScope?.serverOrigin
        if (origin && origin !== deps.managedServerOrigin) return { kind: 'not-connected', serverOrigin: origin }
        if (deps.managedServerOrigin) return { kind: 'signed-out' }
        return { kind: 'unknown', reason: 'no-sync-config' }
    }

    let account: ServerGraphScope
    let listed: ServerGraphRecord[]
    try {
        account = await deps.currentAccount()
        listed = await deps.listServerGraphs()
    } catch (error) {
        if (refusedCredential(error)) {
            return deps.connection.managed
                ? { kind: 'signed-out' }
                : { kind: 'token-rejected', serverOrigin: deps.connection.serverOrigin }
        }
        // Offline, or the server is down. "Not a member" would be a claim the evidence does
        // not support, and it is the claim that sends people to Reset.
        return { kind: 'unknown', reason: 'server-unreachable' }
    }

    const membership = listed.find((graph) => graph.id === graphId)
    // A record with no scope predates account partitioning; the membership list adopts it.
    const heldForThisAccount = local !== undefined
        && (local.serverScope === undefined || sameScope(local.serverScope, account))
    if (membership) {
        if (heldForThisAccount) return { kind: 'ready', scope: account, memberships: listed.map((graph) => graph.id) }
        return { kind: 'available', rootDocId: membership.rootDocId, role: membership.role, staleRecord: local !== undefined }
    }
    if (local?.serverScope && !heldForThisAccount) {
        return {
            kind: 'other-account',
            recordPrincipalId: local.serverScope.principalId,
            activePrincipalId: account.principalId,
        }
    }
    if (local) {
        return { kind: 'no-longer-member', rootDocId: (local.handle as { rootDocId: string }).rootDocId, name: local.name }
    }
    return { kind: 'not-a-member' }
}

/** The Client session or the Sync Server refused the credential, rather than failing to answer. */
function refusedCredential(error: unknown): boolean {
    return (error instanceof ManagedTokenError || error instanceof SyncApiError) && error.status === 401
}
