/**
 * The run a [[Block View]] shows (ADR 0209), for `shown-range.ts`: the bullet [[Block]] on the
 * editor's anchored line (`line-anchor.ts`) and every Block nested under it, worked out afresh from
 * the text after every change. The Block View's editor is its document's own, on the document's
 * shared text, so another member's edit is in it as it lands and nothing is copied or merged.
 *
 * The anchor follows the Block's line through lines added or removed above it, edits to its words
 * and a move. Where the line itself is taken out (the person deletes the Block, another member cuts
 * it), the anchor alone would slide onto the line after it and show another Block; the run is then
 * empty instead, for good, and the View says the Block is gone ({@link blockViewRoot}).
 */
import { type EditorState, StateField, type Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { type BlockLink, blockFingerprintOf } from '../block-link'
import { contentStart, parentIndex } from '../outliner'
import { frontmatterLineOffset } from '../reveal'
import { analysisFor } from './analysis/editor-analysis'
import { blockMarkdown, blockRange } from './block-actions'
import type { ShownPartNames } from './edit-refused'
import { anchoredLine, anchorLine, lineAnchorField, lineRemoved } from './line-anchor'
import { emptiesRun, type ShownRange, type ShownRangeOf, shownRangeIn } from './shown-range'

/** How a refused edit's notice names a Block View's run: "Kept in the block". */
export const BLOCK_VIEW_NAMES: ShownPartNames = { field: 'block', line: 'line', above: 'the line above it' }

/**
 * Whether the anchored line has been taken out of the document since it was anchored. Cleared when
 * a line is anchored again.
 */
const rootGoneField = StateField.define<boolean>({
    create: () => false,
    update(gone, tr) {
        for (const effect of tr.effects) if (effect.is(anchorLine)) return false
        if (gone || !tr.docChanged) return gone
        const start = tr.startState.field(lineAnchorField, false)
        if (start === null || start === undefined) return false
        return lineRemoved(start, tr, (before, after) => before === after, contentStart) || runTakenOut(start, tr)
    },
})

/**
 * Whether `tr` took the whole Block out: one change covers every line the View showed, and none
 * writes the Block's line again. `lineRemoved` cannot tell for a Block whose line has no words (an
 * emptied bullet), which it judges by its neighbours; the run says it plainly. A move of the Block
 * written as one replacement writes its line again, and is followed rather than taken for a removal.
 */
function runTakenOut(start: number, tr: Transaction): boolean {
    const run = shownRangeIn(tr.startState)
    if (!run) return false
    // The text is the text before with the run and a line break beside it gone: the outliner's own
    // delete of everything shown, which it may write as a smaller replacement leaving the marker.
    if (emptiesRun(tr, run)) return true
    let covered = false
    let rewritten = false
    const text = tr.startState.doc.lineAt(start).text
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        if (fromA > run.from || toA < run.to) return
        covered = true
        if (inserted.toString().split('\n').includes(text)) rewritten = true
    })
    return covered && !rewritten
}

/** The 1-based line of the Block a Block View shows, or null when it has none or it is gone. */
function rootLine(state: EditorState): number | null {
    if (state.field(rootGoneField, false)) return null
    return anchoredLine(state)
}

/**
 * The run of a Block View: the Block on the anchored line and every Block nested under it. `onRoot`
 * hears where the Block is and what it says ({@link blockViewRoot}) each time either changes, and
 * null once it is gone: what the View's title, breadcrumb, address and printing read.
 */
export function blockViewRange(onRoot?: (root: BlockViewRoot | null) => void): ShownRangeOf {
    const rangeOf = (state: EditorState): ShownRange | null => {
        const line = rootLine(state)
        if (line === null) return null
        const block = blockRange(state, line)
        if (block === null) return null
        return { from: state.doc.line(block.start + 1).from, to: state.doc.line(block.end + 1).to, nestedUnder: line, wholeBlock: true }
    }
    const extension = onRoot ? [rootGoneField, rootReporter(onRoot)] : rootGoneField
    return Object.assign(rangeOf, { names: BLOCK_VIEW_NAMES, extension })
}

/** Tell `onRoot` where the Block is after each change to the text or the anchor, when that changed. */
function rootReporter(onRoot: (root: BlockViewRoot | null) => void) {
    let last: string | undefined
    return EditorView.updateListener.of((update) => {
        const anchorMoved = update.startState.field(lineAnchorField, false) !== update.state.field(lineAnchorField, false)
        if (!update.docChanged && !anchorMoved && last !== undefined) return
        const root = blockViewRoot(update.state)
        const said = JSON.stringify(root)
        if (said === last) return
        last = said
        onRoot(root)
    })
}

/** A line of a document by its 0-based body line, as the [[Derived Index]] counts lines, and its text. */
export interface BodyLine {
    line: number
    text: string
}

/** Where a Block View's Block is now and what it says. */
export interface BlockViewRoot extends BodyLine {
    /** The bullets it is nested under, outermost first. */
    ancestors: BodyLine[]
    /** The Block and everything nested under it, moved out to the margin: what printing it prints. */
    markdown: string
}

/** The Block a Block View shows, read from `state`; null when it has none or it is gone. */
export function blockViewRoot(state: EditorState): BlockViewRoot | null {
    const line = rootLine(state)
    if (line === null) return null
    const markdown = blockMarkdown(state, line)
    if (markdown === null) return null
    const { lines, fencedBlocks, frontmatterEnd } = analysisFor(state)
    const offset = frontmatterEnd < 0 ? 0 : frontmatterLineOffset(state.doc.toString())
    const ancestors: BodyLine[] = []
    const mutable = [...lines]
    const blocks = [...fencedBlocks]
    for (let parent = parentIndex(mutable, line - 1, blocks); parent !== null; parent = parentIndex(mutable, parent, blocks)) {
        ancestors.unshift({ line: parent - offset, text: lines[parent] })
    }
    return { line: line - 1 - offset, text: lines[line - 1], ancestors, markdown }
}

/**
 * The link to the bullet on 1-based `line` of `state`'s document (`block-link.ts`), named
 * `document`: its body line and its fingerprint. Null when the line is not a bullet.
 */
export async function blockLinkInEditor(state: EditorState, line: number, document: string): Promise<BlockLink | null> {
    if (blockRange(state, line) === null) return null
    const { lines, fencedBlocks, frontmatterEnd } = analysisFor(state)
    const parent = parentIndex([...lines], line - 1, [...fencedBlocks])
    const offset = frontmatterEnd < 0 ? 0 : frontmatterLineOffset(state.doc.toString())
    const fingerprint = await blockFingerprintOf(lines[line - 1], parent === null ? null : lines[parent])
    return { document, line: line - 1 - offset, fingerprint }
}
