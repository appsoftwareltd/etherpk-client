/**
 * How a [[Bookmark]] (CONTEXT.md) finds its line again (ADR 0160).
 *
 * Blocks have no stored identity (ADR 0016), so a bookmark keeps an anchor: the line's number as a
 * hint, its normalised text, and the normalised text of its nearest non-blank neighbours. While the
 * document is open the editor maps the position exactly (`bookmark-marks.ts`); this module answers
 * the other case, a document that changed while it was closed (a peer, an agent, another editor).
 *
 * Pure and DOM-free: lines in, a line number out.
 */

import { contentStart } from '../outliner'

/** Where a bookmark's line was, and what it and its neighbours said. */
export interface LineAnchor {
    /** 0-based line number when last seen. A hint for choosing between candidates, never trusted alone. */
    line: number
    /** The line's text, normalised. Never empty: a blank line cannot be bookmarked. */
    text: string
    /** The nearest non-blank line above, normalised. Absent when there is none. */
    before?: string
    /** The nearest non-blank line below, normalised. Absent when there is none. */
    after?: string
}

/**
 * The lowest {@link similarity} at which an edited line still counts as the bookmarked one. Short
 * lines that share only "the" and a space or two score about 0.3 to 0.45, a line with a word added
 * or changed about 0.8 and above.
 */
const SIMILARITY_THRESHOLD = 0.7

/**
 * Where a line's own words begin: past what the outliner reads as structure (`outliner.ts`
 * `contentStart`: indentation, the `- ` bullet, a task checkbox), then past a heading marker or an
 * ordered-list number. Indenting a line, ticking its task or changing a heading's level leaves its
 * words where they were, so a bookmark keeps its line through all of them.
 */
export function wordsStart(line: string): number {
    const start = contentStart(line)
    const rest = line.slice(start)
    const marker = /^(?:#{1,6}\s+|\d+[.)]\s+)/.exec(rest)
    return start + (marker ? marker[0].length : 0)
}

/** A line's words, from {@link wordsStart}, with runs of whitespace as single spaces. */
export function normaliseLine(line: string): string {
    return line.slice(wordsStart(line)).trim().replace(/\s+/g, ' ')
}

/** The anchor for `line`, or null when the line is blank or not in the document. */
export function captureAnchor(lines: readonly string[], line: number): LineAnchor | null {
    if (!Number.isInteger(line) || line < 0 || line >= lines.length) return null
    const text = normaliseLine(lines[line])
    if (text === '') return null
    const anchor: LineAnchor = { line, text }
    // Walk out to the nearest non-blank lines only: an editor captures every bookmark of a long
    // document each time its edits settle.
    const wordsAt = (i: number) => normaliseLine(lines[i])
    const before = neighbour(wordsAt, lines.length, line, -1)
    const after = neighbour(wordsAt, lines.length, line, 1)
    if (before !== undefined) anchor.before = before
    if (after !== undefined) anchor.after = after
    return anchor
}

/**
 * The line `anchor` now marks in `lines`, or null when no line is close enough ("Line not found").
 * Three passes, each taken only when the one before finds nothing:
 *
 * 1. Lines with exactly the anchor's text. More than one: the one whose neighbours match the
 *    anchor's, then the one nearest the hint.
 * 2. A line whose neighbours are exactly the anchor's: the line was rewritten in place.
 * 3. The line most similar to the anchor's text, at or above {@link SIMILARITY_THRESHOLD}: the line
 *    was edited and moved.
 */
export function resolveAnchor(lines: readonly string[], anchor: LineAnchor): number | null {
    const normalised = lines.map(normaliseLine)
    const wordsAt = (i: number) => normalised[i]
    const candidates = normalised.flatMap((text, i) => (text === '' ? [] : [i]))
    const neighboursMatch = (i: number) =>
        Number(neighbour(wordsAt, normalised.length, i, -1) === anchor.before) +
        Number(neighbour(wordsAt, normalised.length, i, 1) === anchor.after)

    const exact = candidates.filter((i) => normalised[i] === anchor.text)
    if (exact.length > 0) return best(exact, anchor.line, neighboursMatch)

    if (anchor.before !== undefined || anchor.after !== undefined) {
        const between = candidates.filter((i) => neighboursMatch(i) === 2)
        if (between.length > 0) return best(between, anchor.line, () => 0)
    }

    const scores = new Map(candidates.map((i) => [i, similarity(normalised[i], anchor.text)]))
    const similar = candidates.filter((i) => scores.get(i)! >= SIMILARITY_THRESHOLD)
    if (similar.length > 0) return best(similar, anchor.line, (i) => scores.get(i)!)
    return null
}

/**
 * How alike two strings are, from 0 (no character pair in common) to 1 (equal): the Dice
 * coefficient over character bigrams, ignoring case. Cheap enough to run over every line of a long
 * document when it opens.
 */
export function similarity(a: string, b: string): number {
    const x = a.toLowerCase()
    const y = b.toLowerCase()
    if (x === y) return 1
    if (x.length < 2 || y.length < 2) return 0
    const counts = new Map<string, number>()
    for (let i = 0; i < x.length - 1; i++) {
        const pair = x.slice(i, i + 2)
        counts.set(pair, (counts.get(pair) ?? 0) + 1)
    }
    let shared = 0
    for (let i = 0; i < y.length - 1; i++) {
        const pair = y.slice(i, i + 2)
        const left = counts.get(pair) ?? 0
        if (left > 0) {
            shared++
            counts.set(pair, left - 1)
        }
    }
    return (2 * shared) / (x.length - 1 + (y.length - 1))
}

/**
 * The words of the nearest line with words from `line` in direction `step`, or undefined. `wordsAt`
 * reads a line's words: from a list normalised once when every line is read, or line by line when
 * only the neighbours are wanted.
 */
function neighbour(wordsAt: (i: number) => string, count: number, line: number, step: -1 | 1): string | undefined {
    for (let i = line + step; i >= 0 && i < count; i += step) {
        const words = wordsAt(i)
        if (words !== '') return words
    }
    return undefined
}

/** The highest-scoring candidate, ties going to the one nearest the hint, then to the earlier line. */
function best(candidates: readonly number[], hint: number, score: (i: number) => number): number {
    let chosen = candidates[0]
    for (const i of candidates.slice(1)) {
        const diff = score(i) - score(chosen)
        if (diff > 0 || (diff === 0 && Math.abs(i - hint) < Math.abs(chosen - hint))) chosen = i
    }
    return chosen
}
