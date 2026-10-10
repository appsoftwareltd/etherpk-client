/**
 * The ways to a [[Map View]] (ADR 0118), all of them on every device:
 *
 * - Open Map View on a document tab's or a wikilink's [[Context Menu]], for the tab's concept or
 *   the one the link names,
 * - the Command Menu's Open Map View row, for the concept the caret's block answers to, or the
 *   choice at the caret when it answers to several, as `/kanban` offers a board,
 * - the Command Menu's Graph Map View row, and the Graph Sidebar's Graph Map View button under
 *   Today's journal,
 * - Open page on a concept's Map View tab, for the document it is about.
 *
 * Opening a map writes nothing, so none of the rows asks whether the page can be edited. All of it
 * goes through the extension's context (ADR 0121), which takes it back as the graph closes.
 */
import type { ExtensionContext, MenuTarget } from '@appsoftwareltd/etherpk-extension-api'

import { getActiveEditorView } from '$lib/document/active-editor'
import { CARET_CONCEPT_DETAIL, caretConcepts, forConceptsDetail } from '$lib/document/caret-concepts'
import { showConceptPicker } from '$lib/document/view/augmentations/concept-picker'
import { editorDocument } from '$lib/document/view/editor-document'
import { parseViewKey } from '$lib/layout/view-ref'

import { MAP_VIEW_KIND, MAP_WHOLE, MAPS_OPEN_AT_CARET, MAPS_OPEN_FOR, MAPS_OPEN_FROM_MENU, MAPS_OPEN_PAGE, MAPS_OPEN_WHOLE, mapViewOf } from './identity'

/** The whole graph's Map View, by its name: its tab, its Command Menu row and its graph sidebar button. */
const GRAPH_MAP_VIEW = 'Graph Map View'

/** The concept of the Map View a tab holds, or null for any other tab or target. */
function mapConcept(target: MenuTarget | undefined): string | null {
    if (target?.kind !== 'tab') return null
    const view = parseViewKey(target.panelId)
    return view.kind === MAP_VIEW_KIND ? view.target : null
}

/**
 * A document's tab or a wikilink, the targets Open Map View applies to: the tab's concept, or the
 * one the link names, with the panel of the tab or of the editor holding the link.
 */
function conceptTarget(target: MenuTarget | undefined): target is MenuTarget & { kind: 'document-tab' | 'wikilink'; concept: string; panelId?: string } {
    return target?.kind === 'document-tab' || target?.kind === 'wikilink'
}

export function registerMapViewCommands(context: ExtensionContext): void {
    const { commands, contextMenu, commandMenu, graphSidebar, layout } = context
    /**
     * Open the Map View of `concept`, or the whole graph's for null, in the Pane holding
     * `inPaneOf`, or where the Layout puts it. Under the name the concept resolves to, as a board
     * is opened: an alias and its page share one map.
     */
    const openMap = (concept: string | null, inPaneOf?: string) =>
        layout.openView(concept === null ? MAP_WHOLE : mapViewOf(context.concepts.canonicalName(concept)), inPaneOf === undefined ? {} : { inPaneOf })

    commands.register(MAPS_OPEN_FROM_MENU, (arg) => {
        const target = arg as MenuTarget | undefined
        // In the Pane of the tab, or of the editor the link is in, as a link clicked there opens.
        if (conceptTarget(target)) openMap(target.concept, target.panelId)
    })
    contextMenu.register({
        id: MAPS_OPEN_FROM_MENU,
        label: 'Open Map View',
        command: MAPS_OPEN_FROM_MENU,
        icon: 'map',
        // After Show Backlinks (5), Open Kanban Board (6) and Show in Graph View (7): the rows
        // that show something about the concept without changing anything.
        order: 8,
        when: (target) => conceptTarget(target),
    })
    commands.register(MAPS_OPEN_AT_CARET, () => {
        const view = getActiveEditorView()
        // Only the editor being worked in: a list drawn in another would get none of the keys.
        if (!view || !view.hasFocus) return
        const { state } = view
        const shown = state.facet(editorDocument)
        const head = state.selection.main.head
        const concepts = caretConcepts(state.doc.toString(), state.doc.lineAt(head).number - 1, shown?.concept ?? null, context.concepts.canonicalName)
        if (concepts.length === 0) return
        // The map opens in the editor's Pane, as a link clicked there opens.
        if (concepts.length === 1) {
            openMap(concepts[0].concept, shown?.panelId)
            return
        }
        showConceptPicker(view, {
            pos: head,
            rows: concepts.map((found) => ({ concept: found.concept, detail: CARET_CONCEPT_DETAIL[found.source] })),
            command: MAPS_OPEN_FOR,
            args: { panelId: shown?.panelId },
            label: 'Open a Map View for',
            // The picker draws from the Client's icon table, which holds the manifest's icons
            // under the extension's id.
            icon: 'maps.map',
        })
    })
    commands.register(MAPS_OPEN_FOR, (arg) => {
        const { concept, panelId } = (arg ?? {}) as { concept?: unknown; panelId?: unknown }
        if (typeof concept === 'string') openMap(concept, typeof panelId === 'string' ? panelId : undefined)
    })
    commandMenu.register({
        id: MAPS_OPEN_AT_CARET,
        title: 'Open Map View',
        // The concept the map opens for, nearest first, under the name it resolves to.
        detail: (menu) => forConceptsDetail(menu.conceptsAtCaret ?? [], context.concepts.canonicalName),
        icon: 'map',
        group: 'Navigate',
        // Straight after Kanban board (140), the other View opened for a concept here.
        order: 141,
        keywords: ['map', 'places', 'routes', 'locations'],
        command: MAPS_OPEN_AT_CARET,
    })
    commands.register(MAPS_OPEN_WHOLE, (arg) => {
        const { panelId } = (arg ?? {}) as { panelId?: unknown }
        // From the Command Menu, in the Pane of the editor it was typed in, as a concept's map opens.
        const from = typeof panelId === 'string' ? panelId : getActiveEditorView()?.state.facet(editorDocument)?.panelId
        openMap(null, from)
    })
    commandMenu.register({
        id: MAPS_OPEN_WHOLE,
        title: GRAPH_MAP_VIEW,
        detail: 'Every place and route in this graph',
        icon: 'map',
        group: 'Navigate',
        order: 142,
        keywords: ['map', 'places', 'routes', 'everything', 'all'],
        command: MAPS_OPEN_WHOLE,
    })
    graphSidebar.register({ id: MAPS_OPEN_WHOLE, title: GRAPH_MAP_VIEW, icon: 'map', command: MAPS_OPEN_WHOLE })
    commands.register(MAPS_OPEN_PAGE, (arg) => {
        const target = arg as MenuTarget | undefined
        const concept = mapConcept(target)
        if (concept !== null && target?.kind === 'tab') layout.openDocument(concept, { inPaneOf: target.panelId })
    })
    contextMenu.register({
        id: MAPS_OPEN_PAGE,
        label: 'Open page',
        command: MAPS_OPEN_PAGE,
        // Above the rows every tab has, which start their own group.
        order: 1,
        when: (target) => mapConcept(target) !== null,
    })
}
