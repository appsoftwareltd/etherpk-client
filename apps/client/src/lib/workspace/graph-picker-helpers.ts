/** Framework-free application helpers for the graph picker route. */
import { fromBase64Url, type GraphKeyring } from '$lib/crypto'
import type { GraphRecord } from '$lib/storage'
import { openGraphName } from '$lib/sync/graph-name-envelope'
import type {
    GraphStorageFigures,
    OwnedStorageTotals,
    SyncApi,
} from '$lib/sync/sync-api'

export interface SyncedMember {
    userId: string
    email: string
    role: string
}

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
    /** Active members are owner-only; null also represents an unavailable member list. */
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
