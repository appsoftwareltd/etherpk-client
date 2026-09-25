/**
 * The open graph's toolbar colour (Graph Settings → Toolbar colour, ADR 0071) for chrome that
 * sits outside the workspace root, where the `--gk-toolbar-accent` custom property the
 * workspace sets cannot reach. The application header is a sibling of the workspace, not a
 * descendant, so its Graphs menu reads the colour from here and paints the open graph's row
 * with it: the row and the bar beneath it then say the same thing.
 *
 * A rune singleton, the cross-component pattern of `document/editor-context.svelte.ts`. The
 * workspace writes it whenever the colour is known or changes (the settings read on open, a
 * save, a peer's change over sync) and clears it on teardown; the workspace's own toolbar
 * style is derived from it too, so there is one source of truth for the colour.
 *
 * Keyed by graph id rather than holding a bare colour. A cross-graph navigation rebuilds the
 * workspace, and nothing orders the old instance's clear against the new one's set for a
 * reader's benefit; asking for a named graph's colour returns nothing while the record here is
 * another graph's, so a row is never painted with a colour read from a different folder.
 */

export const graphAccent = $state<{ graphId: string | null; color: string | null }>({
    graphId: null,
    color: null,
})

/** Publish `graphId`'s colour; `undefined` (no setting) still claims the slot for the graph. */
export function setGraphAccent(graphId: string, color: string | undefined): void {
    graphAccent.graphId = graphId
    graphAccent.color = color ?? null
}

/** Forget the colour, but only while it is still `graphId`'s: a later graph's set survives an earlier graph's teardown. */
export function clearGraphAccent(graphId: string): void {
    if (graphAccent.graphId !== graphId) return
    graphAccent.graphId = null
    graphAccent.color = null
}

/**
 * `graphId`'s toolbar colour: the live one while it is the open graph, else `cached` (the
 * registry record's copy, refreshed on every open and save) when a caller has one, else null.
 *
 * Live wins even when it says "none": a colour cleared in the dialog a moment ago must not come
 * back from a cache the same save is still writing. The other rows' cache is fresh by the time
 * anyone reads it, because the menu re-reads the registry each time it opens.
 */
export function graphAccentFor(graphId: string, cached?: string): string | null {
    if (graphAccent.graphId === graphId) return graphAccent.color
    return cached ?? null
}
