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

/** A container, so its band is laid out by its own width (CARD_WORDS). */
export const GRAPH_CARD = '@container overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-white/10 dark:bg-white/5'

/**
 * "(not synced)" after the heading of a group EtherPK does not sync: Folder graphs and Plain
 * Folders. Part of the heading, so a screen reader hears it with the name, at the weight and
 * colour of a note beside it.
 */
export const NOT_SYNCED_NOTE = 'text-base font-normal text-neutral-500 dark:text-neutral-400'

/** A card with no band to clip to its corners, so a menu opened from it can hang below its edge. */
export const GRAPH_CARD_UNCLIPPED = 'rounded-xl border border-neutral-200 bg-white dark:border-white/10 dark:bg-white/5'

/**
 * The words of a card's band, between its grip and its controls, which are Open and then the icons
 * (CARD_ICONS), all in one flex row that wraps where the bases no longer fit.
 *
 * - At 10rem the words give way to the icons, which go to a line below while Open stays beside the
 *   name.
 * - In a narrower card their basis is what Open leaves (9rem is the grip, the gaps and Open under a
 *   finger), so Open still stays.
 * - Under 17.5rem that is too little for a name. The words take the line (3.5rem is the grip and a
 *   gap), and Open and the icons start the next one from the left.
 */
export const CARD_WORDS =
    'flex min-w-0 flex-1 basis-[calc(100%-3.5rem)] flex-col gap-0.5 @min-[17.5rem]:basis-[min(10rem,100%-9rem)]'

/** A card's icon buttons: at the band's right edge, or after Open on the line it starts in a narrow card. */
export const CARD_ICONS = 'flex items-center gap-1 @min-[17.5rem]:ml-auto'

/** The theme's blue ring cannot be seen on a blue band, so a coloured band's ring is its ink. */
const FOCUS_ON_COLOUR = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--graph-ink)'

/** Open on a coloured band: the inverse of the band, so its contrast is the ink's own. */
export const OPEN_ON_COLOUR = `inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-(--graph-ink) px-3 py-1.5 text-sm font-medium text-(--graph-colour) hover:ring-2 hover:ring-(--graph-ink) hover:ring-offset-1 hover:ring-offset-(--graph-colour) pointer-coarse:min-h-11 ${FOCUS_ON_COLOUR}`

export const ICON_ON_COLOUR = `shrink-0 rounded-lg p-1.5 pointer-coarse:p-3 text-(--graph-ink) hover:bg-(--graph-ink)/15 ${FOCUS_ON_COLOUR}`

export const BADGE_ON_COLOUR = 'rounded-full border border-current px-2 py-0.5 text-sm'
