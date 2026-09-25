/**
 * Pure logic for wikilink completion (Dual Mode Editor.md → Wikilink completion),
 * kept free of CodeMirror so it is unit-testable: detecting the `[[` context the
 * cursor sits in, finding a closing `]]` to consume, the frontmatter guard, and
 * turning the candidate snapshot into popover rows. The CM wiring lives in
 * `wikilink-complete.ts`. Mirrors the AS Notes `WikilinkCompletionProvider`.
 */

import { conceptKey } from '../../backlinks/backlink-index'
import type { ConceptCandidate, ConceptCandidateKind } from '../../index-db'

/** The innermost unclosed `[[` the cursor sits inside, as columns within a line. */
export interface WikilinkContext {
    /** Column of the innermost unclosed `[[` (its first `[`). */
    open: number
    /** Column where the query text begins (`open + 2`, just past the `[[`). */
    queryFrom: number
    /** Text typed inside the innermost bracket so far (`queryFrom`..cursor). */
    query: string
    /**
     * True when the innermost `[[` is itself inside another unclosed `[[` — i.e. the
     * cursor is in the inner slot of a scoped concept (`[[[[Phys…`). Completion hides
     * scoped concepts here, since inserting bracket-bearing text into an inner slot is
     * confusing; at the top level (`nested: false`) scoped concepts are offered.
     */
    nested: boolean
}

/**
 * The innermost unclosed `[[` in `linePrefix` (the line's text up to the cursor),
 * or null if the cursor is not inside a wikilink. Stack-based, so it resolves the
 * innermost level inside a scoped concept (`[[[[Physics]] Quantum…`).
 */
export function openWikilinkContext(linePrefix: string): WikilinkContext | null {
    const opens: number[] = []
    let i = 0
    while (i < linePrefix.length) {
        if (linePrefix[i] === '[' && linePrefix[i + 1] === '[') {
            opens.push(i)
            i += 2
            continue
        }
        if (linePrefix[i] === ']' && linePrefix[i + 1] === ']') {
            opens.pop()
            i += 2
            continue
        }
        i += 1
    }
    if (opens.length === 0) return null
    const open = opens[opens.length - 1]
    const queryFrom = open + 2
    return { open, queryFrom, query: linePrefix.slice(queryFrom), nested: opens.length > 1 }
}

/**
 * The number of characters from the cursor to just past the `]]` that closes the
 * current innermost link, or -1 if it is unterminated on this line. Used to consume
 * an existing `]]` on accept so editing inside a link never doubles it. `lineSuffix`
 * is the line text from the cursor to the line end. Nested `[[…]]` are skipped.
 */
export function closingBracketOffset(lineSuffix: string): number {
    let depth = 0
    let i = 0
    while (i < lineSuffix.length) {
        if (lineSuffix[i] === '[' && lineSuffix[i + 1] === '[') {
            depth++
            i += 2
            continue
        }
        if (lineSuffix[i] === ']' && lineSuffix[i + 1] === ']') {
            if (depth === 0) return i + 2
            depth--
            i += 2
            continue
        }
        i += 1
    }
    return -1
}

/**
 * The query to rank while editing a wikilink. For an unterminated link this is simply what
 * has been typed before the caret. For an existing closed link, include the text after the
 * caret up to its matching `]]`: clicking near the start of `[[Test New Page]]` should rank
 * against "Test New Page", not the misleading one-letter prefix under the pointer.
 */
export function queryForWikilinkCompletion(
    context: WikilinkContext,
    lineSuffix: string,
): string {
    const close = closingBracketOffset(lineSuffix)
    return close < 0
        ? context.query
        : context.query + lineSuffix.slice(0, close - 2)
}

/**
 * Whether `pos` falls within a leading YAML frontmatter block (`---` … `---`).
 * Completion is suppressed there so `[[` while editing the `aliases:` list never
 * triggers. An unterminated opening fence suppresses to end of document.
 */
