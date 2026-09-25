/**
 * The wikilink parser: turns a string into all wikilinks at every nesting level,
 * in document order. Pure; offsets are relative to the input. Treats `[[` as an
 * open token and `]]` as a close token and matches them with a stack, so
 * `[[[[Physics]] Quantum Mechanics]]` yields the outer link and the inner one.
 *
 * Malformed input degrades gracefully: an unterminated `[[` or a stray `]]`
 * simply produces no link (see ADR 0011 — tolerance, not a feature).
 */

import { conceptOf, type Wikilink } from './model'

export function parseWikilinks(input: string): Wikilink[] {
    const links: Wikilink[] = []
    const openStarts: number[] = []
    let i = 0
    while (i < input.length) {
        if (input[i] === '[' && input[i + 1] === '[') {
            openStarts.push(i)
            i += 2
            continue
        }
        if (input[i] === ']' && input[i + 1] === ']') {
            const start = openStarts.pop()
            if (start !== undefined) {
                const end = i + 1 // inclusive offset of the second ']'
                const text = input.slice(start, end + 1)
                links.push({ text, concept: conceptOf(text), start, end })
            }
            i += 2
            continue
        }
        i += 1
    }
    // Document order. (Starts are always distinct; the secondary key is a stable tiebreak.)
    links.sort((a, b) => a.start - b.start || b.end - a.end)
    return links
}
