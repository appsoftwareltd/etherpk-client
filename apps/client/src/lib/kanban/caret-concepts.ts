/**
 * The concepts a [[Kanban Board]] can be opened for from the caret (ADR 0113): the ones the
 * caret's block answers to, nearest first. They are the [[Task Concept]]s a task on that line
 * would have, in the order a reader meets them walking out from the line: its own links, the
 * links above it in the outline, the document's own concept, then the [[Scope]]s in its name.
 *
 * Worked out from the editor's current text by the index's own rules (`blockConceptChain` and
 * `documentTaskConcepts`), so every concept offered is one the index files a task on that line
 * under once it has read the text.
 */
import { conceptKey } from '../document/backlinks'
import { blockConceptChain, documentTaskConcepts } from '../document/index-derive'
import { frontmatterSpan } from '../storage/fs/frontmatter-span'

export interface CaretConcept {
    concept: string
    /**
     * Where the caret's block gets it: linked on its own line, linked on a block above it, the
     * document's own concept, or a scope in the document's name.
     */
    source: 'line' | 'above' | 'page' | 'scope'
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
