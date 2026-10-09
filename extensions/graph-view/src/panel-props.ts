import type { GraphViewMode } from './identity'

/** What the shell hands the lazily loaded panel (GraphViewPanel.svelte). */
export interface GraphViewPanelProps {
    mode: GraphViewMode
    /** The dockview panel id of the View, when the desktop presenter mounted it. */
    panelId?: string
    /** Whether the View is on screen; the panel does no work while it is not. */
    onScreen: boolean
}
