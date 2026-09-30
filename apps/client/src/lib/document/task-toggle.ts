/**
 * Ticking a [[Task]] from the [[Tasks View]] — a write into an authoritative [[Document]],
 * using coordinates the [[Derived Index]] supplied.
 *
 * That tension is the whole reason this module exists. The index is derived and explicitly
 * never authoritative: it can lag the document by a keystroke, and a task's line number is
 * only true for the parse it came from. Writing blind to `line` would mean flipping whatever
 * happens to sit there now — a different task, or a line of prose.
 *
 * So every write finds the task first, with the line finder a [[Kanban Board]] move uses
 * (`task-write.ts`): the indexed line when it still holds a task with the same text, otherwise
 * the one task line in the document with that text. When neither finds it the write is refused
 * and the caller reveals the task instead, which shows the user reality rather than quietly
 * acting on a stale row. The finder is the only thing standing between a lagging index and a
 * wrong edit — it must not be "simplified" away.
 *
 * A tick flips the checkbox and nothing else. Unlike a move to a lane, it leaves any state tag
 * where it is: the checkbox decides a ticked task's status whatever `#W` or `#D` says.
 */

import { findIndexedTask, type IndexedTask } from './task-write'
import { parseTaskLine } from './task-tags'
import type { DocumentStore } from './types'

export type { IndexedTask }

export type TaskToggleOutcome =
    | { ok: true; done: boolean }
    /**
     * `stale`: no task line, or more than one, has the task's text. `missing`: its document is
     * gone. Nothing was written either way.
     */
    | { ok: false; reason: 'stale' | 'missing' }

/**
 * Flip one indexed task's checkbox in its document.
 *
 * The edit is a ONE-CHARACTER range replacement over the checkbox itself, never a rewrite of
 * the line: everything else — indentation, marker spacing, the tag run, the text — is left
 * untouched byte for byte, so this cannot reformat what someone wrote, and it is the smallest
 * possible operation to hand a CRDT.
 */
export async function toggleIndexedTask(store: DocumentStore, task: IndexedTask, done: boolean): Promise<TaskToggleOutcome> {
    const found = await findIndexedTask(store, task)
    if ('reason' in found) return { ok: false, reason: found.reason }
    const line = found.lines[found.index]
    const marker = /^(\s*-\s+\[)([ xX])(\])/.exec(line)
    if (!marker) return { ok: false, reason: 'stale' }

    // Already in the requested state: report success without writing, so a double click or a
    // second tab having got there first is not an error the user has to think about.
    if (parseTaskLine(line)?.done === done) return { ok: true, done }

    const at = found.offset + marker[1].length
    // 'external': this is not the editor typing, so an open editor must be told.
    found.document.applyChange({ from: at, to: at + 1, insert: done ? 'x' : ' ' }, 'external')
    return { ok: true, done }
}
