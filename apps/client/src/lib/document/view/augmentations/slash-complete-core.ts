/**
 * Pure logic for the Command Menu (Dual Mode Editor.md → *Command Menu (slash commands)*),
 * kept free of CodeMirror so it is unit-testable: detecting the word-boundary `/` the cursor
 * sits behind, extracting the single-token query, and filtering/ranking the registered
 * `CommandMenuItem`s against that query. The CM wiring (suppression in code/frontmatter/`[[`,
 * the popover, command dispatch, the calendar) lives in `slash-complete.ts`.
 */

import type { CommandMenuItem } from '../../../surface'
import { matchScore } from './wikilink-complete-core'

/** The `/`-triggered context the cursor sits in, as columns within a line. */
export interface SlashContext {
    /** Column of the triggering `/`. */
    slash: number
    /** Column where the query begins (`slash + 1`). */
    queryFrom: number
    /** Text typed after the `/` so far (never contains whitespace). */
    query: string
}

/**
 * The Command Menu context for `linePrefix` (the line's text up to the cursor), or null if
 * the cursor is not behind a word-boundary `/`. The trigger fires only when the current
 * token — the run of non-whitespace ending at the cursor — *starts* with `/`, i.e. the `/`
 * is at the start of the line's content or immediately after whitespace. This is why
 * `http://`, `and/or`, and `24/06` never trigger (their token starts with a letter/digit),
 * a deliberate divergence from AS Notes (which fires on any `/`).
 */
export function openSlashContext(linePrefix: string): SlashContext | null {
    let i = linePrefix.length
    while (i > 0 && !/\s/.test(linePrefix[i - 1])) i--
    const token = linePrefix.slice(i)
    if (!token.startsWith('/')) return null
    return { slash: i, queryFrom: i + 1, query: token.slice(1) }
}

/** The best match score of `query` against an item's title and any keywords, or null. */
function itemScore(item: CommandMenuItem, query: string): number | null {
    let best: number | null = matchScore(item.title, query)
    for (const kw of item.keywords ?? []) {
        const s = matchScore(kw, query)
        if (s !== null && (best === null || s > best)) best = s
    }
    return best
}

/**
 * The applicable items filtered and ranked for a typed `query`. An empty query keeps every
 * item in its registration order (so bare `/` lists everything, grouped by registration);
 * a non-empty query keeps only fuzzy matches (reusing `matchScore`: exact › prefix ›
 * substring › subsequence over title + keywords), best score first, ties broken by the
 * original order so a group stays contiguous. Pure; the popover renders this list verbatim.
 */
export function rankCommandMenu(items: readonly CommandMenuItem[], query: string): CommandMenuItem[] {
    if (query === '') return [...items]
    const scored: { item: CommandMenuItem; score: number; order: number }[] = []
    items.forEach((item, order) => {
        const score = itemScore(item, query)
        if (score !== null) scored.push({ item, score, order })
    })
    scored.sort((a, b) => b.score - a.score || a.order - b.order)
    return scored.map((s) => s.item)
}
