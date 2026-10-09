/**
 * The concepts a View about a concept can be opened for from the caret: a [[Kanban Board]]
 * (`/kanban`, ADR 0113) and a [[Map View]] (ADR 0118). They are the [[Block Concept]]s of the
 * caret's block, nearest first, in the order a reader meets them walking out from the line: its
 * own links, the links above it in the outline, the document's own concept, then the [[Scope]]s
 * in its name.
 *
 * Worked out from the editor's current text by the index's own rules (`blockConceptChain` and
 * `documentTaskConcepts`), so every concept offered is one the index files a task or a place on
 * that line under once it has read the text.
 */
import { conceptKey } from './backlinks'
import { blockConceptChain, documentTaskConcepts } from './index-derive'
import { frontmatterSpan } from '../storage/fs/frontmatter-span'

export interface CaretConcept {
    concept: string
    /**
     * Where the caret's block gets it: linked on its own line, linked on a block above it, the
     * document's own concept, or a scope in the document's name.
     */
    source: 'line' | 'above' | 'page' | 'scope'
}

/** Where a concept offered at the caret comes from, said beside it in the concept picker. */
export const CARET_CONCEPT_DETAIL: Record<CaretConcept['source'], string> = {
    line: 'In this block',
    above: 'In a parent block',
    page: 'This page',
    scope: "In this page's name",
}

/**
 * The help text of a Command Menu row that opens a View for a concept here (`/kanban`, the Map
 * View): the nearest concept, and how many more the concept picker will offer. `concepts` are as
 * the menu read them, nearest first; `canonical` names an alias by its page, so the two count once.
 * Undefined when there is no concept here.
 */
export function forConceptsDetail(concepts: readonly string[], canonical: (concept: string) => string = (concept) => concept): string | undefined {
    const seen = new Set<string>()
    const names: string[] = []
    for (const concept of concepts) {
        const name = canonical(concept)
        const key = conceptKey(name)
        if (seen.has(key)) continue
        seen.add(key)
        names.push(name)
    }
    if (names.length === 0) return undefined
    return names.length === 1 ? `For ${names[0]}` : `For ${names[0]} and ${names.length - 1} more`
}

/**
 * The concepts at `caretLine` (0-based, counting the whole text, frontmatter included) of a
 * document named `documentConcept`. `canonical` names an [[Alias]] by its page, so an alias and
 * its page, which open the same board, are offered once.
 */
export function caretConcepts(
    text: string,
    caretLine: number,
    documentConcept: string | null,
    canonical: (concept: string) => string = (concept) => concept,
): CaretConcept[] {
    const found: CaretConcept[] = []
    // The index derives over the body, and counts its lines from there.
    const frontmatter = frontmatterSpan(text)
    const bodyLine = caretLine - (frontmatter?.lines ?? 0)
    if (bodyLine >= 0) {
        const body = frontmatter ? text.slice(frontmatter.end) : text
        for (const { concept, depth } of blockConceptChain(body, bodyLine)) found.push({ concept, source: depth === 0 ? 'line' : 'above' })
    }
    if (documentConcept !== null) {
        documentTaskConcepts(documentConcept).forEach((concept, i) => found.push({ concept, source: i === 0 ? 'page' : 'scope' }))
    }
    const seen = new Set<string>()
    const out: CaretConcept[] = []
    for (const candidate of found) {
        const concept = canonical(candidate.concept)
        const key = conceptKey(concept)
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ concept, source: candidate.source })
    }
    return out
}
