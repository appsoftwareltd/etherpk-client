/**
 * The pure decision behind the root (`/`) resolver. Given the known graphs and
 * the device-local last-opened pointer, decide where to send the user:
 *
 *  - no graphs            → the public home page (nothing to resume)
 *  - exactly one graph    → open it (the pointer is irrelevant)
 *  - several graphs        → open the pointed-at graph if it still exists,
 *                            otherwise the picker (never guess one for them)
 *
 * Kept pure (no IndexedDB, no `localStorage`, no navigation) so the branching is
 * unit-testable; the route does the I/O and the `goto`.
 */

import type { GraphRecord } from './graph-registry'

export type GraphTarget = { kind: 'open'; id: string } | { kind: 'picker' } | { kind: 'home' }

export function resolveGraphTarget(
    graphs: readonly GraphRecord[],
    lastGraphId: string | null,
): GraphTarget {
    if (graphs.length === 0) return { kind: 'home' }
    if (graphs.length === 1) return { kind: 'open', id: graphs[0].id }
    if (lastGraphId && graphs.some((g) => g.id === lastGraphId)) {
        return { kind: 'open', id: lastGraphId }
    }
    return { kind: 'picker' }
}
