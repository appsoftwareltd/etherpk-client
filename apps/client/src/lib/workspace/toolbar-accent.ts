/**
 * The CSS custom properties the workspace root carries for a graph's toolbar colour (Graph
 * Settings → Toolbar colour, ADR 0071): the colour, and the ink that reads on it. Both presenters'
 * top bars paint the colour, and the phone strip's buttons keep a theme surface of their own over
 * it. What sits straight on the colour with no surface (the desktop toolbar's Sidebar toggles, its
 * heading and its indexing icon) takes the ink, the same choice the Graphs menu makes for a row
 * painted the same colour, so it stays visible whatever colour is picked. A toggle under the
 * pointer is lit with a wash of that ink, which shows on the colour where the theme's own hover
 * fill may not. No colour sets nothing, and the theme decides.
 */

import { inkFor } from '#lib/contrast-ink.js'

export function toolbarAccentStyle(color: string | null): string {
    if (!color) return ''
    const ink = inkFor(color)
    return `--gk-toolbar-accent: ${color}; --gk-toolbar-ink: ${ink}; --gk-toolbar-hover: color-mix(in srgb, ${ink} 16%, transparent);`
}
