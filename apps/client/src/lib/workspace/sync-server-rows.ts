/**
 * One Sync Server's graphs as the Graphs page lists them: the rows of its group on the Graphs tab
 * (`SyncServerGroup.svelte`) and the graphs its Agents tab offers, from one place so the two agree.
 */
import { applyGraphOrder, type GraphRecord } from '#lib/storage/index.js'
import { graphOrderOf } from './graph-order-state'
import type { SyncedGraphView } from './graph-picker-helpers'
import type { SyncServerView } from './sync-server-view.svelte'

/** A graph on a server: the server's membership, this device's copy, or both. */
export interface SyncedGraphRowEntry {
    id: string
    /** The server's membership; null while its list is not to hand. */
    view: SyncedGraphView | null
    /** This device's copy; null for a graph not added here. */
    record: GraphRecord | null
}

/**
 * Signed in, with Encryption Keys on the server that are not unlocked on this device: every
 * graph's name is hidden and nothing about a graph works until they are unlocked.
 */
export function serverKeysLocked(server: Pick<SyncServerView, 'authState' | 'vaultExists' | 'vaultUnlocked'>): boolean {
    return server.authState === 'authenticated' && server.vaultExists === true && !server.vaultUnlocked
}

/**
 * One row per graph. While the server's list is to hand the rows are its memberships, each
 * joined to this device's copy; while it is not (offline, or the list failed) they are the
 * copies this device holds for this server. None before the first account check answers, which
 * may yet say the account changed, and none while signed out, when the copies are hidden.
 * In the group's Graph Order, wherever each came from. Read inside a template or a derived, it
 * follows the server and the saved order.
 */
export function syncedGroupRows(
    server: Pick<SyncServerView, 'origin' | 'authState' | 'checked' | 'listed' | 'graphs'>,
    records: readonly GraphRecord[],
): SyncedGraphRowEntry[] {
    if (server.authState === 'signed-out' || (!server.checked && !server.listed)) return []
    const unordered: SyncedGraphRowEntry[] = server.listed
        ? server.graphs.map((view) => ({ id: view.id, view, record: records.find((record) => record.id === view.id) ?? null }))
        : records.map((record) => ({ id: record.id, view: null, record }))
    return applyGraphOrder(unordered, graphOrderOf(server.origin), (row) => row.id)
}
