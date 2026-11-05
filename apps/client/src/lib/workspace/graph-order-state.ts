/**
 * This device's Graph Order store (storage/graph-order.ts) wired to the person's settings, to the
 * connections it holds and to the page: a reactive read for the Graphs page, and the groups every
 * list of graphs shows.
 */
import { createSubscriber } from 'svelte/reactivity'

import { isDemoGraph } from '#lib/demo/demo-graph.js'
import { personSettings } from '#lib/person-settings/person-settings.js'
import { createGraphOrderStore, groupGraphs, type GraphGroup, type GraphOrderStore, type GraphRecord } from '#lib/storage/index.js'
import { listSyncConnections } from '#lib/sync/sync-connection.js'

let shared: GraphOrderStore | null = null

function orders(): GraphOrderStore {
    if (shared) return shared
    const store = createGraphOrderStore(() => (typeof localStorage === 'undefined' ? null : localStorage), personSettings())
    shared = store
    if (typeof window !== 'undefined') {
        window.addEventListener('storage', (event) => {
            // `storageArea` is null for a clear in some browsers; only localStorage is ours.
            if (event.storageArea === null || event.storageArea === localStorage) store.storageChanged(event.key)
        })
    }
    return store
}

const subscribe = createSubscriber((update) => orders().subscribe(update))

/**
 * The saved order of the group on `origin`, or of Local Graphs when it is null. Read inside a
 * template or a derived, it updates when the order changes here, in another tab or from the account.
 */
export function graphOrderOf(origin: string | null): string[] {
    subscribe()
    return orders().read(origin)
}

/** Save `shown` as the sequence of the group on `origin`, or of Local Graphs when it is null. */
export function saveGraphOrder(origin: string | null, shown: readonly string[]): void {
    orders().write(origin, shown)
}

/** The servers this device holds in the sequence their groups show: Managed Sync, then as added. */
function serverSequence(): string[] {
    const connections = listSyncConnections()
    return [...connections.filter((connection) => connection.kind === 'managed'), ...connections.filter((connection) => connection.kind !== 'managed')].map(
        (connection) => connection.origin,
    )
}

/** `graphs` in the groups and the order every list of graphs shows them in. */
export function graphGroups(graphs: readonly GraphRecord[]): GraphGroup[] {
    return groupGraphs(graphs, { origins: serverSequence(), isDemo: isDemoGraph, orderOf: (origin) => orders().read(origin) })
}
