/**
 * **Set a task's status or priority from its menu**: the rows a [[Kanban Board]] card's menu has
 * (ADR 0113), on a [[Task]]'s line in the editor (a right-click on its checkbox or its words, or on a
 * link or word in them) and on a row of the [[Tasks View]]. One row per [[Task Status]] and one per
 * priority, leaving out the task's own, each group under a separator its first row shown carries,
 * as the card's menu groups them. The line is written as a board move writes it (`taskLineWith`),
 * and a write that makes the task Done or Archived, or unticks it, brings the tasks nested under it
 * along (`task-cascade.ts`).
 *
 * The two places write differently:
 *
 * - **In the editor** the change is one transaction in that editor (`view/task-change.ts`), so the
 *   line shows it at once and Mod+Z takes it back, nested tasks and all, as one step, as a checkbox
 *   click's tick does. It is written only while the line still reads what it did when the menu
 *   opened (the target's `text`): a peer's edit or a reload may have moved another task there.
 * - **A Tasks View row**'s task is written into its document through the store
 *   (`writeTaskChanges`), which finds the task first because the index the row came from can lag
 *   the document. That write is outside every editor's undo, and the row only shows the new status
 *   and priority once the index catches up, so a notice says what changed and offers Undo, and the
 *   row is told whether the task is now ticked (`written`), which it holds as it holds a tick.
 */
import type { EditorView } from '@codemirror/view'

import {
    type CommandRegistry,
    type ContextMenuTarget,
    type ContributionRegistry,
    editorLineOf,
    isTaskTarget,
    registerContextMenuItem,
} from '../../surface'
import { showNotice } from '#lib/activity/notices.js'

import { showTaskChangeNotice, TASK_CASCADE_NOTICE } from '../task-cascade-notice'
import { STATUS_OPTIONS } from '../task-filter-labels'
import { taskWords } from '../task-reference'
import { parseTaskLine, parseTaskTags, type TaskChanges, type TaskPriority, taskStatus, type TaskStatus } from '../task-tags'
import { type IndexedTask, undoTaskWrite, writeTaskChanges } from '../task-write'
import type { DocumentStore } from '../types'
import { bookmarkEditorFor } from '../view/augmentations/bookmarks'
import { bodyWritable } from '../view/body-writable'
import { bodyTaskOnLine } from '../view/caret-task'
import { taskChangeSpec } from '../view/task-change'

export interface TaskStatusCommandDeps {
    /** The open graph's store, which a Tasks View row's task is written through; null with no graph open. */
    store(): DocumentStore | null
}

/** The priorities a row sets, highest first, then none: the Kanban card's sections, in its order. */
const PRIORITIES: ReadonlyArray<{ priority: TaskPriority | null; label: string }> = [
    { priority: 1, label: 'P1' },
    { priority: 2, label: 'P2' },
    { priority: 3, label: 'P3' },
    { priority: null, label: 'No priority' },
]

/** The Command a status row runs: `task.setStatus.<status>`. */
export function taskStatusCommand(status: TaskStatus): string {
    return `task.setStatus.${status}`
}

/** The Command a priority row runs: `task.setPriority.<1|2|3|none>`. */
export function taskPriorityCommand(priority: TaskPriority | null): string {
    return `task.setPriority.${priority ?? 'none'}`
}

/** A task a menu was raised on, where it is, and the status and priority it has now. */
type MenuTask = { status: TaskStatus; priority: TaskPriority | null } & (
    | { in: 'editor'; view: EditorView; number: number; text: string }
    | { in: 'store'; task: IndexedTask; label: string; written?: (done: boolean) => void }
)

/** What a row says it did: the task's status or priority as it now stands, by the task's words. */
type Said = (words: string, changed: boolean) => string

/**
 * The task `target` names: a Tasks View row's, or the one on the editor line a menu was raised on
 * (the line itself, or the line under a link or a misspelt word). Null when there is none, and in an
 * editor that would drop the edit: read-only, or a locked [[Protected Document]].
 */
function menuTask(target: ContextMenuTarget): MenuTask | null {
    if (isTaskTarget(target)) {
        const tags = parseTaskTags(target.label)
        const { document, line, label, done, written } = target
        return { in: 'store', task: { concept: document, line, text: label }, label, written, status: taskStatus(done, tags), priority: tags.priority }
    }
    const line = editorLineOf(target)
    const view = line ? bookmarkEditorFor(line.concept, line.panelId) : null
    if (!line || !view || view.state.readOnly || !bodyWritable(view.state) || !bodyTaskOnLine(view.state, line.line)) return null
    const parsed = parseTaskLine(line.text)
    return parsed && { in: 'editor', view, number: line.line, text: line.text, status: taskStatus(parsed.done, parsed), priority: parsed.priority }
}

/**
 * Whether the editor line `target` was raised on reads otherwise now than when the menu opened: a
 * peer's edit or a reload moved another line there, or took it away. The menu's rows were chosen
 * for what it read then, so none of them writes to it.
 */
function lineChanged(target: ContextMenuTarget): boolean {
    const line = editorLineOf(target)
    const view = line ? bookmarkEditorFor(line.concept, line.panelId) : null
    if (!line || !view) return false
    const { doc } = view.state
    return line.line > doc.lines || doc.line(line.line).text !== line.text
}

