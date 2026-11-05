/**
 * The arithmetic behind dragging a graph's card: where each card sits in a sequence, and which
 * place a dragged card is nearest. Cards differ in height (a synced graph's owner sees its members),
 * so places are worked out from measured heights rather than a fixed row height.
 */

/** Each card's top, measured from the first card's, when cards of these heights are stacked. */
export function stackedTops(heights: readonly number[], gap: number): number[] {
    let top = 0
    return heights.map((height) => {
        const at = top
        top += height + gap
        return at
    })
}

/**
 * The place a card of `height`, centred at `centre`, is nearest among the `others` it could sit
 * between: the place whose centre is closest. Measured from the first card's top. The answer
 * depends only on the pointer's position, not on where the card last was, so a short card passing
 * a tall one settles rather than flipping back and forth as the layout shifts under it.
 */
export function closestSlot(others: readonly number[], height: number, gap: number, centre: number): number {
    let closest = 0
    let closestDistance = Number.POSITIVE_INFINITY
    let top = 0
    for (let place = 0; place <= others.length; place++) {
        const distance = Math.abs(top + height / 2 - centre)
        if (distance < closestDistance) {
            closest = place
            closestDistance = distance
        }
        top += (others[place] ?? 0) + gap
    }
    return closest
}

/** `ids` with `id` moved to `index`, held to the ends of the list. Never mutates. */
export function moveId(ids: readonly string[], id: string, index: number): string[] {
    const rest = ids.filter((other) => other !== id)
    const at = Math.max(0, Math.min(index, rest.length))
    return [...rest.slice(0, at), id, ...rest.slice(at)]
}
