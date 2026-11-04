/**
 * Writing a line about a PDF into the graph: a quote from **Copy to journal**, or the link **Add to
 * graph** writes. Today's [[Journal Entry]] is created when the day has none. Otherwise the text is
 * one `external` change, so an editor open on the entry shows it land, as Quick Notes do.
 */
import { canCreateDocuments, whenDocumentText } from '../draft'
import { type FencedBlockRange, fencedBlocks } from '../fenced-code'
import { markdownLinks } from '../markdown-link-target'
import { firstChildSpot, opaqueLineFlags, ownerBulletIndex } from '../outliner'
import { frontmatterLineOffset } from '../reveal'
import { codeRanges, isInCode } from '../wikilink/code-ranges'
import { journalSeparator } from '../quick-notes-journal'
import type { DocumentStore } from '../types'

/** Append to the entry for `day`. Answers the entry's concept. */
export async function appendToJournal(store: DocumentStore, day: string, text: string): Promise<string> {
    if (!canCreateDocuments(store)) throw new Error('This graph cannot create a journal entry.')
    try {
        await store.createJournal(day, text)
        return day
    } catch {
        // Exists already, or the store refused. `open` below decides which.
    }
    const document = store.open(day)
    const existing = await whenDocumentText(store, document, day)
    document.applyChange({ from: existing.length, to: existing.length, insert: `${journalSeparator(existing)}${text}` }, 'external')
    return day
}

/**
 * The last line of the reference to follow: the one the person clicked when it still holds one, or else
 * the first. Only a real link counts, so not a file's name in a sentence, and not code or frontmatter.
 */
function referenceLine(text: string, lines: readonly string[], blocks: FencedBlockRange[], needles: readonly string[], near?: number): number | null {
    const code = codeRanges(text)
    const opaque = opaqueLineFlags([...lines], blocks)
    const body = frontmatterLineOffset(text)
    const lineOf = (offset: number) => text.slice(0, offset).split('\n').length - 1
    const spans = [...markdownLinks(text)]
        .filter((link) => needles.some((needle) => link.target.includes(needle)) && !isInCode(code, link.from, link.to))
        .map((link) => ({ first: lineOf(link.from), last: lineOf(link.to) }))
        .filter(({ first }) => first >= body && !opaque[first])
    const clicked = near === undefined ? undefined : spans.find(({ first, last }) => first <= near - 1 && near - 1 <= last)
    return (clicked ?? spans[0])?.last ?? null
}

/** What starts a quote or indents a line, which the line after it repeats. */
const leadOf = (line: string) => /^\s*(?:>\s?)*/.exec(line)?.[0] ?? ''

/**
 * Where a line goes to follow an existing reference (`near` is the 1-based line a person clicked):
 * the first child of the bullet that owns it, or a new line after prose. A checkbox is never repeated,
 * because that would make a new task, and a table's rows stay together, because a line between them
 * ends the table.
 */
export function placeAfterLink(text: string, needles: readonly string[], line: string, near?: number): { at: number; insert: string } | null {
    const lines = text.split('\n')
    const blocks = fencedBlocks(lines)
    const held = referenceLine(text, lines, blocks, needles, near)
    if (held === null) return null
    const endOf = (at: number) => lines.slice(0, at + 1).join('\n').length
    const bullet = ownerBulletIndex(lines, held, blocks)
    if (bullet !== null) {
        const { after, indent } = firstChildSpot(lines, bullet, blocks)
        return { at: endOf(after), insert: `\n${' '.repeat(indent)}- ${line}` }
    }
    const lead = leadOf(lines[held])
    const inTable = (at: number) => lines[at]?.slice(leadOf(lines[at]).length).startsWith('|') ?? false
    let last = held
    while (inTable(held) && inTable(last + 1)) last++
    return { at: endOf(last), insert: `\n${lead}${line}` }
}

/** Write a line after a reference in a Document. False when the reference has gone. */
export async function insertAfterReference(store: DocumentStore, concept: string, needles: readonly string[], line: string, near?: number): Promise<boolean> {
    const document = store.open(concept)
    const existing = await whenDocumentText(store, document, concept)
    const placement = placeAfterLink(existing, needles, line, near)
    if (!placement) return false
    document.applyChange({ from: placement.at, to: placement.at, insert: placement.insert }, 'external')
    return true
}

/** The markdown link to an Asset, at a page when one is named. */
export function pdfLinkMarkdown(label: string, ref: string, page?: number): string {
    const safe = label.replace(/[[\]]/g, '').trim() || 'PDF'
    return `[${safe}](${ref}${page ? `#page=${page}` : ''})`
}

/** A highlight or note quoted into the journal, with a link back to its page. */
export function quoteMarkdown(quote: string, label: string, ref: string, page: number): string {
    const text = quote.replace(/\s+/g, ' ').trim()
    const link = pdfLinkMarkdown(`${label} p.${page}`, ref, page)
    return text === '' ? `- ${link}\n` : `- ${text} ${link}\n`
}
