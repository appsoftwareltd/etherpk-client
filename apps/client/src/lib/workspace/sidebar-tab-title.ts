/**
 * The title of the Graph Sidebar's tab: the graph's name, so the left sidebar says which graph
 * is open where the eye already rests, rather than the word "Graph" for every graph.
 *
 * Pure and Node-tested; the workspace derives the tab title from it and retitles the tab when
 * the name arrives or changes (a synced graph's name comes with the root doc's meta, and a
 * rename lands the same way). A long name is returned whole: every tab caps how wide its title
 * is drawn (`TAB_TITLE_CHARS` in layout/registry.ts), so the graph's name is clipped exactly as
 * a document's is, and the whole of it stays in the tab's tooltip and accessible name.
 */

/** What the tab says while there is no name to show. */
const FALLBACK_TITLE = 'Graph'

/**
 * `name`, trimmed, or "Graph" when there is no name yet. A name equal to `graphId` is the id
 * standing in - a dev-gate OPFS graph has no registry record, so the workspace lets the id
 * serve the settings dialog's name field - and a tab titled with a UUID says nothing, so it
 * keeps the fallback.
 */
export function sidebarTabTitle(name: string, graphId: string): string {
    const trimmed = name.trim()
    if (trimmed === '' || trimmed === graphId) return FALLBACK_TITLE
    return trimmed
}
