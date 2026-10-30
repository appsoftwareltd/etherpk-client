/**
 * The notice a [[Tasks View]] tick or a [[Kanban Board]] move shows when it brought nested tasks
 * with it (`task-cascade.ts`), with an Undo for the whole write.
 *
 * Those lines change in a document that may not be on screen, and outside any editor's undo
 * history, so without this a tick on the wrong parent would lose the nested tasks' earlier states
 * with no way back. In the editor the same cascade is one undo step and shows in place, so the
 * editor shows no notice. A write that changed no nested task shows nothing either: the tick or
 * move itself is visible where it was made.
 */

import { showNotice } from '$lib/activity/notices'

import { parseTaskLine } from './task-tags'
import type { TaskWrite, TaskWriteOutcome } from './task-write'

/** The notice's id, so a second cascade replaces the first rather than stacking under it. */
export const TASK_CASCADE_NOTICE = 'task-cascade-notice'

function tasks(count: number): string {
    return count === 1 ? '1 task' : `${count} tasks`
}

/**
 * Show the notice for `write`, a write to the task labelled `label`, and return true; or return
 * false and show nothing when the write changed no nested task. `undo` puts the write back (the
 * caller's own undo, so its history and display stay in step) and the notice then says what it did.
 */
export function showCascadeNotice(label: string, write: TaskWrite, undo: () => Promise<TaskWriteOutcome>): boolean {
    const count = write.nested.length
    if (count === 0) return false
    const verb = parseTaskLine(write.after)?.done ? 'Ticked' : 'Unticked'
    showNotice({
        id: TASK_CASCADE_NOTICE,
        tone: 'info',
        text: `${verb} ${tasks(count)} nested under "${label}".`,
        actions: [{ label: 'Undo', id: 'task-cascade-undo', run: async () => reportUndo(label, await undo()) }],
    })
    return true
}

function reportUndo(label: string, outcome: TaskWriteOutcome): void {
    if (!outcome.ok) {
        const text =
            outcome.reason === 'missing'
                ? `The document holding "${label}" was renamed or deleted, so nothing was undone.`
                : `"${label}" changed since, so nothing was undone.`
        showNotice({ id: TASK_CASCADE_NOTICE, tone: 'error', text })
        return
    }
    const { skipped } = outcome
    const text =
        skipped === 0
            ? `Undone: "${label}" and the tasks nested under it are as they were.`
            : skipped === 1
              ? 'Undone, except 1 nested task that changed since. It was left as it is.'
              : `Undone, except ${skipped} nested tasks that changed since. They were left as they are.`
    showNotice({ id: TASK_CASCADE_NOTICE, tone: 'info', text })
}
