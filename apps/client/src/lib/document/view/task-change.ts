/**
 * A [[Task]]'s status or priority set from the line menu (`commands/task-status-commands.ts`), as
 * one editor transaction: the task's line rewritten as a [[Kanban Board]] move writes it
 * (`taskLineWith`), and the tasks nested under it that a Done, an Archive or an untick brings along
 * (`task-cascade.ts`), so one undo puts the whole subtree back, as the checkbox click's tick does.
 */
import type { EditorState, TransactionSpec } from '@codemirror/state'

import { lineWriteChanges, nestedTaskWrites } from '../task-cascade'
import { type TaskChanges, taskLineWith } from '../task-tags'
import { analysisFor } from './analysis/editor-analysis'

/**
 * The transaction that makes `changes` to the task on line `number` (1-based, as the editor counts
 * lines), or null when the line no longer reads `expected` (the text it had when the menu opened: a
 * peer's edit or a reload may have moved another line there since), is no task, or is already as
 * asked.
 *
 * `userEvent: 'input'` keeps it out of CodeMirror's join with an adjacent edit, so Mod+Z takes back
 * this change alone, and the selection maps forward so a caret in the rewritten tag run lands after
 * it rather than inside the replaced span.
 */
export function taskChangeSpec(state: EditorState, number: number, expected: string, changes: TaskChanges): TransactionSpec | null {
    if (number < 1 || number > state.doc.lines) return null
    const { lines, fencedBlocks } = analysisFor(state)
    const index = number - 1
    if (lines[index] !== expected) return null
    const next = taskLineWith(lines[index], changes)
    if (next === null || next === lines[index]) return null
    const writes = [{ index, before: lines[index], after: next }, ...nestedTaskWrites(lines, index, next, fencedBlocks)]
    const set = state.changes(lineWriteChanges(lines, writes))
    return { changes: set, selection: state.selection.map(set, 1), userEvent: 'input' }
}
