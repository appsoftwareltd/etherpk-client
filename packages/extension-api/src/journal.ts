/**
 * The [[Journal Panel]]: a strip an extension draws beneath a Journal Entry's text and above its
 * Backlinks, about the entry's day, such as that day's events from a calendar. It is outside the
 * document: nothing in it is part of the entry's text, so it is never synced with the graph,
 * searched, exported or published.
 */
import type { ViewVisibility } from './views'

/**
 * What a Journal Panel is mounted with.
 *
 * @public
 */
export interface JournalPanelProps {
    /** The Journal Entry's day, `YYYY-MM-DD`. */
    day: string
    /**
     * The id of the panel the entry's tab is open in, on a desktop: what a Layout call names to open
     * something in the same Pane or beside it. A phone passes none. It is fixed for the panel's
     * life: a tab moved to another Pane is drawn afresh there.
     */
    panelId?: string
    /**
     * Whether the entry's tab can be seen right now, and when that changes. A panel that loads
     * anything waits until it can be seen.
     */
    visibility: ViewVisibility
}

/**
 * A Journal Panel the extension has drawn, as the Client drives it.
 *
 * @public
 */
export interface MountedJournalPanel {
    /** The tab closed, the graph closed, or the extension was switched off. */
    destroy(): void
}

/**
 * A Journal Panel an extension registers.
 *
 * @public
 */
export interface JournalPanel {
    /** Under the extension's id. */
    id: string
    /**
     * Draw the panel into `element`, which is empty and is the extension's alone. For a loaded
     * extension it sits inside a shadow root that holds the extension's own stylesheets, as a View
     * does, and it is as tall as what the extension draws in it: a panel that draws nothing takes no
     * space. The Client calls it once for each journal tab, the tab's own entry only, a Draft
     * included, and never for the older entries of the Journal Roll. A file dropped on the panel is
     * added to the end of the entry, as one dropped below the text is, unless the panel's own drop
     * handler calls `preventDefault`.
     */
    mount(element: HTMLElement, props: JournalPanelProps): MountedJournalPanel
}

/**
 * Adding Journal Panels.
 *
 * @public
 */
export interface ExtensionJournalPanels {
    /**
     * Add a panel beneath every journal tab's entry, those open already included. Panels from
     * several extensions stack in the order they were added.
     */
    register(panel: JournalPanel): () => void
}
