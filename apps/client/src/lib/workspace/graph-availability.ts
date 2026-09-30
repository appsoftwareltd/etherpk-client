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
 *
 * A device can hold connections to several Sync Servers (ADR 0111). A record names the server its
 * graph lives on, and only that server is asked; a graph with no record here is looked for on each
 * connected server in turn, the selected one first.
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
    /**
     * The server at `scope.serverOrigin` lists the account `scope` names as a member; the device
     * holds no record of the graph for that account.
     */
    | { kind: 'available'; scope: ServerGraphScope; rootDocId: string; role: string; staleRecord: boolean }
    /** A record exists under a different Sync Principal, and the server does not list it for this one. */
    | { kind: 'other-account'; recordPrincipalId: string; activePrincipalId: string }
    /** This account held the graph on this device, and the server no longer lists it. */
    | { kind: 'no-longer-member'; rootDocId: string; name: string }
    /** Neither this device nor any server it is connected to knows this account to be a member. */
    | { kind: 'not-a-member' }
    /** Managed Sync, and this browser is not signed in. */
    | { kind: 'signed-out' }
    /** The Sync Server refused this device's access token. */
    | { kind: 'token-rejected'; serverOrigin: string }
    /** The device holds the graph for a Sync Server it has no connection to. */
    | { kind: 'not-connected'; serverOrigin: string }
    /** The question could not be asked, so no conclusion is offered. */
    | { kind: 'unknown'; reason: 'no-sync-config' | 'server-unreachable' }

/** One Sync Connection the device holds, as the diagnosis asks it. */
export interface DiagnosisConnection {
    managed: boolean
    serverOrigin: string
    /** The account the connection authenticates as; fails as the Sync API does. */
    currentAccount(): Promise<ServerGraphScope>
    /** The authenticated account's memberships; fails as the Sync API does. */
    listServerGraphs(): Promise<ServerGraphRecord[]>
}

export interface MissingGraphDeps {
    /** Every record the device holds, regardless of the visibility filter. */
    allRecords(): Promise<GraphRecord[]>
    /** Every connection the device holds, the selected one first. */
    connections: readonly DiagnosisConnection[]
    /** The Managed Sync server's origin when this deployment offers Managed Sync, else null. */
    managedServerOrigin: string | null
}

export async function diagnoseMissingGraph(
    graphId: string,
    deps: MissingGraphDeps,
): Promise<MissingGraphDiagnosis> {
    const found = (await deps.allRecords()).find((record) => record.id === graphId)
    const local = found?.backend === 'server' ? found : undefined
    const recordOrigin = local?.serverScope?.serverOrigin

    // The record names the graph's server: only that server can say anything about it.
    if (recordOrigin) {
        const connection = deps.connections.find((held) => held.serverOrigin === recordOrigin)
        if (!connection) {
            return recordOrigin === deps.managedServerOrigin
                ? { kind: 'signed-out' }
                : { kind: 'not-connected', serverOrigin: recordOrigin }
        }
        const answer = await ask(connection)
        if (answer.kind !== 'answered') return answer.diagnosis
        return concludeOn(graphId, local, answer)
    }

    if (deps.connections.length === 0) {
        return deps.managedServerOrigin ? { kind: 'signed-out' } : { kind: 'unknown', reason: 'no-sync-config' }
    }

    // No record, or one from before account scopes: whichever connected server lists the graph.
    const refusals: MissingGraphDiagnosis[] = []
    let unreachable = false
    for (const connection of deps.connections) {
        const answer = await ask(connection)
        if (answer.kind !== 'answered') {
            if (answer.kind === 'refused') refusals.push(answer.diagnosis)
            else unreachable = true
            continue
        }
        if (answer.listed.some((graph) => graph.id === graphId)) return concludeOn(graphId, local, answer)
    }
    // Offline, or a server down. "Not a member" would be a claim the evidence does not support,
    // and it is the claim that sends people to Reset.
    if (unreachable) return { kind: 'unknown', reason: 'server-unreachable' }
    // A server that refused this device may be the one holding the graph: signing in is the fix.
    if (refusals[0]) return refusals[0]
    return { kind: 'not-a-member' }
}

type Answer =
    | { kind: 'answered'; account: ServerGraphScope; listed: ServerGraphRecord[] }
    | { kind: 'refused' | 'unreachable'; diagnosis: MissingGraphDiagnosis }

async function ask(connection: DiagnosisConnection): Promise<Answer> {
    try {
        const account = await connection.currentAccount()
        const listed = await connection.listServerGraphs()
        return { kind: 'answered', account, listed }
    } catch (error) {
        if (refusedCredential(error)) {
            return {
                kind: 'refused',
                diagnosis: connection.managed
                    ? { kind: 'signed-out' }
                    : { kind: 'token-rejected', serverOrigin: connection.serverOrigin },
            }
        }
        return { kind: 'unreachable', diagnosis: { kind: 'unknown', reason: 'server-unreachable' } }
    }
}

/** What one server's answer says about `graphId` and the record this device holds, if any. */
function concludeOn(
    graphId: string,
    local: GraphRecord | undefined,
    { account, listed }: { account: ServerGraphScope; listed: ServerGraphRecord[] },
): MissingGraphDiagnosis {
    const membership = listed.find((graph) => graph.id === graphId)
    // A record with no scope predates account partitioning; the membership list adopts it.
    const heldForThisAccount = local !== undefined
        && (local.serverScope === undefined || sameScope(local.serverScope, account))
    if (membership) {
        if (heldForThisAccount) return { kind: 'ready', scope: account, memberships: listed.map((graph) => graph.id) }
        return { kind: 'available', scope: account, rootDocId: membership.rootDocId, role: membership.role, staleRecord: local !== undefined }
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
