/**
 * [[Passage]] derivation for [[Semantic Search]]: cutting one document into the pieces that
 * get an [[Embedding]] each ([[2026-09-16 Semantic Search]] → Passages, ADR 0076).
 *
 * A [[Block]] is the wrong unit. `block_fts` is one row per block because a word either is or
 * is not in a bullet; an embedding of a five-word bullet is noise, and an embedding of a whole
 * page is a blur that matches "notes about the project" and nothing specific in it. A passage
 * is in between: consecutive blocks of one heading section, packed to a character budget, so
 * that a match points somewhere useful and the text is big enough to mean something.
 *
 * Every passage starts with its **breadcrumb** - the document's name and the ancestor labels
 * of its first block - because `- retry with backoff` embedded alone means nothing and
 * `Sync Reliability > Relay reconnect > retry with backoff` means what the author meant. The
 * breadcrumb is part of the embedded text and therefore part of the passage's identity: a
 * passage moved to another page or under another heading is a different passage, re-embedded,
 * while a passage whose surroundings are merely reordered is the same passage and costs nothing.
 *
 * A [[Protected Document]] contributes nothing, by the same predicate the text index uses
 * (`containsCipherFence`): the derived store is plaintext at rest and outlives the session, and
 * an embedding is a partial, invertible copy of what it embeds.
 *
 * Pure and DOM-free, over the block rows `deriveDoc` already produces. The content hash is
 * applied by the index when it writes the row (`index-db.ts`), so this module owes it nothing.
 */

import { ancestorChain, blockContent, type BlockRow } from '../index-derive'
import { containsCipherFence } from '../protection/fence-info'

/** One passage of a document, before the index stamps its hash. */
export interface PassageRow {
    /** Document order. */
    ord: number
    /** 0-based source lines this passage covers, for opening the document at it. */
    startLine: number
    endLine: number
    /** The block the passage starts on; null only for an empty document (never emitted). */
    firstBlockLocalId: number
    /** Breadcrumb line first, then the blocks' text. This is what is embedded and hashed. */
    text: string
}

/**
 * Characters of block text per passage before a new one starts - about 250 tokens of the
 * MiniLM-class tokeniser, comfortably under the 256 it reads. Bigger passages blur; smaller
 * ones lose the context that makes a bullet mean something.
 */
export const PASSAGE_BUDGET_CHARS = 1000

/**
 * A block beyond this many characters is split at line boundaries into budget-sized pieces
 * rather than embedded whole: the model would silently truncate it, and a match inside a long
 * paragraph should still point at the right lines.
 */
const SPLIT_ABOVE_CHARS = PASSAGE_BUDGET_CHARS

/**
 * The last block of a passage is repeated at the start of the next one in the same section
 * when it is short, so a thought that straddles a packing boundary is whole in one of them.
 */
const OVERLAP_MAX_CHARS = Math.floor(PASSAGE_BUDGET_CHARS / 4)

/** The separator between breadcrumb labels, and between the document name and them. */
const CRUMB = ' > '

/** A block's text with its bullet / task / heading marker gone, continuation lines kept. */
function blockBody(block: BlockRow): string {
    return stripWikilinkBrackets(blockContent(block))
}

/** `[[Physics]]` embeds as `Physics`: the brackets are syntax, not meaning. */
function stripWikilinkBrackets(text: string): string {
    return text.replace(/\[\[([^\]]*)\]\]/g, '$1')
}

/** The breadcrumb line: `Concept > Heading > Parent bullet`. */
function breadcrumb(concept: string, blocks: readonly BlockRow[], block: BlockRow): string {
    const chain = ancestorChain(blocks, block.parentId).map(stripWikilinkBrackets)
    return [concept, ...chain].join(CRUMB)
}

interface Piece {
    block: BlockRow
    body: string
    /** The 0-based source lines this piece covers - the block's, or a slice of them. */
    startLine: number
    endLine: number
}

