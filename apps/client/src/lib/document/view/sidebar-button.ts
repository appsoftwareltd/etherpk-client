/**
 * The look of an Explorer button (Search, Today and the extensions' buttons), in
 * one place so the Sidebar and the Style Guide's specimens draw the same thing ([[Style Guide]],
 * "Sidebar buttons"). Nothing outside the Sidebar's button grid uses these: a push button
 * anywhere else is a `gk-button`.
 */

/**
 * A labelled button: a solid grey fill and no visible border, darker on hover in the light theme
 * and lighter in the dark. The border stays, transparent, for the outline a forced-colours mode
 * draws. The padding is kept tight so that the default 304px Sidebar fits two buttons side by
 * side, with a classic scrollbar beside them. `overflow-hidden` clips a label that cannot fit even
 * in one column (the Sidebar at its narrowest, an extension's long title), rather than letting it
 * spill into the next button.
 */
export const sidebarButton =
    'flex min-w-0 items-center overflow-hidden rounded-md border border-transparent bg-(--gk-surface-2) px-1.5 py-1.5 text-left text-sm font-medium text-(--gk-text-strong) hover:bg-(--gk-border-strong) pointer-coarse:min-h-11'

/** The icon alone, under the phone layout: the same fill, as wide as its column, and 44px tall under a finger. */
export const sidebarIconButton =
    'flex h-9 min-w-0 items-center justify-center rounded-md border border-transparent bg-(--gk-surface-2) text-(--gk-text-default) hover:bg-(--gk-border-strong) pointer-coarse:h-11'
