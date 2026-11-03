/**
 * Ticking a [[Task]] ticks every Task nested under it, archiving one archives them, and unticking
 * one unticks them, except a Cancelled or Archived one (CONTEXT.md → Task). The one statement of that rule: the checkbox click, the task
 * toggle, the [[Tasks View]]'s tick, a [[Kanban Board]] move, the line menu's status rows, a state
 * tag that tidy on leave sets and the [[Headless Client]]'s `set_task` all ask this module which
 * lines a write to a task brings with it.
 *
 * The rule reads the [[Task Status]] either side of the write rather than the key that made it,
 * so every route agrees without knowing about the others:
 *
 * - The task becomes Done (from Open, Doing, Waiting or Cancelled): every nested task that is not
 *   ticked is ticked.
 * - The task becomes Archived (ADR 0167): every nested task that is not Archived becomes Archived,
 *   ticked if it was open, so archiving a parent takes its subtasks off the [[Kanban Board]] with it.
 * - The task goes from ticked to unticked: every nested task that is ticked is unticked, except a
 *   Cancelled or Archived one. Reopening a parent does not bring back work someone decided to drop
 *   or put away.
 * - Anything else brings nothing: a tag change, Done to Cancelled (cancelling a parent says nothing
 *   about whether its children are done), a bullet becoming a task or a task a bullet.
 *
 * Only those writes cascade, never typing: an edit to the line's text, the `#` [[Task Tag]] helper
 * included, changes that line alone, so taking `#C` off a ticked task by hand leaves the tasks under
 * it as they are, as untyping a checkbox's `x` does. A state tag typed later in the line is the one
 * exception: when the caret leaves the task, tidy on leave sets the status it names, as a status
 * write (`view/leave-tidy.ts`), and that write brings the nested tasks along like any other.
 *
 * Fenced code is read as the [[Derived Index]] reads it (`fencedBlocks`), so a line the index counts
 * as a task is one the cascade ticks, even where the editor's own parse draws it as code (under an
 * opener that has no closer yet).
 *
 * Nothing passes upward. "Nested" is the [[Block]] tree's branch (`branchRange`): any depth, through
 * plain bullets, which stay plain, and never into a heading's section or a fenced code block, whose
 * task-shaped lines are sample text. A tick or an untick writes only the checkbox character of a
 * nested task, so its tags and spacing stay byte for byte, as a tick from the Tasks View leaves them.
 * An archive rewrites the nested task's tag run as a [[Kanban Board]] move does (`taskLineWith`).
 *
 * Pure and DOM-free.
 */

import { fencedBlocks, type FencedBlockRange, linesInFencedBlocks } from './fenced-code'
import { branchRange } from './outliner'
import { parseTaskLine, taskLineWith, toggleTaskLine } from './task-tags'
import type { TextChange } from './types'
import { minimalReplacement } from './view/minimal-replacement'

/** One line's write: its 0-based index, what it read, and what it reads after. */
export interface LineWrite {
    index: number
    before: string
    after: string
}

type Checkbox = 'open' | 'done' | 'cancelled' | 'archived'

/** Where a line's checkbox leaves its Task Status, as far as the cascade cares; null for a non-task. */
function checkboxOf(line: string): Checkbox | null {
    const task = parseTaskLine(line)
    if (!task) return null
    return task.done ? (task.archived ? 'archived' : task.cancelled ? 'cancelled' : 'done') : 'open'
}

type Direction = 'tick' | 'untick' | 'archive'

/** Which way a write from `was` to `now` moves the nested tasks, or null when it moves none. */
function direction(was: Checkbox | null, now: Checkbox | null): Direction | null {
    if (was === null || now === null) return null
    if (now === 'archived' && was !== 'archived') return 'archive'
    if (now === 'done' && was !== 'done') return 'tick'
    if (now === 'open' && was !== 'open') return 'untick'
    return null
}

/** Whether a nested task in `checkbox` is one a cascade going `way` changes. */
function moves(way: Direction, checkbox: Checkbox | null): boolean {
    if (way === 'archive') return checkbox !== null && checkbox !== 'archived'
    // A tick reaches the open tasks; an untick the Done ones, never a Cancelled or Archived one.
    return checkbox === (way === 'tick' ? 'open' : 'done')
}

/**
 * The writes to nested tasks that writing `next` over the task on line `index` of `lines` brings
 * with it, in document order. A tick or an untick changes each line's checkbox alone; an archive
 * makes each line Archived. Empty when the write neither makes the task Done or Archived nor
 * unticks it, and when no nested task needs changing.
 */
export function nestedTaskWrites(lines: readonly string[], index: number, next: string, blocks?: readonly FencedBlockRange[]): LineWrite[] {
    const way = direction(checkboxOf(lines[index]), checkboxOf(next))
    if (way === null) return []
    // Read the fences only once a write moves something: tidy on leave asks after every tidy.
    const fences = blocks ?? fencedBlocks(lines)
    const inFence = linesInFencedBlocks(fences)
    const { end } = branchRange(lines as string[], index, fences as FencedBlockRange[])
    const writes: LineWrite[] = []
    for (let i = index + 1; i <= end; i++) {
        if (inFence.has(i) || !moves(way, checkboxOf(lines[i]))) continue
        const after = way === 'archive' ? taskLineWith(lines[i], { status: 'archived' })! : toggleTaskLine(lines[i], way === 'tick')!
        writes.push({ index: i, before: lines[i], after })
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
