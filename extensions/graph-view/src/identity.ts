/**
 * The [[Graph View]]'s names: its extension id, its two View kinds and their identities, and its
 * Command ids. The manifest (package.json, `etherpk`) declares the same kinds, which is how the
 * Client knows their titles, icons, places and the whole graph's address before this code runs.
 *
 * Two kinds rather than one kind with two targets, because the Layout finds a resident by kind
 * and places a View by its kind's natural region: the resident must never be confused with the
 * whole graph, and each has its own home.
 */
import type { ViewRef } from '@appsoftwareltd/etherpk-extension-api'

export const GRAPH_VIEW_EXTENSION_ID = 'graph-view'

/** `graph-view.local`: the right Sidebar's resident, the neighbourhood of the active document. */
export const GRAPH_VIEW_LOCAL_KIND = `${GRAPH_VIEW_EXTENSION_ID}.local`
/** `graph-view.whole`: the whole graph, in the main region, with its lists beside it. */
export const GRAPH_VIEW_WHOLE_KIND = `${GRAPH_VIEW_EXTENSION_ID}.whole`

/** Each is a singleton: one resident, one whole graph. */
export const GRAPH_VIEW_LOCAL = { kind: GRAPH_VIEW_LOCAL_KIND, target: 'local' } as const satisfies ViewRef
export const GRAPH_VIEW_WHOLE = { kind: GRAPH_VIEW_WHOLE_KIND, target: 'whole' } as const satisfies ViewRef

export type GraphViewMode = 'local' | 'whole'

/** Which copy a View is. */
export function graphViewMode(view: ViewRef): GraphViewMode {
    return view.kind === GRAPH_VIEW_WHOLE_KIND ? 'whole' : 'local'
}

/** Alt+M: the resident, in front of an expanded right Sidebar. */
export const GRAPH_VIEW_REVEAL = 'graph-view.reveal'
/** The whole graph, in the main region. */
export const GRAPH_VIEW_OPEN_WHOLE = 'graph-view.openWhole'
/** A document tab's or a wikilink's Context Menu row: the whole graph, centred on the tab's concept or the link's. */
export const GRAPH_VIEW_SHOW_CONCEPT = 'graph-view.showConcept'

/** The width at and above which the Client shows its desktop presenter, and a Graph View draws. */
export const DESKTOP_MEDIA_QUERY = '(min-width: 1024px)'
