/**
 * Name matching: ranking the [[Document]]s, [[Alias]]es and [[Pageless Concept]]s whose names
 * match a typed fragment. [[Search]]'s names group renders the rows verbatim, the same way the
 * wikilink completion popover renders `rankWikilinkCompletions`, and the Tasks View's
 * [[Name Filter]] and All Documents match with `nameMatchKey`.
 *
 * Pure, so it unit-tests without a DOM. It reuses {@link matchScore} rather than growing a second
 * ranker - exact › prefix › substring › subsequence is already the app's answer to "how well does
 * this match". What it adds is **normalisation of the label before scoring**, which is what makes
 * a [[Scoped Concept]] findable by the words a human would type.
 *
 * It began as the Graph Sidebar's Quick Find box, which Search replaced (ADR 0139).
 */

import { matchScore } from './view/augmentations/wikilink-complete-core'
import type { ConceptCandidate } from './index-db'

/** How many rows a ranking returns; beyond this the query is not specific enough to be useful. */
export const NAME_MATCH_LIMIT = 12

/**
 * Fold a concept into the text a human would type for it: wikilink brackets become
 * **spaces**, case is dropped, runs of whitespace collapse.
 *
 * Brackets become spaces rather than nothing so `[[A]][[B]]` reads as `a b`, not `ab`. This
 * is the whole reason scoped concepts are usable here: `"Test [[Document]]"` scores 50
 * against `"test document"` raw (a bare subsequence, ranked below everything) and 400
 * normalised (an exact match).
 */
export function nameMatchKey(concept: string): string {
    return concept
        .replace(/\[\[|\]\]/g, ' ')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
}

export type NameMatchRowKind = 'page' | 'journal' | 'alias' | 'pageless' | 'draft'

export interface NameMatchRow {
    /** What the row shows - the concept as authored, or the typed text for a `draft` row. */
    label: string
    /** The concept to open. For an alias this is the CANONICAL document, not the alias. */
    target: string
    /** Secondary text: `→ Canonical` for an alias, the kind otherwise. */
    detail: string
    kind: NameMatchRowKind
    /**
     * The document the row opens is a [[Protected Document]], so the row wears a padlock. The
     * index's flag, passed through untouched (`ConceptCandidate.protected`): present only when
     * true, and silent about whether the key is currently held.
     */
    protected?: true
}

const KIND_DETAIL: Record<'page' | 'journal' | 'alias', string> = {
    page: 'Page',
    journal: 'Journal',
    alias: '',
}

/**
 * Rank order between kinds at an EQUAL match score. Higher wins.
 *
 * Score comes first, so an exact-name [[Pageless Concept]] still beats a fuzzy page match -
 * you typed the thing's name. This only settles genuine ties, where something that already
 * has content is the better guess than something that does not.
 */
const KIND_RANK: Record<Exclude<NameMatchRowKind, 'draft'>, number> = {
    page: 3,
    journal: 3,
    alias: 2,
    pageless: 1,
}

/** `4 references` — the detail that distinguishes a pageless row from the draft row below it. */
function referencesDetail(references: number | undefined): string {
    const n = references ?? 0
    return n === 1 ? '1 reference' : `${n} references`
}

/**
 * Rank candidates for `query`, most relevant first, capped at {@link NAME_MATCH_LIMIT}.
 *
 * Matches pages, journals, [[Alias]]es and [[Pageless Concept]]s. A pageless row is offered
 * because it now has somewhere to go - a [[Draft]] (ADR 0050) - and it carries its reference
 * count, which is the one thing the draft row below can never show. That count is what makes
 * the two distinguishable, and it is why they were previously excluded.
 *
 * An empty query yields nothing: listing the whole graph is what [[All Documents]] is for.
 *
 * A `draft` row is appended - always last - when the query names no existing candidate, so
 * an unmatched name can be opened as a Draft. It writes nothing, which is what makes a typo
 * here free rather than something rename has to clean up afterwards.
 */
export function rankNames(candidates: readonly ConceptCandidate[], query: string): NameMatchRow[] {
    const trimmed = query.trim()
    if (trimmed === '') return []
    const q = nameMatchKey(trimmed)

    const scored: { row: NameMatchRow; score: number; rank: number; label: string }[] = []
    let exists = false
    for (const candidate of candidates) {
        const key = nameMatchKey(candidate.display)
        if (key === q) exists = true
        const score = matchScore(key, q)
        if (score === null) continue
        const isAlias = candidate.kind === 'alias'
        scored.push({
            row: {
                label: candidate.display,
                // An alias opens the document it names, not a document called by the alias.
                // A pageless concept opens under its own (majority-cased) display, which is
                // the name its page will take when the Draft promotes.
                target: isAlias ? (candidate.canonical ?? candidate.display) : candidate.display,
                detail: isAlias
                    ? `→ ${candidate.canonical ?? ''}`
                    : candidate.kind === 'pageless'
                      ? referencesDetail(candidate.references)
                      : KIND_DETAIL[candidate.kind],
                kind: candidate.kind,
                ...(candidate.protected ? { protected: true } : {}),
            },
            score,
            rank: KIND_RANK[candidate.kind],
            label: candidate.display,
        })
    }
    scored.sort(
        (a, b) => b.score - a.score || b.rank - a.rank || a.label.localeCompare(b.label),
    )

    const rows = scored.slice(0, NAME_MATCH_LIMIT).map((s) => s.row)

    // Compared on the normalised key, so typing "test document" does not offer a draft when
    // "Test [[Document]]" already exists.
    //
    // Pageless concepts now count as existing. They are rows in their own right, and a draft
    // row underneath would lead to exactly the same Draft while showing less about it.
    if (!exists) {
        rows.push({ label: trimmed, target: trimmed, detail: 'New page', kind: 'draft' })
    }
    return rows
}
