/**
 * Putting a block at the caret: `context.editor.insertBlock`, by the rule a code block
 * (`insertCodeBlock`, editor-commands.ts), a table (`table-insert.ts`) and a Map Block follow:
 *
 * - an empty bullet takes the block's first line as its content, so a fence opens beside the bullet's
 *   dot (form 1);
 * - an empty line is replaced, the block at the line's own indentation;
 * - after any other line the block goes on new lines beneath it at the line's content column, so
 *   beneath a bullet it is the bullet's own.
 *
 * A block that is a fence leaves the caret outside it, since the caret touching a fence shows its
 * text (or, beside an [[Extension Fence]], could not rest on it at all): on the line after it or the
 * line before, whichever no block of its own starts or ends on, and where neither side has a line, an
 * empty line is added after the fence for it. Any other block leaves the caret at its end.
 *
 * `planBlockInsert` is pure over the caret's line and its neighbours, so the rule is tested in Node.
 */
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import { fenceLineInfo } from '../fenced-code'
import { bulletContent, contentColumn, indentBlock, isBulletLine, keepsOutline, lineIndent, taskDone, withoutEdgeBlankLines } from '../outliner'
import { analysisFor } from './analysis/editor-analysis'
import { requestFenceFocus, settleFenceFocus } from './augmentations/interactive-fence'
import { isProtectedDocumentFacet } from './augmentations/protected-document'
import { bodyWritable } from './body-writable'

export interface BlockInsertPlan {
    from: number
    to: number
    insert: string
    /** Where the caret goes once the block is in. */
    caret: number
    /** Where the block's first line starts once it is in: a fence's opener line. */
    blockStart: number
}

/**
 * A line beside the caret's line: none there, a plain line, or a line a block of its own (a fenced
 * block, a table, an image) starts or ends on, where the caret would show the block's text.
 */
export type BlockInsertNeighbour = 'none' | 'plain' | 'block'

/** The lines either side of the caret's line. */
export interface BlockInsertContext {
    /** The line before: none at the document's start or straight after its frontmatter. */
    before: BlockInsertNeighbour
    /** The line after: none at the document's end. */
    after: BlockInsertNeighbour
}

/** Whether a line is an empty bullet, which a block opens beside the dot of. A task's is not. */
function isEmptyBullet(text: string): boolean {
    // A task's marker is no fence's bullet: `- [ ] ` before the backticks is not an opener.
    return isBulletLine(text) && taskDone(text) === undefined && bulletContent(text).trim() === ''
}

/** Whether a block put at a line takes the line's place: an empty line (spaces at most) or an empty bullet. */
export function blockTakesLine(text: string): boolean {
    return isEmptyBullet(text) || text.trim() === ''
}

/** The edit that puts `lines` (without indentation) as a block at the caret's line. */
export function planBlockInsert(line: { from: number; to: number; text: string }, context: BlockInsertContext, lines: readonly string[]): BlockInsertPlan {
    const fence = lines.length > 0 && fenceLineInfo(lines[0]) !== null
    const emptyBullet = isEmptyBullet(line.text)
    if (blockTakesLine(line.text)) {
        // The block takes the line: an empty bullet keeps its marker and opens the block after it.
        const column = emptyBullet ? contentColumn(line.text) : lineIndent(line.text)
        const opener = emptyBullet ? line.text.slice(0, column) : ' '.repeat(column)
        const block = [opener + lines[0], ...indentBlock(lines, ' '.repeat(column)).slice(1)].join('\n')
        if (!fence) return { from: line.from, to: line.to, insert: block, caret: line.from + block.length, blockStart: line.from }
        const after = line.from + block.length + 1
        const caret = caretBeside(context, line.from - 1, after)
        if (caret === null) return { from: line.from, to: line.to, insert: `${block}\n`, caret: after, blockStart: line.from }
        return { from: line.from, to: line.to, insert: block, caret, blockStart: line.from }
    }
    const indent = ' '.repeat(contentColumn(line.text))
    const insert = `\n${indentBlock(lines, indent).join('\n')}`
    return { from: line.to, to: line.to, insert, caret: fence ? line.to : line.to + insert.length, blockStart: line.to + 1 }
}

/**
 * {@link keepsOutline} for a change to `state`'s document that puts whole lines in: after a line's
 * end (`insert` starting with a line break), or over whole lines.
 */
export function changeKeepsOutline(state: EditorState, change: { from: number; to: number; insert: string }): boolean {
    const { lines, outline } = analysisFor(state)
    const start = state.doc.lineAt(change.from)
    if (change.from === change.to && change.insert.startsWith('\n')) return keepsOutline(lines, start.number, 0, change.insert.slice(1).split('\n'), outline)
    return keepsOutline(lines, start.number - 1, state.doc.lineAt(change.to).number - start.number + 1, change.insert.split('\n'), outline)
}

