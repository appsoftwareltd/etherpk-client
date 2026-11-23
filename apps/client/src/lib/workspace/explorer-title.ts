/**
 * What the [[Explorer]] is called: "Explorer" on its icon, and "Explorer: " with the graph's name in
 * the row that titles it, so the Sidebar says which graph is open where the eye already rests.
 *
 * Pure and Node-tested; the workspace retitles the View when the name arrives or changes (a synced
 * graph's name comes with the root doc's meta, and a rename lands the same way). A long name is
 * returned whole: what draws it clips it, and the whole of it stays in the accessible name.
 */

export const EXPLORER_NAME = 'Explorer'
/** What the title opens with, ahead of the graph's name. */
export const EXPLORER_TITLE_PREFIX = `${EXPLORER_NAME}: `

/**
 * The graph's name, trimmed, or null when there is none to show. A name equal to `graphId` is the
 * id standing in: a dev-gate OPFS graph has no registry record, so the workspace lets the id serve
 * the settings dialog's name field.
 */
export function knownGraphName(name: string, graphId: string): string | null {
    const trimmed = name.trim()
    return trimmed === '' || trimmed === graphId ? null : trimmed
}

export function explorerTitle(name: string, graphId: string): string {
    const known = knownGraphName(name, graphId)
    return known === null ? EXPLORER_NAME : EXPLORER_TITLE_PREFIX + known
}
