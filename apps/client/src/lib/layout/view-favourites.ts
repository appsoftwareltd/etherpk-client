/**
 * Views as [[Favourite]]s (ADR 0169): which Views can be one, and how a View favourite's row in the
 * Graph Sidebar reads and what it opens.
 *
 * A View kind says it can be a favourite in its registration (`favourite`), which the workspace
 * copies from an extension's manifest, so nothing here names an extension. Its entry is then
 * `{ kind, concept }` for a kind with one View per concept (`conceptTarget`) and `{ kind }` for a
 * kind whose one View has a fixed target (`soleTarget`).
 *
 * Whether the extension behind a kind is on, off or gone comes from the workspace's extension host
 * through `availability`, so this stays plain TypeScript, tested in Node.
 */
import type { ViewFavourite } from '#lib/document/favourite-entry.js'

import type { ViewRef, ViewRegistry, ViewRegistryEntry } from './types'

/** Where the extension behind a View kind stands on this device. `name` is its display name. */
export type ViewFavouriteAvailability = { state: 'on' } | { state: 'off'; name: string } | { state: 'missing' }

/** A View favourite's Sidebar row. */
export interface ViewFavouriteRow {
    /** The View's tab title, or the stored kind and concept when the kind is not known here. */
    title: string
    /** The kind's icon, as its tab draws it. */
    icon?: string
    /** The View the row opens, or null when nothing on this device can open it. */
    view: ViewRef | null
    /** Shown under the title when the View cannot be shown as it is: its extension off or gone. */
    note?: string
}

export interface ViewFavourites {
    /** The favourite `view` is, or null when its kind cannot be one. */
    favouriteOf(view: ViewRef): ViewFavourite | null
    describe(favourite: ViewFavourite): ViewFavouriteRow
    /** Hear a change in what {@link describe} answers: an extension switched on or off, added or removed. */
    subscribe(listener: () => void): () => void
}

export interface ViewFavouritesDeps {
    registry: ViewRegistry
    availability(kind: string): ViewFavouriteAvailability
    subscribe?(listener: () => void): () => void
}

const NOT_INSTALLED = 'Its extension is not installed on this device'

/** The View a favourite names in a kind's registration, or null when the entry does not fit the kind. */
function viewOf(entry: ViewRegistryEntry | undefined, favourite: ViewFavourite): ViewRef | null {
    if (!entry?.favourite) return null
    if (entry.conceptTarget) return favourite.concept === undefined ? null : { kind: favourite.kind, target: favourite.concept }
    return entry.soleTarget !== undefined && favourite.concept === undefined ? { kind: favourite.kind, target: entry.soleTarget } : null
}

/** A PDF or an EBook names itself from what was stored, as a synced Asset's own target is a bare id. */
function pdfRow({ kind, concept, name }: ViewFavourite): ViewFavouriteRow | null {
    if (kind !== 'asset' || concept === undefined) return null
    return { title: name ?? concept, icon: /\.epub$/i.test(name ?? concept) ? 'book' : 'pdf', view: { kind: 'asset', target: concept } }
}

export function createViewFavourites(deps: ViewFavouritesDeps): ViewFavourites {
    const { registry } = deps
    return {
        favouriteOf(view) {
            const entry = registry.get(view.kind)
            if (!entry?.favourite) return null
            if (entry.conceptTarget) return view.target.trim() === '' ? null : { kind: view.kind, concept: view.target }
            return entry.soleTarget !== undefined && view.target === entry.soleTarget ? { kind: view.kind } : null
        },
        describe(favourite) {
            const pdf = pdfRow(favourite)
            if (pdf) return pdf
            const entry = registry.get(favourite.kind)
            const view = viewOf(entry, favourite)
            const availability = deps.availability(favourite.kind)
            const icon = view ? registry.icon(view) : entry?.icon
            const row: ViewFavouriteRow = {
                title: view ? registry.title(view) : favourite.concept === undefined ? favourite.kind : `${favourite.kind}: ${favourite.concept}`,
                ...(icon === undefined ? {} : { icon }),
                view: availability.state === 'missing' ? null : view,
            }
            if (availability.state === 'missing') row.note = NOT_INSTALLED
            // Opened anyway: the tab says the extension is off and offers to switch it on.
            else if (availability.state === 'off') row.note = `${availability.name} is switched off on this device`
            return row
        },
        subscribe: (listener) => deps.subscribe?.(listener) ?? (() => {}),
    }
}
