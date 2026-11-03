/**
 * What the [[Task Editor]] reads and writes (ADR 0170), through the graph's store. Framework-free, so
 * it is tested in Node.
 *
 * Every write starts from the task as the editor last read it (`ReadTask`: its document, its line and
 * the whole line as it read then). The task is found as any task write finds it, by its line or its
 * words, so lines added above it are no reason to refuse; but a task line that reads otherwise now
 * (another member, an agent or the board changed it) is never written over, and the editor says so
 * and offers to read the task again. Writes are `external` changes, so every editor open on the
 * document, the Task Editor's own description and comments included, shows them land.
 */
import { bulletLabel } from '#lib/document/index-derive.js'
import { findIndexedTask, type FoundTask, type ReadTask, rewriteTaskLine } from '#lib/document/task-write.js'
import { asCommentBullet, commentChange, readTaskStructure, taskRemoval, type TaskStructure } from '#lib/document/task-structure.js'
import type { TaskPriority, TaskStatus } from '#lib/document/task-tags.js'
import type { DocumentStore } from '#lib/document/types.js'

export type { ReadTask }

/** Why a write was not made: the task line reads otherwise now (`stale`), or its document is gone. */
export type Refusal = { ok: false; reason: 'stale' | 'missing' }

/** What the Task Editor's fields show for a task, read from its text. */
export interface TaskFields {
    title: string
    status: TaskStatus
    priority: TaskPriority | null
    freeTags: string[]
    /** The due date, `YYYY-MM-DD`, or null. */
    due: string | null
    /** The scheduled date, `YYYY-MM-DD`, or null. */
    scheduled: string | null
    /** Whether anything is nested under the task above its Comments bullet. */
    hasDescription: boolean
    /** Whether the task has a Comments bullet. */
    hasComments: boolean
    /** Whether lines are nested under the task below its Comments block: its additional context. */
    hasAdditionalContext: boolean
    /** The assets every line nested under the task shows: its description, its comments and below them. */
    assets: string[]
}

function fieldsOf(structure: TaskStructure): TaskFields {
    return {
        title: structure.title,
        status: structure.status,
        priority: structure.priority,
        freeTags: structure.freeTags,
        due: structure.due,
        scheduled: structure.scheduled,
        hasDescription: structure.description.to > structure.description.from,
        hasComments: structure.commentsLine !== null,
        hasAdditionalContext: structure.additionalContext !== null,
        assets: structure.assets,
    }
}

/** A task found in its document, with its structure, or why it was not. */
type Found = (FoundTask & { structure: TaskStructure }) | { reason: 'stale' | 'missing' }

/** The task found in its document, with its structure. */
async function found(store: DocumentStore, task: { concept: string; line: number; text: string }): Promise<Found> {
    const at = await findIndexedTask(store, task)
    if ('reason' in at) return at
    const structure = readTaskStructure(at.lines, at.index)
    return structure ? { ...at, structure } : ({ reason: 'stale' } as const)
}

/** The task a card or a new task names, read: where it is now, its line, and its fields. */
export async function readEditedTask(
    store: DocumentStore,
    target: { document: string; line: number; text: string },
): Promise<{ ok: true; task: ReadTask; fields: TaskFields } | Refusal> {
    const at = await found(store, { concept: target.document, line: target.line, text: target.text })
    if ('reason' in at) return { ok: false, reason: at.reason }
    return { ok: true, task: { concept: target.document, line: at.index - at.bodyStart, expected: at.lines[at.index] }, fields: fieldsOf(at.structure) }
}

/**
 * Rewrite the task's line with `rewrite` while it reads as it was read, and say where it is now and
 * how it reads, which the next write starts from.
 */
export async function saveTaskLine(store: DocumentStore, task: ReadTask, rewrite: (line: string) => string | null): Promise<{ ok: true; task: ReadTask } | Refusal> {
    const outcome = await rewriteTaskLine(store, task, rewrite)
    if (!outcome.ok) return outcome
    return { ok: true, task: { concept: task.concept, line: outcome.line, expected: outcome.after } }
}

