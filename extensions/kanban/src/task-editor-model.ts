/**
 * The [[Task Editor]]'s choices and checks (ADR 0170), framework-free so they are tested in Node: the
 * priority chips and their colours, what a typed [[Free Tag]] must be, when a new task counts as
 * untouched, and the document a new task's description is written in before the task exists.
 */
import { priorityColour } from '#lib/document/task-priority-colour.js'
import { isFreeTagWord, type TaskPriority, type TaskStatus } from '#lib/document/task-tags.js'
import type { TaskWriteOutcome } from '#lib/document/task-write.js'
import type { ChangeOrigin, DocumentListener, EditorDocument, TextChange } from '#lib/document/types.js'

/** The priority chips, None first and then the most pressing, each priority in its colour. */
export const PRIORITY_CHOICES: ReadonlyArray<{ priority: TaskPriority | null; label: string; colour: string | null }> = [
    { priority: null, label: 'None', colour: null },
    { priority: 1, label: 'P1', colour: priorityColour(1) },
    { priority: 2, label: 'P2', colour: priorityColour(2) },
    { priority: 3, label: 'P3', colour: priorityColour(3) },
]

/** The two dated task tags the editor sets, each a field of its own: `#D-YYYY-MM-DD` and `#S-YYYY-MM-DD`. */
export type DateField = 'due' | 'scheduled'

/** The date fields in the order they show, Due first, with the tag each one writes for its hint. */
export const DATE_FIELDS: ReadonlyArray<{ field: DateField; label: string; tag: string }> = [
    { field: 'due', label: 'Due', tag: '#D-' },
    { field: 'scheduled', label: 'Scheduled', tag: '#S-' },
]

/** A tag as typed, without the `#` a person may type first. */
export function readFreeTag(input: string): string {
    return input.trim().replace(/^#/, '')
}

/** Letters and digits, in words joined by single hyphens: a Free Tag's shape (ADR 0166). */
const TAG_SHAPE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/

/**
 * Why `tag` (read by {@link readFreeTag}) cannot be added to a task with `existing` Free Tags, or null
 * when it can. Said at the field, so the words say what to type instead.
 */
export function freeTagProblem(tag: string, existing: readonly string[]): string | null {
    if (tag === '') return 'Type a tag first.'
    if (!TAG_SHAPE.test(tag)) return 'A tag is letters and digits, with single hyphens between words: no spaces or other marks.'
    if (!/[A-Za-z]/.test(tag)) return 'A tag needs at least one letter.'
    if (!isFreeTagWord(tag)) return 'That is a task tag (a priority, state or date), which the lane, priority and date fields above set.'
    if (existing.some((written) => written.toLowerCase() === tag.toLowerCase())) return 'The task has that tag already.'
    return null
}

/** The fields a new task is made from. */
export interface NewTaskFields {
    title: string
    status: TaskStatus
    priority: TaskPriority | null
    freeTags: readonly string[]
    /** `YYYY-MM-DD`, or null for none. */
    due: string | null
    /** `YYYY-MM-DD`, or null for none. */
    scheduled: string | null
}

/** The text a new task's description starts with: one empty bullet to type in. */
export const EMPTY_DESCRIPTION = '- '

/**
 * Whether a new task has nothing in it to lose: nothing typed, nothing chosen but the lane it was
 * started in. Closing an untouched one asks nothing.
 */
export function isUntouched(fields: NewTaskFields, startedIn: TaskStatus, description: string): boolean {
    return (
        fields.title.trim() === '' &&
        fields.status === startedIn &&
        fields.priority === null &&
        fields.freeTags.length === 0 &&
        fields.due === null &&
        fields.scheduled === null &&
        (description.trim() === '' || description.trim() === EMPTY_DESCRIPTION.trim())
    )
}

/**
 * A document held in memory: where a new task's description is written before the task exists. The
 * editor on it works as on any document, assets uploaded into it included, and creating the task
 * writes its text into today's journal entry. Like a store's document, it tells its listeners of each
 * change but the one the editor that made it names.
 */
export function createHeldDocument(text: string): EditorDocument {
    let buffer = text
    const listeners = new Set<DocumentListener>()
    return {
        id: 'task-editor-description',
        getText: () => buffer,
        applyChange(change: TextChange, _origin?: ChangeOrigin, editor?: DocumentListener) {
            buffer = buffer.slice(0, change.from) + change.insert + buffer.slice(change.to)
            for (const listener of [...listeners]) if (listener !== editor) listener(buffer)
        },
        subscribe(listener: DocumentListener) {
            listeners.add(listener)
            return () => void listeners.delete(listener)
        },
    }
}

/**
 * An existing task the Task Editor opens on: a card's, or the one a task's line in an editor or a
 * Tasks View row names. `line` is body-relative and `text` the line's label, as the index has them.
 */
export type TaskEditorEdit = { kind: 'edit'; document: string; line: number; text: string }

/** What the Task Editor opens on: a new task in a lane, or an existing task. */
export type TaskEditorStart = { kind: 'new'; status: TaskStatus } | TaskEditorEdit

/** A task archived from the Task Editor, which the board offers to undo as it does its own moves. */
export interface ArchivedTask {
    document: string
    label: string
    status: TaskStatus
    priority: TaskPriority | null
    outcome: Extract<TaskWriteOutcome, { ok: true }>
}