export function isInFrontmatter(source: string, pos: number): boolean {
    if (!/^---[ \t]*(\n|$)/.test(source)) return false
    const lines = source.split('\n')
    let close = -1
    for (let i = 1; i < lines.length; i++) {
        if (/^(---|\.\.\.)[ \t]*$/.test(lines[i])) {
            close = i
            break
        }
    }
    if (close === -1) return true // unterminated — treat the rest as frontmatter
    const end = lines.slice(0, close + 1).join('\n').length // end of the closing fence line
    return pos <= end
}

/** One popover row: a candidate or the synthesised "Create new" item. */
export interface WikilinkCompletion {
    /** Shown in the popup and matched against the typed query. */
    label: string
    /** Secondary text — kind hint, alias target, or "Not yet created". */
    detail: string
    /** Selects the row's icon and is exposed to the DOM for styling/tests. */
    kind: ConceptCandidateKind | 'create'
    /** Replacement text: the concept's display name + the closing `]]`. */
    insert: string
}

/** Tier nudges (added to the match score). Small, so they only break near-ties. */
const TIER_BOOST: Record<ConceptCandidateKind, number> = { page: 3, journal: 3, alias: 2, pageless: 1 }

const KIND_DETAIL: Record<ConceptCandidateKind, string> = {
    page: 'Page',
    journal: 'Journal',
    alias: '', // replaced by "→ canonical"
    pageless: 'Not yet created',
}

/**
 * How well `label` matches `query`, or null for no match. Higher is better. An
 * empty query matches everything (so `[[` lists the whole graph). Exact › prefix ›
 * substring › subsequence — match quality dominates; the small tier boost only
 * breaks ties (Dual Mode Editor.md → Wikilink completion, "fuzzy + boost tiers").
 */
export function matchScore(label: string, query: string): number | null {
    if (query === '') return 0
    const l = label.toLowerCase()
    const q = query.toLowerCase()
    if (l === q) return 400
    if (l.startsWith(q)) return 300
    const at = l.indexOf(q)
    if (at > 0) return 200 - Math.min(at, 50) // earlier substring ranks higher
    let qi = 0
    for (let i = 0; i < l.length && qi < q.length; i++) if (l[i] === q[qi]) qi++
    return qi === q.length ? 50 : null
}

/**
 * Rendered rows are CAPPED: the popover builds real DOM (row + inline SVG icon) for every
 * item on every keystroke, and an empty query over a 2,432-concept graph produced 2,432
 * rows — seconds of blocked main thread that read as "typing `[[` hangs the editor"
 * (live, 2026-07-29). Ranking already puts the best matches first, and typing narrows;
 * nobody scrolls thousands of rows.
 */
export const MAX_COMPLETION_ROWS = 40

/**
 * The popover rows for a typed `query`, filtered and ranked: matching candidates
 * (match quality first, tier as the tie-break, display name as the final key),
 * then a synthesised "New concept" row — always last — when the query is
 * non-empty and names no existing candidate. Pure; the hand-rolled popover renders
 * this list verbatim, so it is capped at {@link MAX_COMPLETION_ROWS}.
 */
export function rankWikilinkCompletions(
    candidates: readonly ConceptCandidate[],
    query: string,
): WikilinkCompletion[] {
    const scored: { row: WikilinkCompletion; score: number; display: string }[] = []
    for (const c of candidates) {
        const base = matchScore(c.display, query)
        if (base === null) continue
        scored.push({
            row: {
                label: c.display,
                detail: c.kind === 'alias' ? `→ ${c.canonical}` : KIND_DETAIL[c.kind],
                kind: c.kind,
                insert: `${c.display}]]`,
            },
            score: base + TIER_BOOST[c.kind],
            display: c.display,
        })
    }
    scored.sort((a, b) => b.score - a.score || a.display.localeCompare(b.display))
    const rows = scored.slice(0, MAX_COMPLETION_ROWS).map((s) => s.row)

    const trimmed = query.trim()
    if (trimmed.length > 0 && !candidates.some((c) => c.key === conceptKey(trimmed))) {
        rows.push({ label: query, detail: 'New concept', kind: 'create', insert: `${query}]]` })
    }
    return rows
}