/** Split an oversized block into pieces at line boundaries, each within the budget. */
function pieces(block: BlockRow, body: string): Piece[] {
    if (body.length <= SPLIT_ABOVE_CHARS) return [{ block, body, startLine: block.startLine, endLine: block.endLine }]
    const lines = body.split('\n')
    const out: Piece[] = []
    let buffer: string[] = []
    let bufferStart = block.startLine
    const flush = (endLine: number) => {
        if (buffer.length === 0) return
        out.push({ block, body: buffer.join('\n'), startLine: bufferStart, endLine })
        buffer = []
    }
    lines.forEach((line, n) => {
        const lineNumber = Math.min(block.startLine + n, block.endLine)
        // One line longer than the whole budget is cut at the budget; nothing better exists.
        const parts = line.length > PASSAGE_BUDGET_CHARS ? line.match(new RegExp(`.{1,${PASSAGE_BUDGET_CHARS}}`, 'g')) ?? [line] : [line]
        for (const part of parts) {
            const would = buffer.reduce((n, l) => n + l.length + 1, 0) + part.length
            if (buffer.length > 0 && would > PASSAGE_BUDGET_CHARS) {
                flush(lineNumber - 1)
                bufferStart = lineNumber
            }
            buffer.push(part)
        }
    })
    flush(block.endLine)
    return out
}

/**
 * Derive the passages of one document from its block rows (document order, parentage intact).
 *
 * Sections are cut at headings: a heading is an ancestor of everything under it in the block
 * tree, so its label reaches those passages through the breadcrumb, and the heading's own line
 * opens the section's first passage. Within a section, pieces are packed in order up to the
 * budget; the breadcrumb of a passage is that of its first piece - which, after an overlap, is
 * the repeated tail of the previous passage.
 */
export function derivePassages(concept: string, blocks: readonly BlockRow[]): PassageRow[] {
    const passages: PassageRow[] = []
    let open: Piece[] = []
    let openChars = 0

    const emit = () => {
        if (open.length === 0) return
        const first = open[0]
        const last = open[open.length - 1]
        passages.push({
            ord: passages.length,
            startLine: first.startLine,
            endLine: last.endLine,
            firstBlockLocalId: first.block.localId,
            text: `${breadcrumb(concept, blocks, first.block)}\n${open.map((p) => p.body).join('\n')}`,
        })
    }
    const close = (overlap: boolean) => {
        emit()
        const tail = open[open.length - 1]
        open = []
        openChars = 0
        if (overlap && tail && tail.body.length <= OVERLAP_MAX_CHARS) {
            open.push(tail)
            openChars = tail.body.length
        }
    }

    for (const block of blocks) {
        if (containsCipherFence(block.text)) continue
        // A heading starts a section. In the block tree a heading is the ancestor of everything
        // up to the next heading of its level or above, whatever the indentation, so no other
        // boundary needs detecting: its label reaches the section's passages by the breadcrumb.
        if (block.kind === 'heading') close(false)
        const body = blockBody(block)
        if (body.trim() === '') continue
        for (const piece of pieces(block, body)) {
            const would = openChars + piece.body.length + (open.length > 0 ? 1 : 0)
            if (open.length > 0 && would > PASSAGE_BUDGET_CHARS) close(true)
            open.push(piece)
            openChars += piece.body.length + (open.length > 1 ? 1 : 0)
        }
    }
    emit()
    return passages
}

/** The passage's body without its breadcrumb line: what a result shows as the snippet. */
export function passageBody(text: string): string {
    const newline = text.indexOf('\n')
    return newline === -1 ? '' : text.slice(newline + 1)
}

/** The breadcrumb labels of a passage, from its text - the inverse of what derivation wrote. */
export function passageBreadcrumb(text: string): string[] {
    const newline = text.indexOf('\n')
    const line = newline === -1 ? text : text.slice(0, newline)
    // The document name is the first label; callers already know it, so it is dropped.
    return line.split(CRUMB).slice(1)
}
