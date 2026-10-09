/**
 * What each [[Graph View]] copy shows, remembered on this device: whether journal entries are
 * drawn, which Pageless Concepts are, and how many steps out the local copy reaches.
 *
 * A per-viewer convenience, so the extension's own storage is the right home (ADR 0121): it never
 * syncs, a private window that refuses storage simply gets the defaults, and nothing is lost if it
 * is cleared. Kept under `local` and `whole`, which the Client stores as `etherpk-graph-view:local`
 * and `etherpk-graph-view:whole`, the keys these preferences have always had.
 */
import type { ExtensionStorage } from '@appsoftwareltd/etherpk-extension-api'

import type { GraphViewMode } from './identity'
import type { GraphFilter } from './model/graph-model'

export interface GraphViewPreferences extends GraphFilter {
    /** How many lines out from the active document the local copy reaches. */
    depth: 1 | 2 | 3
}

export const DEFAULT_PREFERENCES: Record<GraphViewMode, GraphViewPreferences> = {
    // The neighbourhood of one document is small enough to show everything in it.
    local: { journals: true, pageless: 'all', depth: 1 },
    // Most Pageless Concepts in a real graph are mentioned once; drawn, they bury the rest.
    whole: { journals: true, pageless: 'mentioned-twice', depth: 1 },
}

const PAGELESS = new Set<GraphFilter['pageless']>(['all', 'mentioned-twice', 'none'])

export function loadPreferences(mode: GraphViewMode, storage: ExtensionStorage | undefined): GraphViewPreferences {
    const defaults = DEFAULT_PREFERENCES[mode]
    const read = storage?.get<unknown>(mode)
    const saved = read && typeof read === 'object' ? (read as Record<string, unknown>) : {}
    return {
        journals: typeof saved.journals === 'boolean' ? saved.journals : defaults.journals,
        pageless: PAGELESS.has(saved.pageless as GraphFilter['pageless']) ? (saved.pageless as GraphFilter['pageless']) : defaults.pageless,
        depth: saved.depth === 1 || saved.depth === 2 || saved.depth === 3 ? saved.depth : defaults.depth,
    }
}

export function savePreferences(mode: GraphViewMode, preferences: GraphViewPreferences, storage: ExtensionStorage | undefined): void {
    // A refusal (a private window, a full quota) is the Client's to absorb: the choice then lasts
    // until the View closes.
    storage?.set(mode, preferences)
}
