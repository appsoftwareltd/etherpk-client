/**
 * Whether a Graph Sidebar section that explains itself while empty (Bookmarks, PDF Bookmarks) is
 * open. Empty, it shows its heading alone, so a new graph's Sidebar is not mostly help text. With
 * an item it is open, and the person's own choice wins over both. The choice is kept while the
 * Sidebar is mounted and no longer.
 */

/** `choice` is what the person last chose on the heading, or null when they have not. */
export function sectionOpen(choice: boolean | null, itemCount: number): boolean {
    return choice ?? itemCount > 0
}

/**
 * The choice a press on the heading leaves, from whether the section was `open`. Closing an empty
 * section puts it back as it started and is not kept as a choice, so its first item still opens it
 * and the person sees the item arrive.
 */
export function toggledChoice(open: boolean, itemCount: number): boolean | null {
    return open && itemCount === 0 ? null : !open
}
