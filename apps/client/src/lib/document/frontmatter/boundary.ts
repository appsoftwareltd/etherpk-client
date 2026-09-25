/**
 * The seam between a document's [[Frontmatter]] and its body: the line terminator that ends the
 * closing delimiter. Delete it and the first body line is joined onto the delimiter, which is
 * then not a delimiter - and by the one rule for what a block is (`frontmatter-span.ts`) the
 * whole block dissolves into body text, `title:` and all. Backspace at the start of the first
 * body line does exactly that, and it is a habitual keystroke, so the join is refused rather
 * than repaired: the editor refuses the transaction, and each store refuses the change on the
 * way in, because the buffer is what gets saved and the editor's filter is not the only writer.
 *
 * Judged by the result, not the shape of the change, because undo is dispatched past the
 * editor's filters and may legitimately remove a terminator - the one it inserted a moment ago,
 * leaving the one that was there before. A crossing is a change that deletes the seam AND
 * leaves the document with no block, and is neither of the two deliberate shapes: a change from
 * the document start, which replaces or removes the block whole (select-all, a write-back), and
 * a change to the document end, which deletes the rest. An edit inside the block that breaks a
 * delimiter mid-typing does not delete the seam and is plain text until it balances again, as a
 * half-typed opener is.
 */
import { frontmatterSpan } from '$lib/storage/fs/frontmatter-span'

/** A change as every guard sees it: the range of the OLD text it replaces. */
export interface SeamChange {
    from: number
    to: number
}

/**
 * Whether `changes` would leave a document without the [[Frontmatter]] block it had.
 *
 * Held for a [[Protected Document]] only (`protected-fence.ts`): its block is editable in both
 * lock states (ADR 0061) - it is the part that is *not* protected - but it must not *vanish*,
 * because a deleted delimiter turns the title line into body text, and on the next commit the
 * body is sealed, title and all. An ordinary document may dissolve its block on purpose. Edits
 * inside the block, including ones that close it early, pass; only "had a block, would have
 * none" is refused. `after` is a thunk
 * because materialising the new document is the expensive part and is only needed when a
 * change actually reaches the block.
 */
export function frontmatterWouldVanish(
    before: string,
    changes: readonly { from: number; to: number }[],
    after: () => string,
): boolean {
    const span = frontmatterSpan(before)
    if (!span) return false
    if (!changes.some((change) => change.from <= span.end)) return false
    return frontmatterSpan(after()) === null
}

/** A change as the guard sees it: the old range it replaces and how much it inserts. */
export interface GuardedChange {
    from: number
    to: number
    inserted: number
}

/**
 * Whether `changes` would let a block take in text that was not typed into it. Held for every
 * document (`frontmatter-boundary.ts`): the block may grow only by what the change inserted,
 * because deleting its closing delimiter above a horizontal rule in the body would otherwise
 * make every line down to the rule frontmatter - metadata that was prose a keystroke ago, and on
 * a Protected Document plaintext written through at once and sent to every member of a synced
 * graph. Creating a block where there was none is not growth and passes.
 *
 * Only a change that starts INSIDE the block can grow it, so `span.end` itself is out: a change
 * starting there is an edit to the first body character. Counting it refused every deletion of
 * that character - Backspace on the last of the text a page was created with, or a selection
 * from the top of the body - because the block's end had not moved while the change's net length
 * was negative.
 */
export function frontmatterWouldGrow(before: string, changes: readonly GuardedChange[], after: () => string): boolean {
    const span = frontmatterSpan(before)
    if (!span) return false
    if (!changes.some((change) => change.from < span.end)) return false
    const net = changes.reduce((total, change) => total + change.inserted - (change.to - change.from), 0)
    const next = frontmatterSpan(after())
    return next !== null && next.end > span.end + net
}

/**
 * Whether `changes` would join body text onto the closing delimiter of `text`'s block. `after`
 * is a thunk because materialising the new document is the expensive part, and is only needed
 * for a change that actually deletes the seam.
 */
export function crossesFrontmatterSeam(text: string, changes: readonly SeamChange[], after: () => string): boolean {
    const span = frontmatterSpan(text)
    if (!span || text[span.end - 1] !== '\n') return false // no block, or one that ends the document
    const seam = span.end - 1
    const deletesSeam = changes.some(
        (change) => change.from > 0 && change.from <= seam && change.to > seam && change.to < text.length,
    )
    return deletesSeam && frontmatterSpan(after()) === null
}
