/**
 * A row's corners in a group of the header's Graphs menu.
 *
 * A group is drawn as one block: every row has a fill (its graph's toolbar colour, or the theme's
 * neutral one when the graph has none) and the rows meet edge to edge. So only the block's outer
 * corners are rounded: the top of the first row and the bottom of the last. Rounding a row by
 * whether its neighbours were coloured made a graph with no colour look like a separate pill
 * under the others, as if it belonged to another group.
 */
export function bandCornerClass(index: number, count: number): string {
    const first = index === 0
    const last = index === count - 1
    if (first && last) return 'rounded-lg'
    if (first) return 'rounded-t-lg'
    if (last) return 'rounded-b-lg'
    return 'rounded-none'
}
