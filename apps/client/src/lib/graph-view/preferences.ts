/**
 * What each [[Graph View]] copy shows, remembered on this device: whether journal entries are
 * drawn, which Pageless Concepts are, and how many steps out the local copy reaches.
 *
 * A per-viewer convenience, so browser storage is the right home: it never syncs, a private
 * window that refuses storage simply gets the defaults, and nothing is lost if it is cleared.
 */
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

const keyFor = (mode: GraphViewMode) => `etherpk-graph-view:${mode}`
const PAGELESS = new Set<GraphFilter['pageless']>(['all', 'mentioned-twice', 'none'])

function defaultStorage(): Storage | undefined {
    try {
        return globalThis.localStorage
    } catch {
        return undefined
    }
}

export function loadPreferences(mode: GraphViewMode, storage: Storage | undefined = defaultStorage()): GraphViewPreferences {
    const defaults = DEFAULT_PREFERENCES[mode]
    let saved: Record<string, unknown> = {}
    try {
        const raw = storage?.getItem(keyFor(mode))
        const parsed: unknown = raw ? JSON.parse(raw) : {}
        if (parsed && typeof parsed === 'object') saved = parsed as Record<string, unknown>
    } catch {
        // Unreadable or refused: the defaults stand.
    }
    return {
        journals: typeof saved.journals === 'boolean' ? saved.journals : defaults.journals,
        pageless: PAGELESS.has(saved.pageless as GraphFilter['pageless']) ? (saved.pageless as GraphFilter['pageless']) : defaults.pageless,
        depth: saved.depth === 1 || saved.depth === 2 || saved.depth === 3 ? saved.depth : defaults.depth,
    }
}

export function savePreferences(mode: GraphViewMode, preferences: GraphViewPreferences, storage: Storage | undefined = defaultStorage()): void {
    try {
        storage?.setItem(keyFor(mode), JSON.stringify(preferences))
    } catch {
        // Refused (a private window, a full quota): the choice lasts until the View closes.
    }
}
