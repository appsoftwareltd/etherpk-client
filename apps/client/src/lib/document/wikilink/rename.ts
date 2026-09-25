/**
 * Rewriting [[Wikilink]] targets across a document's source, for the rewrite arm of a page
 * rename (ADR 0037). Pure, so the tricky part - what NOT to touch - is unit-testable.
 *
 * Two things are deliberately left alone:
 *
 * 1. **Links inside code.** `wikilinkOccurrencesInSource` already drops them: a
 *    `[[Physics]]` inside a fence is text the author wrote, not a reference.
 *
 * 2. **Nested occurrences.** `[[[[Physics]] Quantum]]` references the [[Scoped Concept]]
 *    "[[Physics]] Quantum", which is a *different concept* from "Physics" and was not
 *    renamed. Rewriting the inner scope would silently re-point the link at a scoped concept
 *    that does not exist. Renaming a scope is a cascade over every concept beneath it, and
 *    that is out of scope here - the top-level `[[Physics]]` links move, the scoped ones do
 *    not, and the rename dialog's count reflects only what actually moves.
 */

import { wikilinkOccurrencesInSource } from './source'

export interface WikilinkRewrite {
    text: string
    /** How many occurrences were rewritten. */
    count: number
}

/** Absolute [start, end) offsets of an occurrence's inner text (between `[[` and `]]`). */
interface Target {
    from: number
    to: number
}

/**
 * Replace every top-level, non-code `[[from]]` in `source` with `[[to]]`. Matching is
 * case-insensitive on the trimmed concept, mirroring [[Concept]] identity.
 */
export function rewriteWikilinkTarget(source: string, from: string, to: string): WikilinkRewrite {
    const wanted = from.trim().toLowerCase()
    if (wanted === '') return { text: source, count: 0 }

    const occurrences = wikilinkOccurrencesInSource(source)
    if (occurrences.length === 0) return { text: source, count: 0 }

    // Absolute offsets per line, so nesting can be judged and edits applied to the whole source.
    const lineStarts: number[] = []
    let at = 0
    for (const line of source.split('\n')) {
        lineStarts.push(at)
        at += line.length + 1
    }

    const spans = occurrences.map((o) => ({
        occurrence: o,
        start: lineStarts[o.line] + o.matchStart,
        end: lineStarts[o.line] + o.matchEnd,
    }))

    const targets: Target[] = []
    for (const span of spans) {
        if (span.occurrence.concept.trim().toLowerCase() !== wanted) continue
        // Nested inside another wikilink ⇒ it is a scope, not a reference to this concept.
        const nested = spans.some((other) => other !== span && other.start < span.start && other.end > span.end)
        if (nested) continue
        targets.push({ from: span.start + 2, to: span.end - 2 })
    }
    if (targets.length === 0) return { text: source, count: 0 }

    // Apply back-to-front so earlier offsets stay valid.
    targets.sort((a, b) => b.from - a.from)
    let text = source
    for (const target of targets) {
        text = text.slice(0, target.from) + to + text.slice(target.to)
    }
    return { text, count: targets.length }
}

/** Whether `source` references `concept` at the top level - the rename dialog's count. */
export function countWikilinkTargets(source: string, concept: string): number {
    return rewriteWikilinkTarget(source, concept, concept).count
}

/**
 * Replace every `[[from]]` with `[[to]]` **at any nesting depth** - the cascade rule
 * (ADR 0038 §2), and the deliberate inverse of {@link rewriteWikilinkTarget}.
 *
 * A [[Scoped Concept]]'s name *contains* its [[Scope]]'s name, so rewriting the inner link is
 * what renames the scope. `[[[[Physics]] Quantum]] Field Theory` is corrected through its
 * innermost occurrence and comes out right, which is why nothing here recurses and no depth
 * is special-cased.
 *
 * Used for two different things that turn out to be the same operation: rewriting a concept
 * STRING (`[[Physics]] Quantum` → `[[Physical Science]] Quantum`) and rewriting document
 * BODIES, where a scoped reference `[[[[Physics]] Quantum]]` picks up the new scope for free.
 *
 * Links inside code are still skipped - `wikilinkOccurrencesInSource` drops them.
 */
export function rewriteWikilinkScope(source: string, from: string, to: string): WikilinkRewrite {
    const splices = wikilinkScopeSplices(source, from, to)
    if (splices.length === 0) return { text: source, count: 0 }
    // Back-to-front so earlier offsets stay valid.
    let text = source
    for (let i = splices.length - 1; i >= 0; i--) {
        const splice = splices[i]
        text = text.slice(0, splice.from) + splice.insert + text.slice(splice.to)
    }
    return { text, count: splices.length }
}

/** One replacement inside a source: `[from, to)` in the ORIGINAL offsets, and what goes there. */
export interface TextSplice {
    from: number
    to: number
    insert: string
}

/**
 * The per-occurrence splices that {@link rewriteWikilinkScope} applies, in ascending order of
 * position and in the source's original offsets: every `[[from]]` at any depth becomes
 * `[[to]]`, links inside code left alone.
 *
 * Exposed because a rewrite across documents is applied as these splices, never as a
 * whole-text replace (ADR 0066): on a Server Backend each is a small CRDT delete plus insert
 * that merges with concurrent typing elsewhere in the document, and on a Filesystem Backend
 * each goes through the open buffer so the editor showing it is updated in place.
 *
 * Nested targets never overlap a matching OUTER target: an outer link whose concept is exactly
 * `from` cannot also contain a link with that same concept (a concept does not nest inside
 * itself), so the splices are disjoint and may be applied back-to-front without remapping.
 */
export function wikilinkScopeSplices(source: string, from: string, to: string): TextSplice[] {
    const wanted = from.trim().toLowerCase()
    if (wanted === '') return []

    const occurrences = wikilinkOccurrencesInSource(source)
    if (occurrences.length === 0) return []

    const lineStarts: number[] = []
    let at = 0
    for (const line of source.split('\n')) {
        lineStarts.push(at)
        at += line.length + 1
    }

    const splices: TextSplice[] = []
    for (const occurrence of occurrences) {
        if (occurrence.concept.trim().toLowerCase() !== wanted) continue
        const start = lineStarts[occurrence.line] + occurrence.matchStart
        const end = lineStarts[occurrence.line] + occurrence.matchEnd
        splices.push({ from: start + 2, to: end - 2, insert: to })
    }
    return splices.sort((a, b) => a.from - b.from)
}

/**
 * True when `concept` is scoped - at any depth - by `scope`. This is what makes a document
 * part of a rename's cascade set.
 */
export function isScopedBy(concept: string, scope: string): boolean {
    return rewriteWikilinkScope(concept, scope, scope).count > 0
}

/**
 * The concepts a rename of `scope` drags with it: everything scoped by it, at any depth,
 * paired with the name each becomes.
 *
 * Concepts with no document behind them are included by the caller's input if it supplies
 * them - they need no rename, but recognising them keeps the impact count honest.
 */
export function cascadeFor(
    concepts: readonly string[],
    from: string,
    to: string,
): { from: string; to: string }[] {
    const out: { from: string; to: string }[] = []
    for (const concept of concepts) {
        const rewritten = rewriteWikilinkScope(concept, from, to)
        if (rewritten.count > 0) out.push({ from: concept, to: rewritten.text })
    }
    return out
}
