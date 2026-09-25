/**
 * The graph registry's safety copy (see `safety-copy.ts` for why one exists at all).
 *
 * Only Server records are copied. Their `handle` is a plain `{ rootDocId }`, and everything else
 * a device needs to open the graph again - the Graph Key, the documents - comes from the account
 * vault and the sync server. A Filesystem record is a `FileSystemDirectoryHandle`, which cannot be
 * serialised and cannot be re-minted without the person picking the folder again; losing one is
 * a "choose the folder" repair, not a copy's.
 */
import { normalizeHexColor } from './fs/graph-settings'
import type { GraphRecord, GraphStoragePort, ServerGraphScope } from './graph-registry'
import type { SafetyCopy } from './safety-copy'

/**
 * A Server record reduced to its plain fields, or null for anything else. Validates rather than
 * trusts: the copy sits in `localStorage`, and a malformed entry must read as absent.
 */
export function recoverableGraphRecord(value: unknown): GraphRecord | null {
    if (typeof value !== 'object' || value === null) return null
    const record = value as Partial<GraphRecord>
    if (record.backend !== 'server') return null
    if (typeof record.id !== 'string' || !record.id) return null
    if (typeof record.name !== 'string') return null
    if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) return null
    const handle = record.handle as { rootDocId?: unknown } | null | undefined
    if (typeof handle !== 'object' || handle === null || typeof handle.rootDocId !== 'string') return null
    const scope = record.serverScope as Partial<ServerGraphScope> | undefined
    if (scope !== undefined) {
        if (typeof scope !== 'object' || scope === null) return null
        if (typeof scope.serverOrigin !== 'string' || typeof scope.principalId !== 'string') return null
    }
    if (record.membershipActive !== undefined && typeof record.membershipActive !== 'boolean') return null
    // The cached toolbar colour is a convenience the Graphs menu reads, never load-bearing: a
    // malformed one is dropped, not a reason to lose the record.
    const toolbarColor = typeof record.toolbarColor === 'string' ? normalizeHexColor(record.toolbarColor) : null
    return {
        id: record.id,
        name: record.name,
        backend: 'server',
        createdAt: record.createdAt,
        handle: { rootDocId: handle.rootDocId },
        ...(scope ? { serverScope: { serverOrigin: scope.serverOrigin!, principalId: scope.principalId! } } : {}),
        ...(record.membershipActive === undefined ? {} : { membershipActive: record.membershipActive }),
        ...(toolbarColor ? { toolbarColor } : {}),
    }
}

function sameRecord(left: GraphRecord | null | undefined, right: GraphRecord): boolean {
    return left !== null && left !== undefined && JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Wrap a primary port so every Server record is mirrored into `copy`, and any the primary has
 * lost are put back on the next `getAll()`. `report` receives the records that were restored.
 */
export function withRegistrySafetyCopy(
    primary: GraphStoragePort,
    copy: SafetyCopy<GraphRecord>,
    report: (restored: GraphRecord[]) => void,
): GraphStoragePort {
    const mirror = (record: GraphRecord, existing?: GraphRecord | null) => {
        const plain = recoverableGraphRecord(record)
        if (!plain) {
            copy.remove(record.id)
            return
        }
        if (!sameRecord(existing, plain)) copy.write(record.id, plain)
    }

    return {
        async getAll() {
            const rows = await primary.getAll()
            const copies = copy.readAll()
            const byId = new Map(rows.map((row) => [row.id, row]))

            // The primary is the record: refresh the copy from it, and backfill records that
            // predate the copy. A Filesystem row is never copied, so it only needs a look when a
            // stale copy exists under its id.
            for (const row of rows) {
                if (row.backend !== 'server' && !copies.has(row.id)) continue
                mirror(row, copies.get(row.id))
            }

            // Whatever the copy holds and the primary does not is what the browser lost.
            const restored: GraphRecord[] = []
            for (const [id, record] of copies) {
                if (byId.has(id)) continue
                byId.set(id, record)
                restored.push(record)
                try {
                    await primary.put(record)
                } catch (error) {
                    // The answer is still right; the next read tries the write again.
                    console.warn('[storage] could not write a restored graph record back to IndexedDB', error)
                }
            }
            if (restored.length > 0) report(restored)
            return [...byId.values()]
        },
        async put(record) {
            await primary.put(record)
            mirror(record)
        },
        async delete(id) {
            // Copy first: a delete that fails after the row is gone would otherwise leave a copy
            // to restore a graph the person just forgot.
            copy.remove(id)
            await primary.delete(id)
        },
    }
}
