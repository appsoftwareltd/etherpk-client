/**
 * A change to the table under the caret, written back as text: what the table Commands
 * (`commands/editor-commands.ts`), the Table Grid's keys (`augmentations/table-cell-editor.ts`)
 * and its row and column menus all do, so each leaves the same text and the caret in the same
 * place.
 */

import type { StateCommand, StateEffect } from '@codemirror/state'

import { cellPipes, type MarkdownTable } from '../markdown-table'
import { minimalReplacement } from './minimal-replacement'
import { buildTable, cellPosition } from '../markdown-table-edit'
import { type TableCaret, tableAtCaret } from './table-context'

/** Where the caret goes after a table edit: a body row (0-based) or the header (negative), and a column. */
export interface CaretCell {
    bodyRow: number
    column: number
}

/** One change of a table's text: a range of the text as it was, and what goes there. */
export interface TableTextChange {
    from: number
    to: number
    insert: string
}

/**
 * What a line of a table says, whatever its padding: its cells' text, and for the delimiter row its
 * colons. Two lines that say the same are the same row before and after an edit that lined the
 * columns up again.
 */
function rowKey(line: string): string {
    return line.replace(/-+/g, '-').replace(/\s+/g, ' ').trim()
}

/**
 * The changes that turn one line of a table into another, as offsets into the old line. A line is
 * changed cell by cell where it has the cells it had: padding added on both sides of a cell's text
 * is then two changes beside the text, and not one over it.
 */
function lineChanges(old: string, text: string): TableTextChange[] {
    const cuts = (row: string) => [-1, ...cellPipes(row), row.length]
    const [oldCuts, newCuts] = [cuts(old), cuts(text)]
    if (oldCuts.length !== newCuts.length) {
        const change = minimalReplacement(old, text)
        return change ? [change] : []
    }
    const changes: TableTextChange[] = []
    for (let i = 0; i + 1 < oldCuts.length; i++) {
        const at = oldCuts[i] + 1
        const change = minimalReplacement(old.slice(at, oldCuts[i + 1]), text.slice(newCuts[i] + 1, newCuts[i + 1]))
        if (change) changes.push({ from: at + change.from, to: at + change.to, insert: change.insert })
    }
    return changes
}

/** How many lines at the start and at the end of a table say the same before and after ({@link rowKey}). */
function sameRows(was: readonly string[], now: readonly string[]): { head: number; tail: number } {
    const same = (a: number, b: number) => rowKey(was[a]) === rowKey(now[b])
    let head = 0
    while (head < was.length && head < now.length && same(head, head)) head++
    let tail = 0
    while (tail < was.length - head && tail < now.length - head && same(was.length - 1 - tail, now.length - 1 - tail)) tail++
    return { head, tail }
}

/**
 * Rows added or removed as one piece, with the line break that joins them to the rest: `lines`
 * take the place of the old text from `from` to the start of the line at `to`, or to the end of
 * the text when nothing follows them, in which case the break is the one before them.
 */
function rowsChange(before: string, lines: readonly string[], from: number, to: number | null): TableTextChange {
    const piece = lines.join('\n')
    if (to !== null) return { from, to, insert: lines.length > 0 ? piece + '\n' : '' }
    if (from > 0) return { from: from - 1, to: before.length, insert: lines.length > 0 ? '\n' + piece : '' }
    return { from: 0, to: before.length, insert: piece }
}

/**
 * The changes that turn a table's text `before` into `after`, as small as its lines allow. A line
 * that says the same before and after ({@link rowKey}) is the same row: it is changed in the part
 * of it that differs, which is its padding when an edit lines the columns up again. Rows that were
 * added or removed between such lines are a piece of their own. A row added is then that row and
 * some padding, and a column added is a piece of each line.
 *
 * Writing the whole table again would be one change over all of it. On a synced graph that is one
 * enormous operation over everything another member is typing in the table at the time, and their
 * caret, wherever it was in the table, is carried to its start (ADR 0066 says the same of a
 * document). Offsets are into `before`, in order, and no two overlap.
 */
export function tableTextChanges(before: string, after: string): TableTextChange[] {
    if (before === after) return []
    const was = before.split('\n')
    const now = after.split('\n')
    const { head, tail } = sameRows(was, now)
    const starts: number[] = []
    was.reduce((at, text, i) => ((starts[i] = at), at + text.length + 1), 0)
    const changes: TableTextChange[] = []
    /** The line at `index` becomes `text`. */
    const line = (index: number, text: string) => {
        for (const change of lineChanges(was[index], text)) changes.push({ from: starts[index] + change.from, to: starts[index] + change.to, insert: change.insert })
    }
    for (let i = 0; i < head; i++) line(i, now[i])
    const middle = now.slice(head, now.length - tail)
    // The lines between as many as before: each is the line in its place, changed.
    if (was.length === now.length) middle.forEach((text, i) => line(head + i, text))
    else changes.push(rowsChange(before, middle, head < was.length ? starts[head] : before.length + 1, tail > 0 ? starts[was.length - tail] : null))
    for (let i = was.length - tail; i < was.length; i++) line(i, now[now.length - (was.length - i)])
    return changes
}

/**
 * Apply a pure table transform at the caret and write the re-serialised table back, then put
 * the caret at the start of a cell of the new table — the one `after` names, or the same cell
 * the caret was in. Explicit, because the caret's own cell may be one the edit rewrote, and the
 * next edit reads the caret's row. Only the lines that differ are changed ({@link tableTextChanges}).
 * `target` is an editor, or a test's stand-in over a state. `effects` ride on the same transaction:
 * a block of cells to keep selected over the table as it now is, which starts where it did.
 */
export function editTableAtCaret(
    target: Parameters<StateCommand>[0],
    transform: (hit: TableCaret) => MarkdownTable | null,
    after: (hit: TableCaret) => CaretCell = (hit) => ({ bodyRow: hit.bodyRow, column: hit.column }),
    effects: (hit: TableCaret) => readonly StateEffect<unknown>[] = () => [],
): boolean {
    const hit = tableAtCaret(target.state)
    if (!hit) return false
    const next = transform(hit)
    if (!next) return false
    const text = buildTable(next, hit.indent, hit.headerIndent)
    const cell = after(hit)
    // The header keeps a caret that was on the header or separator; body rows clamp to what is left.
    const lineIndex = cell.bodyRow < 0 ? 0 : 2 + Math.min(cell.bodyRow, next.rows.length - 1)
    const column = Math.min(cell.column, next.header.length - 1)
    target.dispatch(
        target.state.update({
            changes: tableTextChanges(target.state.sliceDoc(hit.from, hit.to), text).map((change) => ({ from: hit.from + change.from, to: hit.from + change.to, insert: change.insert })),
            selection: { anchor: hit.from + cellPosition(text, lineIndex, column) },
            effects: effects(hit),
            userEvent: 'input.complete',
        }),
    )
    return true
}
