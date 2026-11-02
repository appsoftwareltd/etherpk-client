/**
 * "Move all to lane" on a [[Kanban Board]] (ADR 0167): every task in one [[Lane]] written into
 * another [[Task Status]], and the whole move taken back as one.
 *
 * Each task is written through the same writer a single card's move uses (`writeTaskChanges`),
 * one after another, so each finds its task as the document is after the writes before it. A
 * parent's write can bring its nested tasks with it (`task-cascade.ts`); a nested task in the same
 * lane is then found already moved, and counted without being written twice.
 */
import type { TaskStatus } from '#lib/document/index-db.js'
import { type IndexedTask, type TaskWrite, undoTaskWrite, writeTaskChanges } from '#lib/document/task-write.js'
import type { DocumentStore } from '#lib/document/types.js'

/** One task line a move changed, in its document: all that taking it back needs. */
export interface MovedTask {
    document: string
    write: TaskWrite
}

export interface LaneMoveResult {
    /** Tasks now in the new status, whether this move wrote them or a parent's write did. */
    moved: number
    /** Tasks that were not found as the index described them (edited, or their document gone), and were left. */
    refused: number
    /** The writes made, in the order they were made. */
    writes: MovedTask[]
}

/** Write each of `tasks` into `to`, in order. A task that cannot be found is counted and passed over. */
export async function moveTasks(store: DocumentStore, tasks: readonly IndexedTask[], to: TaskStatus): Promise<LaneMoveResult> {
    const result: LaneMoveResult = { moved: 0, refused: 0, writes: [] }
    for (const task of tasks) {
        const outcome = await writeTaskChanges(store, task, { status: to })
        if (!outcome.ok) {
            result.refused++
            continue
        }
        result.moved++
        if (outcome.changed) {
            const { line, before, after, nested } = outcome
            result.writes.push({ document: task.concept, write: { line, before, after, nested } })
        }
    }
    return result
}

export interface RevertResult {
    /** The writes that put the lines back, in the order made: reverting them redoes the move. */
    writes: MovedTask[]
    /** Lines left as they were because they changed after the move, each task and nested task counted. */
    skipped: number
}

/**
 * Put back the lines `writes` changed, last first, as an undo of one card's move does
 * (`undoTaskWrite`): only where a line still reads what the move wrote, so an edit made since is
 * never overwritten. Reverting the result's own writes makes the move again.
 */
export async function revertMoves(store: DocumentStore, writes: readonly MovedTask[]): Promise<RevertResult> {
    const result: RevertResult = { writes: [], skipped: 0 }
    for (const { document, write } of [...writes].reverse()) {
        const outcome = await undoTaskWrite(store, document, write)
        if (!outcome.ok) {
            result.skipped += 1 + write.nested.length
            continue
        }
        result.skipped += outcome.skipped
        const { line, before, after, nested } = outcome
        result.writes.push({ document, write: { line, before, after, nested } })
    }
    return result
}
