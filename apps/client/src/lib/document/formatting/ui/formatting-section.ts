/**
 * What the Formatting section of Settings → Maintenance needs (ADR 0109, [[Formatting Scan]]).
 *
 * A module rather than a type inside the component, as `mirror-tab.ts` is: the Settings modal and
 * the workspace that fills it both name the shape, and a Svelte instance script cannot export a
 * type. The session and the callbacks are the workspace's, over the open graph.
 */
import type { FormattingScanSession } from './formatting-session.svelte'

export interface FormattingSectionProps {
    session: FormattingScanSession
    /**
     * What the note above the scan recommends before any fix: an Export of a synced graph, a copy
     * of a folder graph's folder, or nothing to point at for a graph kept only in this browser.
     */
    backup: 'export' | 'folder' | 'none'
    /** Close Settings and open the page with the caret on `line`, counted as `revealLine` counts. */
    onopenpage: (concept: string, line: number) => void
}
