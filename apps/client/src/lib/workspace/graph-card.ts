/**
 * What a graph's card on the Graphs page is drawn with. A card is a neutral surface with a band at
 * the top holding the graph's name and main controls. A graph with a toolbar colour (ADR 0071) paints
 * its band in that colour.
 *
 * On a colour a person chose, greys and the theme's own text colours cannot be promised to read, so
 * everything on a coloured band is drawn in the band's ink (contrast-ink.ts), which the band sets as
 * `--graph-ink` beside its colour as `--graph-colour`. Red and amber cannot be promised to read
 * there either, so what uses them sits below the band.
 */

export const GRAPH_CARD = 'overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-white/10 dark:bg-white/5'

/** A card with no band to clip to its corners, so a menu opened from it can hang below its edge. */
export const GRAPH_CARD_UNCLIPPED = 'rounded-xl border border-neutral-200 bg-white dark:border-white/10 dark:bg-white/5'

/** The theme's blue ring cannot be seen on a blue band, so a coloured band's ring is its ink. */
const FOCUS_ON_COLOUR = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--graph-ink)'

/** Open on a coloured band: the inverse of the band, so its contrast is the ink's own. */
export const OPEN_ON_COLOUR = `inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-(--graph-ink) px-3 py-1.5 text-sm font-medium text-(--graph-colour) hover:ring-2 hover:ring-(--graph-ink) hover:ring-offset-1 hover:ring-offset-(--graph-colour) pointer-coarse:min-h-11 ${FOCUS_ON_COLOUR}`

export const ICON_ON_COLOUR = `shrink-0 rounded-lg p-1.5 pointer-coarse:p-3 text-(--graph-ink) hover:bg-(--graph-ink)/15 ${FOCUS_ON_COLOUR}`

export const BADGE_ON_COLOUR = 'rounded-full border border-current px-2 py-0.5 text-sm'
