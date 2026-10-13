/**
 * The **Journal Panel** Contribution Point ([[Journal Panel]], ADR 0120 amended 2026-10-12): a
 * strip an extension draws beneath a Journal Entry's text and above its [[Backlink]]s, about the
 * entry's day, such as the day's events from a calendar. The journal tab mounts every registered panel for its day
 * (`JournalPanels.svelte`), in the order they were registered, and mounts a panel added later as it
 * arrives.
 *
 * Extensions add panels through their context (`journalPanels.register`), which puts the id under
 * the extension's own, records how a loaded extension's panel is isolated, and takes the panel back
 * when the extension stops.
 */
import type { JournalPanelProps, MountedJournalPanel } from '@appsoftwareltd/etherpk-extension-api'

import type { ContributionRegistry } from './contribution-registry'

/** The point kind under which Journal Panels are registered. */
export const JOURNAL_PANEL_KIND = 'journal-panel'

/** One Journal Panel, as the journal tab mounts it. */
export interface ClientJournalPanel {
    /** Stable, namespaced id, under the extension's id. */
    id: string
    /** The extension's name, for the note shown in place of a panel that could not draw. */
    extensionName: string
    /**
     * A loaded extension's panel mounts in a shadow root holding these stylesheets, as its Views
     * do; null mounts it in the page.
     */
    isolation: { styles: readonly string[] } | null
    mount(element: HTMLElement, props: JournalPanelProps): MountedJournalPanel
}

/** Add a panel; returns its removal. */
export function registerJournalPanel(registry: ContributionRegistry, panel: ClientJournalPanel): () => void {
    return registry.register(JOURNAL_PANEL_KIND, panel.id, panel)
}

/** Every panel, in the order they were registered. */
export function listJournalPanels(registry: ContributionRegistry): ClientJournalPanel[] {
    return registry.list(JOURNAL_PANEL_KIND).map((entry) => entry.value as ClientJournalPanel)
}
