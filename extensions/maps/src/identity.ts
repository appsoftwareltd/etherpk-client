/**
 * The maps extension's names (ADR 0118, ADR 0119, ADR 0121): its two View kinds, which its
 * manifest declares with their titles and addresses (`/g/<graph>/m/<concept>` and
 * `/g/<graph>/map`), and its Command ids, all under its id.
 *
 * Two kinds rather than one with a special target: a concept may be called anything, so no target
 * string could stand for "the whole graph" without one day meaning a concept of that name.
 */
import type { ViewRef } from '@appsoftwareltd/etherpk-extension-api'

/** `maps.map`: the [[Map View]] of one concept, the concept as its target. */
export const MAP_VIEW_KIND = 'maps.map'
/** `maps.whole`: the Map View of every place and route in the graph. */
export const MAP_WHOLE_KIND = 'maps.whole'

/** The Graph Map View, the whole graph's: one per graph, its target fixed by the manifest. */
export const MAP_WHOLE = { kind: MAP_WHOLE_KIND, target: 'whole' } as const satisfies ViewRef

/** The Map View of `concept`. */
export function mapViewOf(concept: string): ViewRef {
    return { kind: MAP_VIEW_KIND, target: concept }
}

/** The concept a Map View shows, or null for the whole graph's. */
export function mapViewConcept(view: ViewRef): string | null {
    return view.kind === MAP_VIEW_KIND ? view.target : null
}

/** Insert an empty [[Map Block]] at the caret (`/map`). */
export const MAPS_INSERT = 'maps.insert'
/** A document tab's or a wikilink's Context Menu row: the Map View of the tab's concept, or the link's. */
export const MAPS_OPEN_FROM_MENU = 'maps.openFromMenu'
/**
 * The Command Menu's Map View row: the map of the concept the caret's block answers to, or the
 * choice at the caret when it answers to several.
 */
export const MAPS_OPEN_AT_CARET = 'maps.openAtCaret'
/** The Map View of `{ concept, panelId? }`: what a pick in the Map View row's list runs. */
export const MAPS_OPEN_FOR = 'maps.openFor'
/** The Graph Map View. */
export const MAPS_OPEN_WHOLE = 'maps.openWhole'
/** A Map View tab's row: the document of the concept the map is about. */
export const MAPS_OPEN_PAGE = 'maps.openPage'
