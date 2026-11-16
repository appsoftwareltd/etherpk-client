/**
 * What the block menu's rows do to a bullet [[Block]] and every Block nested under it (the plan
 * "Bullet Context Actions", Editor Content Rules → The block menu). Each answer is read from a state
 * and a 1-based line and returned as a transaction spec or text, so the rules run in Node; the
 * Commands in `commands/block-commands.ts` find the editor and dispatch.
 */

import { type EditorState, type StateCommand, Transaction, type TransactionSpec } from '@codemirror/state'

import { branchRange, contentStart, isBulletLine, lineIndent } from '../outliner'
import { analysisFor } from './analysis/editor-analysis'

/** The 0-based first and last lines of the Block on 1-based `line`, or null when it is not a bullet. */
export function blockRange(state: EditorState, line: number): { start: number; end: number } | null {
    if (line < 1 || line > state.doc.lines) return null
    // The analysis's own bullets only: a `- item` in a fenced block or the frontmatter is code or YAML.
    const { lines, fencedBlocks, branchEnds } = analysisFor(state)
    if (branchEnds[line - 1] < 0 || !isBulletLine(lines[line - 1])) return null
    return branchRange([...lines], line - 1, [...fencedBlocks])
}

/** How many Blocks are nested under the one on `line`: the bullets in its branch, not counting itself. */
export function nestedBlockCount(state: EditorState, line: number): number {
    const range = blockRange(state, line)
    if (!range) return 0
    const { branchEnds } = analysisFor(state)
    let count = 0
    for (let i = range.start + 1; i <= range.end; i++) if (branchEnds[i] >= 0) count++
    return count
}

/** The Block as markdown, moved out to the margin, as a copy carries it to another place. */
export function blockMarkdown(state: EditorState, line: number): string | null {
    const range = blockRange(state, line)
    if (!range) return null
    const { lines } = analysisFor(state)
    const root = lineIndent(lines[range.start])
    return lines
        .slice(range.start, range.end + 1)
        .map((text) => text.slice(Math.min(root, lineIndent(text))))
        .join('\n')
}

/**
 * Delete the Block. Its lines go with the line break before them when it is the document's last, so
 * no empty line is left behind; the caret goes to where the next line starts, or to the end of the
 * line above.
 */
export function deleteBlockSpec(state: EditorState, line: number, userEvent = 'delete.block'): TransactionSpec | null {
    const range = blockRange(state, line)
    if (!range) return null
    const { doc } = state
    const first = doc.line(range.start + 1)
    const last = doc.line(range.end + 1)
    if (last.number < doc.lines) {
        return { changes: { from: first.from, to: last.to + 1 }, selection: { anchor: first.from }, userEvent, scrollIntoView: true }
    }
    const from = first.number > 1 ? first.from - 1 : first.from
    return { changes: { from, to: last.to }, selection: { anchor: from }, userEvent, scrollIntoView: true }
}

/** Write a copy of the Block below it, at the same depth; the caret goes to the end of the copy's first line. */
export function duplicateBlockSpec(state: EditorState, line: number): TransactionSpec | null {
    const range = blockRange(state, line)
    if (!range) return null
    const { doc } = state
    const from = doc.line(range.start + 1).from
    const to = doc.line(range.end + 1).to
    const insert = '\n' + doc.sliceString(from, to)
    const firstLineEnd = to + 1 + doc.line(range.start + 1).length
    return { changes: { from: to, insert }, selection: { anchor: firstLineEnd }, userEvent: 'input.duplicate', scrollIntoView: true }
}

/**
 * Start an empty bullet beside the Block, at its depth: above it, or below its whole branch. The caret
 * goes on it, where a paste then lands as it would after Enter.
 */
export function emptySiblingSpec(state: EditorState, line: number, where: 'before' | 'after'): TransactionSpec | null {
    const range = blockRange(state, line)
    if (!range) return null
    const { doc } = state
    const indent = ' '.repeat(lineIndent(doc.line(range.start + 1).text))
    const bullet = `${indent}- `
    if (where === 'before') {
        const from = doc.line(range.start + 1).from
        return { changes: { from, insert: `${bullet}\n` }, selection: { anchor: from + bullet.length }, userEvent: 'input' }
    }
    const to = doc.line(range.end + 1).to
    return { changes: { from: to, insert: `\n${bullet}` }, selection: { anchor: to + 1 + bullet.length }, userEvent: 'input' }
}

/** The caret at the start of the bullet's text (past its marker and checkbox) or at the end of its line. */
export function caretSpec(state: EditorState, line: number, where: 'start' | 'end'): TransactionSpec | null {
    if (!blockRange(state, line)) return null
    const target = state.doc.line(line)
    const anchor = where === 'start' ? target.from + contentStart(target.text) : target.to
    return { selection: { anchor }, scrollIntoView: true, userEvent: 'select' }
}

/**
 * What one of the outliner's structural commands (indent, outdent, move) would do to the Block with
 * the caret at the start of its text, as a transaction on `state`, or null when it would change
 * nothing. The command runs against a state that differs only in its selection, so its changes apply
 * to `state` as they are.
 */
export function structureSpec(state: EditorState, line: number, command: StateCommand): TransactionSpec | null {
    const caret = caretSpec(state, line, 'start')
    if (!caret) return null
    // Unfiltered: only the caret is placed. Tidy on leave is a filter, and a caret that leaves a line
    // it would tidy (trailing spaces, a task's tags out of order) made a document the command's
    // changes were then worked out against, which did not fit this one: the row threw and did nothing.
    const placed = state.update({ ...caret, filter: false }).state
    let result: Transaction | null = null
    command({ state: placed, dispatch: (tr) => (result = tr) })
    const tr = result as Transaction | null
    if (!tr || !tr.docChanged) return null
    return {
        changes: tr.changes,
        selection: tr.selection ?? tr.state.selection,
        effects: tr.effects,
        userEvent: tr.annotation(Transaction.userEvent) ?? 'input',
        scrollIntoView: true,
    }
}

/**
 * Outdent the Block, as Shift+Tab does, but only a nested one: Shift+Tab on a top-level bullet turns
 * it into a paragraph, which is not what a row called Outdent says.
 */
export function outdentBlockSpec(state: EditorState, line: number, command: StateCommand): TransactionSpec | null {
    const range = blockRange(state, line)
    if (!range || lineIndent(state.doc.line(line).text) === 0) return null
    return structureSpec(state, line, command)
}