/** The task as it was read, found again, or why not: its line must still read as it did. */
async function foundAsRead(store: DocumentStore, task: ReadTask): Promise<Found> {
    const at = await found(store, { concept: task.concept, line: task.line, text: bulletLabel(task.expected) })
    if ('reason' in at) return at
    return at.lines[at.index] === task.expected ? at : ({ reason: 'stale' } as const)
}

/** Add `text` as the task's last [[Task Comment]], starting its Comments bullet when it has none. */
export async function addComment(store: DocumentStore, task: ReadTask, text: string): Promise<{ ok: true } | Refusal> {
    const at = await foundAsRead(store, task)
    if ('reason' in at) return { ok: false, reason: at.reason }
    const change = commentChange(at.lines.join('\n'), at.index, asCommentBullet(text))
    if (!change) return { ok: false, reason: 'stale' }
    at.document.applyChange({ from: change.from, to: change.to, insert: change.insert }, 'external')
    return { ok: true }
}

/** Start an empty bullet at the end of the task's description, above its comments, to type in. */
export async function addDescriptionLine(store: DocumentStore, task: ReadTask): Promise<{ ok: true } | Refusal> {
    const at = await foundAsRead(store, task)
    if ('reason' in at) return { ok: false, reason: at.reason }
    const { description, childIndent } = at.structure
    const after = description.to - 1
    const offset = at.lines.slice(0, after + 1).reduce((sum, line) => sum + line.length + 1, 0) - 1
    at.document.applyChange({ from: offset, to: offset, insert: `\n${childIndent}- ` }, 'external')
    return { ok: true }
}

/** How much text either side of a deleted task an undo checks before putting it back. */
const CONTEXT = 80

/** A deleted task, as an undo puts it back: the text, and the text either side of where it was. */
export interface RemovedTask {
    concept: string
    from: number
    removed: string
    before: string
    after: string
}

/** Take the task and everything nested under it out of its document, keeping what an undo needs. */
export async function deleteTask(store: DocumentStore, task: ReadTask): Promise<{ ok: true; removed: RemovedTask } | Refusal> {
    const at = await foundAsRead(store, task)
    if ('reason' in at) return { ok: false, reason: at.reason }
    const text = at.lines.join('\n')
    const removal = taskRemoval(text, at.index)
    if (!removal) return { ok: false, reason: 'stale' }
    at.document.applyChange({ from: removal.from, to: removal.to, insert: '' }, 'external')
    const rest = text.slice(0, removal.from) + text.slice(removal.to)
    return {
        ok: true,
        removed: {
            concept: task.concept,
            from: removal.from,
            removed: removal.removed,
            before: rest.slice(Math.max(0, removal.from - CONTEXT), removal.from),
            after: rest.slice(removal.from, removal.from + CONTEXT),
        },
    }
}

/**
 * Put a deleted task back: where it was, or, when lines were added or taken out elsewhere, where the
 * text either side of it is found once. Refused when that text is not found, since the task would
 * otherwise land among lines that changed since.
 */
export async function restoreTask(store: DocumentStore, removed: RemovedTask): Promise<{ ok: true } | Refusal> {
    let document
    try {
        await store.whenReady?.(removed.concept)
        document = store.open(removed.concept)
    } catch {
        return { ok: false, reason: 'missing' }
    }
    const text = document.getText()
    const around = removed.before + removed.after
    const inPlace = text.slice(removed.from - removed.before.length, removed.from + removed.after.length) === around
    const first = text.indexOf(around)
    const once = first >= 0 && text.indexOf(around, first + 1) < 0
    if (!inPlace && !once) return { ok: false, reason: 'stale' }
    const at = inPlace ? removed.from : first + removed.before.length
    document.applyChange({ from: at, to: at, insert: removed.removed }, 'external')
    return { ok: true }
}
