/**
 * The list of knowledge graphs the client knows about. Each record pairs a graph's
 * metadata with the opaque directory `handle` that reaches its files. The backend
 * is fixed at creation (ADR 0007); only `filesystem` exists today.
 *
 * Pure over a key-value {@link GraphStoragePort} so the logic is testable without
 * IndexedDB; the real port (graph-registry-idb.ts) persists the records — including
 * the structured-cloneable `FileSystemDirectoryHandle` — across sessions.
 */

export type GraphBackend = 'filesystem' | 'server'

export interface ServerGraphScope {
    serverOrigin: string
    principalId: string
}

export interface GraphRecord {
    id: string
    name: string
    backend: GraphBackend
    /** Epoch-ms creation time. */
    createdAt: number
    /** The directory handle (a `FileSystemDirectoryHandle`); opaque to this layer. */
    handle: unknown
    /** Required for Server records. Prevents cached names leaking across account switches. */
    serverScope?: ServerGraphScope
    /** Last successful membership check. False hides a graph without deleting its local cache. */
    membershipActive?: boolean
    /**
     * A CACHE of the graph's toolbar colour (Graph Settings, ADR 0071), lowercase `#rrggbb`, the
     * same way `name` caches a synced graph's name: the colour lives inside the graph - its
     * folder's `etherpk/settings.json`, or the encrypted root doc - so only an open graph can
     * read it, and the header's Graphs menu lists graphs that are not open. Refreshed whenever
     * the workspace learns the colour (open, save, a peer's change) through
     * {@link withCachedToolbarColor}; absent until the graph has been opened on this device
     * since it was coloured, or when it has no colour.
     */
    toolbarColor?: string
}

/**
 * `record` with its cached toolbar colour brought up to `color`, or null when the cache already
 * says that (so a caller can skip the write). Clearing removes the key rather than storing
 * `undefined`, so the record on disk never carries a key that means nothing. Never mutates.
 */
export function withCachedToolbarColor(record: GraphRecord, color: string | undefined): GraphRecord | null {
    if (record.toolbarColor === color) return null
    if (color === undefined) {
        const { toolbarColor: _dropped, ...rest } = record
        return rest
    }
    return { ...record, toolbarColor: color }
}

/** The persistence seam: a tiny keyed store of {@link GraphRecord}s. */
export interface GraphStoragePort {
    getAll(): Promise<GraphRecord[]>
    put(record: GraphRecord): Promise<void>
    delete(id: string): Promise<void>
}

/** Mint a new graph id via the injected generator (production: `crypto.randomUUID`). */
export function newGraphId(newId: () => string): string {
    return newId()
}

export interface GraphRegistry {
    listGraphs(): Promise<GraphRecord[]>
    getGraph(id: string): Promise<GraphRecord | undefined>
    /** Insert or replace (idempotent on `id`). */
    insertGraph(record: GraphRecord): Promise<void>
    /**
     * Update visibility from one successful Server membership list, and re-adopt records this
     * device holds for the same graphs under an older or missing account scope.
     */
    reconcileServerMemberships(scope: ServerGraphScope, graphIds: readonly string[]): Promise<void>
    removeGraph(id: string): Promise<void>
}

export interface GraphRegistryOptions {
    activeServerScope: () => ServerGraphScope | null
}

const noActiveServer: GraphRegistryOptions = { activeServerScope: () => null }

export function createGraphRegistry(
    port: GraphStoragePort,
    options: GraphRegistryOptions = noActiveServer,
): GraphRegistry {
    const visible = (record: GraphRecord): boolean => {
        if (record.backend === 'filesystem') return true
        const active = options.activeServerScope()
        return active !== null
            && sameScope(record.serverScope, active)
            && record.membershipActive !== false
    }

    return {
        async listGraphs() {
            const all = await port.getAll()
            return all.filter(visible).sort((a, b) => a.createdAt - b.createdAt)
        },
        async getGraph(id) {
            return (await port.getAll()).find((graph) => graph.id === id && visible(graph))
        },
        async insertGraph(record) {
            if (record.backend === 'server' && !record.serverScope) {
                throw new Error('Server graph records require an authenticated account scope')
            }
            await port.put(record) // keyed on id → idempotent replace
        },
        async reconcileServerMemberships(scope, graphIds) {
            const memberships = new Set(graphIds)
            for (const record of await port.getAll()) {
                if (record.backend !== 'server') continue
                if (!record.serverScope) {
                    // An unscoped record predates account partitioning. Adopt it only when
                    // the authenticated Server confirms this Principal is still a member.
                    if (memberships.has(record.id)) {
                        await port.put({ ...record, serverScope: scope, membershipActive: true })
                    }
                    continue
                }
                if (sameScope(record.serverScope, scope)) {
                    await port.put({ ...record, membershipActive: memberships.has(record.id) })
                    continue
                }
                // Same Server, different Principal: the browser signed in as another account on
                // this Server after the record was written (a second registration, say). The
                // record was previously skipped by both branches above, so the graph stayed
                // hidden on every load with nothing able to repair it (2026-09-01). The Server
                // has just confirmed the CURRENT Principal is a member of that graph id, which is
                // the same evidence the legacy branch accepts, so move the record over. A record
                // from a different Server origin is never touched: that is a real partition.
                if (record.serverScope.serverOrigin === scope.serverOrigin && memberships.has(record.id)) {
                    await port.put({ ...record, serverScope: scope, membershipActive: true })
                }
            }
        },
        async removeGraph(id) {
            await port.delete(id)
        },
    }
}

function sameScope(left: ServerGraphScope | undefined, right: ServerGraphScope): boolean {
    return left?.serverOrigin === right.serverOrigin && left.principalId === right.principalId
}