/**
 * Write `changes` to a Tasks View row's task in its document, and say what happened, with Undo. A
 * task already as asked is said too: the row may show it otherwise until the index catches up.
 */
async function writeThroughStore(store: DocumentStore, task: Extract<MenuTask, { in: 'store' }>, changes: TaskChanges, said: Said): Promise<void> {
    const { concept } = task.task
    const words = taskWords(task.label)
    const outcome = await writeTaskChanges(store, task.task, changes)
    if (!outcome.ok) {
        const text =
            outcome.reason === 'missing'
                ? `"${concept}" was renamed or deleted after the list was read, so "${words}" was not changed.`
                : `"${words}" changed after the list was read, so nothing was written. Try again once the list shows it as it is now.`
        showNotice({ id: TASK_CASCADE_NOTICE, tone: 'error', text })
        return
    }
    task.written?.(parseTaskLine(outcome.after)?.done ?? false)
    if (!outcome.changed) {
        showNotice({ id: TASK_CASCADE_NOTICE, tone: 'info', text: said(words, false) })
        return
    }
    const write = { line: outcome.line, before: outcome.before, after: outcome.after, nested: outcome.nested }
    showTaskChangeNotice(words, said(words, true), write, async () => {
        const undone = await undoTaskWrite(store, concept, write)
        // Back as it was: the row holds the earlier state until the index says the same.
        if (undone.ok) task.written?.(parseTaskLine(write.before)?.done ?? false)
        return undone
    })
}

/** The menu target a row's Command was run with, or null when it was run some other way. */
function menuTarget(arg: unknown): ContextMenuTarget | null {
    return arg && typeof arg === 'object' && 'kind' in arg ? (arg as ContextMenuTarget) : null
}

/** Make `changes` to the task on an editor line, as one transaction (`view/task-change.ts`). */
function writeInEditor(task: Extract<MenuTask, { in: 'editor' }>, changes: TaskChanges): void {
    const spec = taskChangeSpec(task.view.state, task.number, task.text, changes)
    if (spec) task.view.dispatch(spec)
}

export function registerTaskStatusCommands(commands: CommandRegistry, contributions: ContributionRegistry, deps: TaskStatusCommandDeps): () => void {
    /** Run `changes` on the task the menu was raised on, wherever it lives. */
    const apply = async (arg: unknown, changes: TaskChanges, said: Said) => {
        const target = menuTarget(arg)
        if (!target) return
        if (lineChanged(target)) {
            showNotice({ id: TASK_CASCADE_NOTICE, tone: 'error', text: 'That line changed while the menu was open, so nothing was written. Open the menu again to change it.' })
            return
        }
        const task = menuTask(target)
        if (task?.in === 'editor') writeInEditor(task, changes)
        const store = task?.in === 'store' ? deps.store() : null
        if (task?.in === 'store' && store) await writeThroughStore(store, task, changes, said)
    }
    const disposers: Array<() => void> = []

    // On an editor line these follow Copy task reference (85) and come before the bookmark rows (90).
    const firstOtherStatus = (target: ContextMenuTarget) => STATUS_OPTIONS.find((option) => option.value !== menuTask(target)?.status)?.value
    for (const [index, { value: status, label }] of STATUS_OPTIONS.entries()) {
        const id = taskStatusCommand(status)
        disposers.push(
            commands.register(id, (arg) => apply(arg, { status }, (words, changed) => `"${words}" is ${changed ? 'now' : 'already'} ${label}.`)),
            registerContextMenuItem(contributions, {
                id,
                // Archived is how a finished task is put away, as a Kanban card's Archive row says.
                label: status === 'archived' ? 'Archive' : `Mark as ${label}`,
                // The box a Kanban card's Archive row and the Task Editor's button show too.
                ...(status === 'archived' ? { icon: 'archive' } : {}),
                command: id,
                order: 86 + index / 10,
                separatorBefore: (target) => firstOtherStatus(target) === status,
                when: (target) => {
                    const task = menuTask(target)
                    return task !== null && task.status !== status
                },
            }),
        )
    }

    const firstOtherPriority = (target: ContextMenuTarget) => PRIORITIES.find((option) => option.priority !== menuTask(target)?.priority)
    for (const [index, option] of PRIORITIES.entries()) {
        const { priority, label } = option
        const id = taskPriorityCommand(priority)
        disposers.push(
            commands.register(id, (arg) =>
                apply(arg, { priority }, (words, changed) => {
                    const when = changed ? 'now' : 'already'
                    return priority === null ? `"${words}" ${when} has no priority.` : `"${words}" is ${when} ${label}.`
                }),
            ),
            registerContextMenuItem(contributions, {
                id,
                label: priority === null ? label : `Priority ${label}`,
                command: id,
                order: 87 + index / 10,
                separatorBefore: (target) => firstOtherPriority(target) === option,
                when: (target) => {
                    const task = menuTask(target)
                    return task !== null && task.priority !== priority
                },
            }),
        )
    }
    return () => {
        for (const dispose of disposers) dispose()
    }
}
