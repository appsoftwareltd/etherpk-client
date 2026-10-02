/**
 * The [[Graph View]]'s names: its extension id, its two View kinds and their identities, and its
 * Command ids. Kept apart from the registration so the workspace can ensure the Sidebar
 * resident, and the address code can name the whole graph, without importing the View itself.
 *
 * Two kinds rather than one kind with two targets, because the Layout finds a resident by kind
 * (`findView`, residents.ts) and places a View by its kind's natural region: the resident must
 * never be confused with the whole graph, and each has its own home.
 */
import { namespacedViewKind } from '$lib/layout/view-ref'
import type { ViewRef } from '$lib/layout/view-ref'
import type { Resident } from '$lib/workspace/residents'

export const GRAPH_VIEW_EXTENSION_ID = 'graph-view'

/** `graph-view.local`: the right Sidebar's resident, the neighbourhood of the active document. */
export const GRAPH_VIEW_LOCAL_KIND = namespacedViewKind(GRAPH_VIEW_EXTENSION_ID, 'local')
/** `graph-view.whole`: the whole graph, in the main region, with its lists beside it. */
export const GRAPH_VIEW_WHOLE_KIND = namespacedViewKind(GRAPH_VIEW_EXTENSION_ID, 'whole')

/** Each is a singleton: one resident, one whole graph. */
export const GRAPH_VIEW_LOCAL = { kind: GRAPH_VIEW_LOCAL_KIND, target: 'local' } as const satisfies ViewRef
export const GRAPH_VIEW_WHOLE = { kind: GRAPH_VIEW_WHOLE_KIND, target: 'whole' } as const satisfies ViewRef

/**
 * The resident as residents.ts reaches it: by kind, on the right, restored as the local copy.
 * The workspace's right-Sidebar toggle counts it among the Sidebar's residents on a desktop, and
 * the extension's Alt+M reveals it.
 */
export const GRAPH_VIEW_RESIDENT: Resident = { kind: GRAPH_VIEW_LOCAL_KIND, side: 'right', fallback: () => GRAPH_VIEW_LOCAL }

export type GraphViewMode = 'local' | 'whole'

/** Which copy a View is. */
export function graphViewMode(view: ViewRef): GraphViewMode {
    return view.kind === GRAPH_VIEW_WHOLE_KIND ? 'whole' : 'local'
}

/** Alt+M: the resident, in front of an expanded right Sidebar. */
export const GRAPH_VIEW_REVEAL = 'graph-view.reveal'
/** The whole graph, in the main region. */
export const GRAPH_VIEW_OPEN_WHOLE = 'graph-view.openWhole'
/** A document tab's row: the whole graph, centred on that document's concept. */
export const GRAPH_VIEW_SHOW_CONCEPT = 'graph-view.showConcept'
