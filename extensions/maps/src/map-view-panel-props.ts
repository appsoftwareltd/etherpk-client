/** What the shell hands the lazily loaded panel (MapViewPanel.svelte). */
export interface MapViewPanelProps {
    /** The concept whose places and routes are shown, or null for the whole graph's. */
    concept: string | null
    /** The dockview panel id of the View, when the desktop presenter mounted it. */
    panelId?: string
    /** Whether the View is on screen; the panel reads nothing while it is not. */
    onScreen: boolean
}
