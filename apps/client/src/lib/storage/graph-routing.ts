/**
 * The pure decision behind the root (`/`) resolver. Given the known graphs and
 * the device-local last-opened pointer, decide where to send the user:
 *
 *  - no graphs            → the public home page (nothing to resume), or the
 *                            Graphs page for an installed-app launch
 *  - exactly one graph    → open it (the pointer is irrelevant)
 *  - several graphs        → open the pointed-at graph if it still exists,
 *                            otherwise the picker (never guess one for them)
 *
 * Kept pure (no IndexedDB, no `localStorage`, no navigation) so the branching is
 * unit-testable; the route does the I/O and the `goto`.
 */

import { documentUrl, graphUrl } from '../navigation/document-url'
import {
    INSTALLED_LAUNCH_PARAM,
    SHORTCUT_PARAM,
    WORKSPACE_LAUNCH_PARAM,
    isInstalledLaunch,
    launchShortcutFrom,
    withoutParams,
} from '../navigation/launch-shortcuts'

import type { GraphRecord } from './graph-registry'

export type GraphTarget = { kind: 'open'; id: string } | { kind: 'picker' } | { kind: 'home' }

/**
 * The address the root resolver sends the person on to, from the target `resolveGraphTarget`
 * chose and the query string `/` was opened with.
 *
 * - The installed-launch marker and the shortcut name are for this decision and the request log
 *   only, so neither is carried on. Every other parameter is (dev's `?fs=opfs`).
 * - An installed launch never lands on the public home: with no graphs it opens the Graphs page,
 *   whose first-run card is where a new graph starts.
 * - A shortcut opens in the graph `/` would have resumed: `today` as today's [[Journal Entry]],
 *   with today read now (a launch can come days after the last), and `search` and `quick-note`
 *   as an action the workspace runs once open. With no graph to resume it opens the Graphs page.
 */
export function rootDestination(target: GraphTarget, search: string, today: () => string): string {
    const shortcut = launchShortcutFrom(search)
    const rest = withoutParams(search, [INSTALLED_LAUNCH_PARAM, SHORTCUT_PARAM])
    if (target.kind === 'open') {
        if (shortcut === 'today') return `${documentUrl(target.id, today())}${rest}`
        if (shortcut) {
            const params = new URLSearchParams(rest)
            params.set(WORKSPACE_LAUNCH_PARAM, shortcut)
            return `${graphUrl(target.id)}?${params}`
        }
        return `${graphUrl(target.id)}${rest}`
    }
    if (target.kind === 'home' && !shortcut && !isInstalledLaunch(search)) return `/home${rest}`
    return '/graphs'
}

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
