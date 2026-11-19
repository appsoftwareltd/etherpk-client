/**
 * A Due window as a predicate on one task's due date: what the index's `dueClause` asks in SQL,
 * answered in JS for a task the caller holds outside the index (a Kanban card whose move is still
 * being written). `task-due-window.property.test.ts` holds the two to the same answer.
 *
 * `any` lets every task through, dated or not; `none` only the undated; the others only a task
 * whose due date falls in the window, so an undated task is never overdue, due today or due soon.
 */
import type { TaskDueWindow } from './index-db'
import { formatISODate, parseISODate, shiftDate } from './calendar/month-grid-core'

/** True when a task due on `due` (ISO day, or null when undated) is in `window` of `today`. */
export function inDueWindow(due: string | null, window: TaskDueWindow, today: string): boolean {
    if (window === 'any') return true
    if (window === 'none') return due === null
    if (due === null) return false
    if (window === 'overdue') return due < today
    if (window === 'today') return due === today
    return due >= today && due <= formatISODate(shiftDate(parseISODate(today)!, 7))
}
