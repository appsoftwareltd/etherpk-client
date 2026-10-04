/**
 * The CSS custom properties the workspace root carries for a graph's toolbar colour (Graph
 * Settings → Toolbar colour, ADR 0071): the colour, and the ink that reads on it. Both presenters'
 * top bars paint the colour, and their buttons keep a theme surface of their own over it. What
 * sits straight on the colour with no surface (the desktop toolbar's indexing icon) takes the ink,
 * the same choice the Graphs menu makes for a row painted the same colour, so it stays visible
 * whatever colour is picked. No colour sets nothing, and the theme decides.
 */

import { inkFor } from '$lib/contrast-ink'

export function toolbarAccentStyle(color: string | null): string {
    return color ? `--gk-toolbar-accent: ${color}; --gk-toolbar-ink: ${inkFor(color)};` : ''
}
