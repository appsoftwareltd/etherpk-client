/**
 * Why a Server Backend graph did not resolve from this device's registry, so the workspace
 * can say which case it is and offer the repair that fits.
 *
 * `getGraph()` returns `undefined` for three different situations: no record at all, a
 * record stamped with a different account scope, and a record the server last said this
 * Principal is no longer a member of. Until 2026-09-01 the workspace collapsed all three into
 * "That graph is not in this browser", which was only true of the first, while the fix for
 * the common case (the server still lists you as a member) was one registry write away.
 */
import type { GraphRecord, ServerGraphScope } from '$lib/storage'
import type { ServerGraphRecord } from '$lib/sync/sync-api'

export type MissingGraphDiagnosis =
    /** The server lists this account as a member; the device just has no usable record. */
    | { kind: 'available'; rootDocId: string; role: string; staleRecord: boolean }
    /** A record exists under a different Sync Principal, and the server does not list it for this one. */
    | { kind: 'other-account'; recordPrincipalId: string; activePrincipalId: string | null }
    /** Neither this device nor the server knows this account to be a member. */
    | { kind: 'not-a-member' }
    /** The question could not be asked, so no conclusion is offered. */
    | { kind: 'unknown'; reason: 'no-sync-config' | 'server-unreachable' }

export interface MissingGraphDeps {
    /** Every record the device holds, regardless of the visibility filter. */
    allRecords(): Promise<GraphRecord[]>
    activeScope(): ServerGraphScope | null
    /** The authenticated server's membership list, or null when this device has no sync config. */
    listServerGraphs: (() => Promise<ServerGraphRecord[]>) | null
}

export async function diagnoseMissingGraph(
    graphId: string,
    deps: MissingGraphDeps,
): Promise<MissingGraphDiagnosis> {
    const local = (await deps.allRecords()).find((record) => record.id === graphId)
    if (!deps.listServerGraphs) return { kind: 'unknown', reason: 'no-sync-config' }

    let listed: ServerGraphRecord[]
    try {
        listed = await deps.listServerGraphs()
    } catch {
        // Offline, or the server is down. "Not a member" would be a claim the evidence does
        // not support, and it is the claim that sends people to Reset.
        return { kind: 'unknown', reason: 'server-unreachable' }
    }

    const membership = listed.find((graph) => graph.id === graphId)
    if (membership) {
        return {
            kind: 'available',
            rootDocId: membership.rootDocId,
            role: membership.role,
            staleRecord: local !== undefined,
        }
    }
    if (local?.serverScope) {
        return {
            kind: 'other-account',
            recordPrincipalId: local.serverScope.principalId,
            activePrincipalId: deps.activeScope()?.principalId ?? null,
        }
    }
    return { kind: 'not-a-member' }
}
