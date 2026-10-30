/**
 * Ticking a [[Task]] ticks every Task nested under it, and unticking one unticks them, except a
 * Cancelled one (CONTEXT.md → Task). The one statement of that rule: the checkbox click, the task
 * toggle, the [[Tasks View]]'s tick, a [[Kanban Board]] move and the [[Headless Client]]'s
 * `set_task` all ask this module which lines a write to a task brings with it.
 *
 * The rule reads the [[Task Status]] either side of the write rather than the key that made it,
 * so every route agrees without knowing about the others:
 *
 * - The task becomes Done (from Open, Doing, Waiting or Cancelled): every nested task that is not
 *   ticked is ticked.
 * - The task goes from ticked to unticked: every nested task that is ticked is unticked, except a
 *   Cancelled one. Reopening a parent does not bring back work someone decided to drop.
 * - Anything else brings nothing: a tag change, Done to Cancelled (cancelling a parent says nothing
 *   about whether its children are done), a bullet becoming a task or a task a bullet.
 *
 * Only those writes cascade, never typing: an edit to the line's text, the `#` [[Task Tag]] helper
 * included, changes that line alone, so taking `#C` off a ticked task by hand leaves the tasks under
 * it as they are, as untyping a checkbox's `x` does.
 *
 * Fenced code is read as the [[Derived Index]] reads it (`fencedBlocks`), so a line the index counts
 * as a task is one the cascade ticks, even where the editor's own parse draws it as code (under an
 * opener that has no closer yet).
 *
 * Nothing passes upward. "Nested" is the [[Block]] tree's branch (`branchRange`): any depth, through
 * plain bullets, which stay plain, and never into a heading's section or a fenced code block, whose
 * task-shaped lines are sample text. Only the checkbox character of a nested task is written, so its
 * tags and spacing stay byte for byte, as a tick from the Tasks View leaves them.
 *
 * Pure and DOM-free.
 */

import { fencedBlocks, type FencedBlockRange, linesInFencedBlocks } from './fenced-code'
import { branchRange } from './outliner'
import { parseTaskLine, toggleTaskLine } from './task-tags'
import type { TextChange } from './types'
import { minimalReplacement } from './view/minimal-replacement'

/** One line's write: its 0-based index, what it read, and what it reads after. */
export interface LineWrite {
    index: number
    before: string
    after: string
}

type Checkbox = 'open' | 'done' | 'cancelled'

/** Where a line's checkbox leaves its Task Status, as far as the cascade cares; null for a non-task. */
function checkboxOf(line: string): Checkbox | null {
    const task = parseTaskLine(line)
    if (!task) return null
    return task.done ? (task.cancelled ? 'cancelled' : 'done') : 'open'
}

/** Which way a write from `was` to `now` moves the nested tasks, or null when it moves none. */
function direction(was: Checkbox | null, now: Checkbox | null): 'tick' | 'untick' | null {
    if (was === null || now === null) return null
    if (now === 'done' && was !== 'done') return 'tick'
    if (now === 'open' && was !== 'open') return 'untick'
    return null
}

/**
 * The writes to nested tasks that writing `next` over the task on line `index` of `lines` brings
 * with it, in document order, each a change to that line's checkbox alone. Empty when the write
 * neither makes the task Done nor unticks it, and when no nested task needs changing.
 */
export function nestedTaskWrites(lines: readonly string[], index: number, next: string, blocks: readonly FencedBlockRange[] = fencedBlocks(lines)): LineWrite[] {
    const way = direction(checkboxOf(lines[index]), checkboxOf(next))
    if (way === null) return []
    // A tick reaches the open tasks; an untick the Done ones, never a Cancelled one.
    const moves: Checkbox = way === 'tick' ? 'open' : 'done'
    const inFence = linesInFencedBlocks(blocks)
    const { end } = branchRange(lines as string[], index, blocks as FencedBlockRange[])
    const writes: LineWrite[] = []
    for (let i = index + 1; i <= end; i++) {
        if (inFence.has(i) || checkboxOf(lines[i]) !== moves) continue
        writes.push({ index: i, before: lines[i], after: toggleTaskLine(lines[i], way === 'tick')! })
    }
    return writes
}

/**
 * The text changes that make `writes` over `lines`: the smallest replacement within each line, last
 * line first, so applying them one after another needs no offset arithmetic between them (each
 * edit lands above every edit already made). Offsets count `\n` between lines, as the document's
 * text does.
 */
export function lineWriteChanges(lines: readonly string[], writes: readonly LineWrite[]): TextChange[] {
    const starts: number[] = []
    let offset = 0
    for (const line of lines) {
        starts.push(offset)
        offset += line.length + 1
    }
    const changes: TextChange[] = []
    for (const write of [...writes].sort((a, b) => b.index - a.index)) {
        const edit = minimalReplacement(write.before, write.after)
        if (edit) changes.push({ from: starts[write.index] + edit.from, to: starts[write.index] + edit.to, insert: edit.insert })
    }
    return changes
}