/**
 * Where the caret waits beside a fence that took its line: a plain line after or before it first,
 * then a block's line there, or null when there is no line either side.
 */
function caretBeside(context: BlockInsertContext, before: number, after: number): number | null {
    if (context.after === 'plain') return after
    if (context.before === 'plain') return before
    if (context.after === 'block') return after
    if (context.before === 'block') return before
    return null
}

/**
 * Whether a block can go at the caret of `state`: the body can be written, and the caret is not in
 * the frontmatter, where its lines would be YAML, nor in a fenced block at any depth or a table,
 * where they would be code or cells. Never in a [[Protected Document]], even unlocked: it draws no
 * fence widget, and an extension's block would sit in its plaintext as text.
 */
export function blockInsertable(state: EditorState): boolean {
    return blockInsertableAt(state, state.selection.main.head)
}

/**
 * {@link blockInsertable} for the line at `pos` rather than the caret's: an inline panel asks it of
 * its own line when it puts a block in, since that line can have become code or a table since the
 * panel opened.
 */
export function blockInsertableAt(state: EditorState, pos: number): boolean {
    if (state.readOnly || state.facet(isProtectedDocumentFacet)() || !bodyWritable(state)) return false
    const analysis = analysisFor(state)
    if (pos <= analysis.frontmatterEnd) return false
    const line = state.doc.lineAt(pos).number - 1
    if (analysis.fencedBlocks.some((block) => block.start <= line && line <= block.end)) return false
    return !analysis.tables.some((table) => table.startLine <= line && line <= table.endLine)
}

/**
 * Whether new lines can go straight after the line at `pos` without landing inside a fenced block
 * or a table: the line is past the frontmatter, and is no block's line but its last. Lines put after
 * a fence's closer, or a table's last row, are outside it.
 */
export function blockInsertableAfter(state: EditorState, pos: number): boolean {
    if (state.readOnly || state.facet(isProtectedDocumentFacet)() || !bodyWritable(state)) return false
    const analysis = analysisFor(state)
    if (pos <= analysis.frontmatterEnd) return false
    const line = state.doc.lineAt(pos).number - 1
    if (analysis.fencedBlocks.some((block) => block.start <= line && line < block.end)) return false
    return !analysis.tables.some((table) => table.startLine <= line && line < table.endLine)
}

/** The neighbours of the caret's line, or of the line at `pos`, from the editor's analysis. */
export function insertContext(state: EditorState, pos = state.selection.main.head): BlockInsertContext {
    const line = state.doc.lineAt(pos)
    const { fencedBlocks, tables, imageLines, frontmatterEnd } = analysisFor(state)
    // Fenced blocks and tables number their lines from 0, image lines from 1.
    const image = (index: number) => imageLines.some((entry) => entry.line === index + 1)
    const starts = (index: number) => fencedBlocks.some((block) => block.start === index) || tables.some((table) => table.startLine === index) || image(index)
    const ends = (index: number) => fencedBlocks.some((block) => block.end === index) || tables.some((table) => table.endLine === index) || image(index)
    const index = line.number - 1
    return {
        before: line.number === 1 || line.from - 1 <= frontmatterEnd ? 'none' : ends(index - 1) ? 'block' : 'plain',
        after: line.number === state.doc.lines ? 'none' : starts(index + 1) ? 'block' : 'plain',
    }
}

/** The plan for putting `text` at the caret of `state`, or null where no block can go. */
export function blockInsertPlan(state: EditorState, text: string): BlockInsertPlan | null {
    if (!blockInsertable(state)) return null
    // Blank lines before the block and after it are no part of it: a trailing newline adds none.
    const lines = withoutEdgeBlankLines(text.replace(/\r\n?/g, '\n').split('\n'))
    if (lines.every((line) => line.trim() === '')) return null
    const line = state.doc.lineAt(state.selection.main.head)
    const plan = planBlockInsert(line, insertContext(state), lines)
    // Any extension can put a block in: one that would rearrange the outline around it is refused.
    return changeKeepsOutline(state, plan) ? plan : null
}

/**
 * Put `text` as a block at the caret of `view`, as one undoable change. With `focus`, the widget of a
 * fence it puts in is told to take the keyboard. False where nothing was put in.
 */
export function insertBlock(view: EditorView, text: string, options: { focus?: boolean } = {}): boolean {
    const plan = blockInsertPlan(view.state, text)
    if (!plan) return false
    // Asked before the dispatch: a widget can mount, and ask, inside the very update that wrote it.
    if (options.focus) requestFenceFocus(view, plan.blockStart)
    view.dispatch({ changes: { from: plan.from, to: plan.to, insert: plan.insert }, selection: { anchor: plan.caret }, userEvent: 'input.complete', scrollIntoView: true })
    if (options.focus) settleFenceFocus(view)
    return true
}
