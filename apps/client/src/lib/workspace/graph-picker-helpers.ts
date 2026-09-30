/** Framework-free application helpers for the graph picker route. */
import type { SyncAccountSummary, SyncPlanNotice } from '@appsoftwareltd/etherpk-shared'
import { fromBase64Url, type GraphKeyring } from '$lib/crypto'
import type { GraphRecord } from '$lib/storage'
import { openGraphName } from '$lib/sync/graph-name-envelope'
import type {
    GraphMember,
    GraphStorageFigures,
    OwnedStorageTotals,
    SyncApi,
} from '$lib/sync/sync-api'

/** A member of an owned graph, or somebody invited to it (`status: 'invited'`). */
export type SyncedMember = GraphMember

export interface SyncedGraphView {
    id: string
    rootDocId: string
    name: string
    /**
     * Where `name` came from: this device's registry record; the server's name envelope read
     * with the vault keyring (ADR 0031, amended 2026-09-17); the graph's own root document,
     * read once because no envelope existed; or the id placeholder when none of those could
     * label it.
     */
    nameSource: 'device' | 'envelope' | 'document' | 'placeholder'
    /** Whether the server holds a name envelope for this graph, readable here or not. */
    hasNameEnvelope: boolean
    /** False when the server membership has not been registered on this device. */
    onDevice: boolean
    role: string
    /** Members and invitees, for the owner only; null also represents an unavailable member list. */
    members: SyncedMember[] | null
    /** Absent when an older sync service does not report storage figures. */
    storage?: GraphStorageFigures
}

type SyncedOverviewApi = Pick<SyncApi, 'graphsOverview' | 'graphMembers'>

export interface LoadSyncedGraphViewsOptions {
    /**
     * The vault's keyrings, when it is unlocked here: a graph not on this device is then
     * labelled from the server's name envelope instead of the id placeholder.
     */
    keyrings?: readonly GraphKeyring[]
}

/**
 * Cross-reference blind server memberships with this device's encrypted-name cache, and with
 * the server's name envelope where the keyring to read it is held. One failed
 * owner-only member lookup must not hide an otherwise listable graph.
 */
export async function loadSyncedGraphViews(
    api: SyncedOverviewApi,
    localGraphs: readonly GraphRecord[],
    options: LoadSyncedGraphViewsOptions = {},
): Promise<{ graphs: SyncedGraphView[]; ownedStorage: OwnedStorageTotals | null }> {
    const { graphs: serverGraphs, ownedStorage } = await api.graphsOverview()
    const localById = new Map(localGraphs.map((graph) => [graph.id, graph]))
    const keyringById = new Map((options.keyrings ?? []).map((keyring) => [keyring.graphId, keyring]))
    const graphs = await Promise.all(
        serverGraphs.map(async (graph): Promise<SyncedGraphView> => {
            const local = localById.get(graph.id)
            const hasNameEnvelope = typeof graph.nameEnvelope === 'string' && graph.nameEnvelope !== ''
            // The device record wins for a graph on this device: it is refreshed on every open,
            // and the on-device list above the panel shows the same record.
            const keyring = keyringById.get(graph.id)
            const envelopeName =
                !local && hasNameEnvelope && keyring ? await openGraphName(keyring, graph.id, fromBase64Url(graph.nameEnvelope!)) : null
            let members: SyncedMember[] | null = null
            if (graph.role === 'owner') {
                try {
                    members = await api.graphMembers(graph.id)
                } catch {
                    // Membership visibility is supplementary to the graph list.
                    members = null
                }
            }
            return {
                id: graph.id,
                rootDocId: graph.rootDocId,
                name: local?.name ?? envelopeName ?? `Graph ${graph.id.slice(0, 8)}…`,
                nameSource: local ? 'device' : envelopeName ? 'envelope' : 'placeholder',
                hasNameEnvelope,
                onDevice: local !== undefined,
                role: graph.role,
                members,
                storage: graph.storage,
            }
        }),
    )
    return { graphs, ownedStorage: ownedStorage ?? null }
}

/**
 * The rows an unlocked device should read a name for from the graph itself, in list order: not
 * on this device, still labelled by the placeholder, and a key held for them. Each read
 * publishes the name envelope, so a graph appears here at most once across all devices.
 */
export function unlabelledGraphsToRead(
    views: readonly SyncedGraphView[],
    keyrings: readonly GraphKeyring[],
): Array<{ view: SyncedGraphView; keyring: GraphKeyring }> {
    const keyringById = new Map(keyrings.map((keyring) => [keyring.graphId, keyring]))
    const picked: Array<{ view: SyncedGraphView; keyring: GraphKeyring }> = []
    for (const view of views) {
        if (view.onDevice || view.nameSource !== 'placeholder') continue
        const keyring = keyringById.get(view.id)
        if (keyring) picked.push({ view, keyring })
    }
    return picked
}

/**
 * Produce an IndexedDB-safe record after a rename. Svelte deep-proxies the plain server handle,
 * so rebuild it. A browser-owned filesystem handle is an opaque class instance and must retain
 * its original identity.
 */
