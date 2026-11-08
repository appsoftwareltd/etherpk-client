/**
 * A person's highlights on an EBook as a page in the graph, grouped by chapter, each with a link back to its
 * passage. It is written when they ask, and it is a copy: highlights stay beside the EBook (ADR 0175), and
 * nothing keeps the page in step. Exporting again adds only what the page does not hold yet.
 */
import { canCreateDocuments, whenDocumentText } from '../draft'
import type { DocumentStore } from '../types'

import { ebookLinkMarkdown, ebookPlaceFragment, plainEbookText } from './ebook-links'
import type { EbookHighlight } from './ebook-state'

/** The page's name, keeping only what a page's name can hold. */
export function highlightsPageName(title: string): string {
    const clean = title.replace(/[[\]/\\:*?"<>|#^]/g, ' ').replace(/\s+/g, ' ').trim()
    return `${clean || 'EBook'} Highlights`
}

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`

/** One highlight as a bullet, its note nested beneath it. */
function highlightLines(highlight: EbookHighlight, ref: string, indent: string): string[] {
    const quote = plainEbookText(highlight.text)
    const lines = [`${indent}- ${quote} ${ebookLinkMarkdown(percent(highlight.fraction), ref, highlight.cfi)}`]
    if (highlight.note) lines.push(`${indent}  - ${plainEbookText(highlight.note)}`)
    return lines
}

/** The highlights in EBook order, under their chapters. A highlight with no chapter has no heading. */
export function highlightsMarkdown(highlights: readonly EbookHighlight[], ref: string): string {
    const lines: string[] = []
    let chapter: string | undefined
    for (const highlight of [...highlights].sort((a, b) => a.fraction - b.fraction)) {
        if (highlight.chapter && highlight.chapter !== chapter) lines.push(`- ${plainEbookText(highlight.chapter)}`)
        chapter = highlight.chapter ?? chapter
        lines.push(...highlightLines(highlight, ref, highlight.chapter ? '  ' : ''))
    }
    return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

export interface HighlightsExport {
    title: string
    author: string
    ref: string
    highlights: readonly EbookHighlight[]
}

const heading = ({ title, author, ref }: HighlightsExport) => `From [${title.replace(/[[\]]/g, '').trim() || 'this EBook'}](${ref})${author ? `, by ${plainEbookText(author)}` : ''}.\n\n`

/** Write the page, or add what it lacks. Answers the page's name and how many highlights it took. */
export async function exportHighlights(store: DocumentStore, request: HighlightsExport): Promise<{ concept: string; added: number }> {
    if (!canCreateDocuments(store)) throw new Error('This graph cannot create a page.')
    const concept = highlightsPageName(request.title)
    try {
        await store.createPage(concept, `${heading(request)}${highlightsMarkdown(request.highlights, request.ref)}`)
        return { concept, added: request.highlights.length }
    } catch (error) {
        // Exists already, or the store refused. `open` below decides which.
        const document = store.open(concept)
        const existing = await whenDocumentText(store, document, concept).catch(() => {
            throw error
        })
        const missing = request.highlights.filter((highlight) => !existing.includes(ebookPlaceFragment(highlight.cfi)))
        if (missing.length > 0) {
            const lead = existing === '' || existing.endsWith('\n') ? '' : '\n'
            document.applyChange({ from: existing.length, to: existing.length, insert: `${lead}${highlightsMarkdown(missing, request.ref)}` }, 'external')
        }
        return { concept, added: missing.length }
    }
}