export function persistableGraphRecord(record: GraphRecord, name: string): GraphRecord {
    const handle =
        record.backend === 'server'
            ? { rootDocId: (record.handle as { rootDocId: string }).rootDocId }
            : record.handle
    return {
        id: record.id,
        name,
        backend: record.backend,
        createdAt: record.createdAt,
        handle,
        ...(record.serverScope ? { serverScope: record.serverScope } : {}),
        ...(record.membershipActive === undefined ? {} : { membershipActive: record.membershipActive }),
    }
}

/** Where the account check on one Sync Server stands. */
export type ServerAuthState = 'checking' | 'authenticated' | 'signed-out' | 'unavailable'

/** What one server's account and plan allow a new synced graph, as the Knowledge graphs page gates it. */
export interface ServerPlanGate {
    /**
     * A managed account on Free: its Entitlement allows no owned graphs (ADR 0068), so creating or
     * importing a synced graph there would only be refused after the keys ritual.
     */
    syncPlusRequired: boolean
    /** Why a new synced graph cannot go on this server now, or null when it can. */
    createBlockedReason: string | null
}

/**
 * The gate on a new synced graph for one server (ADR 0111: each server's account and plan are its
 * own). A plan still being confirmed, or one that cannot be, has zero limits like Free but is not
 * Free, so it gets its own reason and never the Sync+ offer. The reasons name no trial: Checkout
 * gives one only to an account that never subscribed. A check still in flight blocks nothing:
 * callers wait for it before they decide.
 */
export function serverPlanGate(state: {
    authState: ServerAuthState
    kind: 'managed' | 'custom'
    host: string
    account: SyncAccountSummary | null
    planNotice: SyncPlanNotice
    shownPlanNotice: SyncPlanNotice
}): ServerPlanGate {
    const unsettled = state.planNotice === 'pending' || state.planNotice === 'unconfirmed'
    const syncPlusRequired =
        state.authState === 'authenticated' &&
        state.account?.authentication.mode === 'managed' &&
        !unsettled &&
        state.account.entitlement.limits.ownedGraphs === 0
    const reason = (): string | null => {
        if (state.authState === 'signed-out') {
            return state.kind === 'managed'
                ? `You are signed out of ${state.host}. Sign in to create a synced graph there.`
                : `${state.host} did not accept this device's access token. Add a new one to create a synced graph there.`
        }
        if (state.authState === 'unavailable') return `${state.host} could not be reached. Try again when it answers.`
        if (syncPlusRequired) {
            return state.planNotice === 'ended'
                ? 'Synced graphs need Sync+. Restart it from Billing to create one.'
                : 'Synced graphs need Sync+. Start it from Billing to create one.'
        }
        if (state.shownPlanNotice === 'pending') {
            return 'EtherPK is still confirming your plan, so a synced graph can be created in a moment.'
        }
        if (unsettled) {
            return 'Your plan cannot be confirmed right now, so no synced graph can be created. This page keeps checking.'
        }
        return null
    }
    return { syncPlusRequired, createBlockedReason: reason() }
}

/**
 * Whether the Graphs tab shows a server's group. A browser that already has graphs sees every
 * server it holds, empty or not. On a first visit the first-run card offers the way in (signing in,
 * a first graph), so a group appears only when it has something the card cannot say: rows, an
 * invite, a list that failed, a server not answering, a custom server refusing its token, or a plan
 * standing in the way.
 */
export function serverGroupVisible(group: {
    firstRun: boolean
    rows: number
    invites: number
    failed: boolean
    authState: ServerAuthState
    kind: 'managed' | 'custom'
    planLine: boolean
}): boolean {
    if (!group.firstRun) return true
    return (
        group.rows > 0 ||
        group.invites > 0 ||
        group.failed ||
        group.planLine ||
        group.authState === 'unavailable' ||
        (group.authState === 'signed-out' && group.kind === 'custom')
    )
}

/**
 * The held server a synced copy in this browser belongs to: the origin its account scope names,
 * when this device still holds a connection there. Null for a server the device has forgotten, and
 * for a copy that names none; those are removed from the Sync tab's This browser section.
 */
export function copyServer(record: GraphRecord, heldOrigins: readonly string[]): string | null {
    const origin = record.serverScope?.serverOrigin
    return origin && heldOrigins.includes(origin) ? origin : null
}

/** How many synced copies this browser holds per held server, and how many belong to none. */
export function countCopiesByServer(
    records: readonly GraphRecord[],
    heldOrigins: readonly string[],
): { perServer: Record<string, number>; unheld: number } {
    const perServer: Record<string, number> = {}
    let unheld = 0
    for (const record of records) {
        if (record.backend !== 'server') continue
        const origin = copyServer(record, heldOrigins)
        if (origin) perServer[origin] = (perServer[origin] ?? 0) + 1
        else unheld += 1
    }
    return { perServer, unheld }
}
