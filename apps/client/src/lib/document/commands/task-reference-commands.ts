/**
 * **Copy task reference** (ADR 0114): the [[Command]] that puts a [[Task Reference]] on the
 * clipboard, for a person to paste to an agent connected to the graph, and the rows that offer it:
 * the [[Command Menu]]'s while the caret is on a task line, the line menu's on a task's line (a
 * right-click on its checkbox or its words), and the menu of a task a list shows, such as a
 * [[Tasks View]] row. A [[Kanban Board]] card copies one through the same Command, naming its task
 * in the argument. The text is the same from everywhere (`formatTaskReference`).
 *
 * **Copy lane reference** is its sibling for a whole lane of a Kanban board (a [[Lane Reference]]):
 * the board names the lane in the argument, and the Client knows the graph, the clipboard and how to
 * say so, as for a card.
 */
import {
    type CommandRegistry,
    type ContextMenuTarget,
    type ContributionRegistry,
    editorLineOf,
    isLineTarget,
    isTaskTarget,
    registerCommandMenuItem,
    registerContextMenuItem,
} from '../../surface'
import { getActiveEditorView } from '../active-editor'
import { TASK_STATUSES, type TaskStatus } from '../index-db'
import { formatLaneReference } from '../lane-reference'
import { formatTaskReference, taskFingerprint, taskWords } from '../task-reference'
import { bookmarkEditorFor } from '../view/augmentations/bookmarks'
import { type CaretTask, caretTask, taskOnLine } from '../view/caret-task'

export const TASK_COPY_REFERENCE = 'task.copyReference'
/** Copy a [[Lane Reference]] to the lane `{ concept, status, label, count }` names; a Kanban board runs it. */
export const TASK_COPY_LANE_REFERENCE = 'task.copyLaneReference'

export interface TaskReferenceCommandDeps {
    /** The open graph's id, or null with no graph open. */
    graphId(): string | null
    /** The open graph's name, which tells an agent with several graphs connected which one to use; null when it has none. */
    graphName(): string | null
    writeClipboard(text: string): Promise<void>
    /** Say what happened: the clipboard shows nothing of its own. */
    notify(text: string, tone: 'info' | 'error'): void
}

/**
 * Copy a reference to `task`, and say so. False when nothing was copied: no graph is open, or the
 * clipboard refused, which the notice then explains.
 */
export async function copyTaskReference(task: CaretTask, deps: TaskReferenceCommandDeps): Promise<boolean> {
    const graphId = deps.graphId()
    if (graphId === null) return false
    const fingerprint = await taskFingerprint(task.label)
    const text = formatTaskReference({ graphId, document: task.document, line: task.line, fingerprint }, task.label, { graphName: deps.graphName() })
    try {
        await deps.writeClipboard(text)
    } catch (error) {
        deps.notify(`Could not copy the task reference: ${error instanceof Error ? error.message : String(error)}`, 'error')
        return false
    }
    deps.notify(`Copied a reference to "${taskWords(task.label)}". Paste it to an agent connected to this graph.`, 'info')
    return true
}

/** A lane of a Kanban board, as the board names it: its concept (null on the Graph Kanban), status, name and task count. */
export interface LaneToCopy {
    concept: string | null
    status: TaskStatus
    label: string
    count: number
}

/**
 * Copy a reference to `lane`, and say so. False when nothing was copied: no graph is open, or the
 * clipboard refused, which the notice then explains.
 */
export async function copyLaneReference(lane: LaneToCopy, deps: TaskReferenceCommandDeps): Promise<boolean> {
    const graphId = deps.graphId()
    if (graphId === null) return false
    const text = formatLaneReference({ graphId, concept: lane.concept, status: lane.status }, { graphName: deps.graphName(), laneLabel: lane.label, count: lane.count })
    try {
        await deps.writeClipboard(text)
    } catch (error) {
        deps.notify(`Could not copy the lane reference: ${error instanceof Error ? error.message : String(error)}`, 'error')
        return false
    }
    const board = lane.concept ?? 'the Graph Kanban'
    deps.notify(`Copied a reference to the ${lane.label} lane of ${board}. Paste it to an agent connected to this graph.`, 'info')
    return true
}

/** The lane named in the Command's argument, or null for anything else. */
function namedLane(arg: unknown): LaneToCopy | null {
    const lane = arg as Partial<LaneToCopy> | undefined
    const shaped =
        (typeof lane?.concept === 'string' || lane?.concept === null) &&
        TASK_STATUSES.includes(lane.status as TaskStatus) &&
        typeof lane.label === 'string' &&
        typeof lane.count === 'number'
    return shaped ? { concept: lane.concept ?? null, status: lane.status as TaskStatus, label: lane.label as string, count: lane.count as number } : null
}

/** A task named in the Command's argument, as a Kanban card or a Tasks View row passes it. */
function namedTask(arg: unknown): CaretTask | null {
    const task = arg as Partial<CaretTask> | undefined
    return typeof task?.document === 'string' && typeof task.line === 'number' && typeof task.label === 'string'
        ? { document: task.document, line: task.line, label: task.label }
        : null
}

/**
 * The task on the editor line a menu was raised on (a right-click on a line, or on a link in it),
 * or null when the target is no editor line, its editor has closed, or the line holds no task.
 */
function lineTask(target: ContextMenuTarget): CaretTask | null {
    const line = editorLineOf(target)
    const view = line ? bookmarkEditorFor(line.concept, line.panelId) : null
    return line && view ? taskOnLine(view.state, line.line) : null
}

/**
 * The task a menu was raised on itself: a Tasks View row's, or the one on an editor line a right-click
 * on its checkbox or its words raised the menu on. Not the task under a link or a misspelt word,
 * whose menus are about the link or the word, and none in a [[Protected Document]] or fenced code.
 * What an extension's row offered on every task asks (`context.contextMenu.taskOf`), such as a
 * [[Kanban Board]]'s Open in task editor.
 */
export function menuTargetTask(target: ContextMenuTarget): CaretTask | null {
    if (isTaskTarget(target)) return namedTask(target)
    return isLineTarget(target) ? lineTask(target) : null
}

/** The task the Command acts on: one named in its argument, the one on a menu's line, or the caret's. */
function taskFor(arg: unknown): CaretTask | null {
    const named = namedTask(arg)
    if (named) return named
    if (arg && typeof arg === 'object' && 'kind' in arg) return lineTask(arg as ContextMenuTarget)
    const view = getActiveEditorView()
    return view ? caretTask(view.state) : null
}

export function registerTaskReferenceCommands(commands: CommandRegistry, contributions: ContributionRegistry, deps: TaskReferenceCommandDeps): () => void {
    const disposers = [
        commands.register(TASK_COPY_REFERENCE, async (arg) => {
            const task = taskFor(arg)
            if (task) await copyTaskReference(task, deps)
        }),
        commands.register(TASK_COPY_LANE_REFERENCE, async (arg) => {
            const lane = namedLane(arg)
            if (lane) await copyLaneReference(lane, deps)
        }),
        registerCommandMenuItem(contributions, {
            id: TASK_COPY_REFERENCE,
            title: 'Copy task reference',
            detail: 'To hand this task to an agent',
            icon: 'copy',
            group: 'Tasks',
            order: 150,
            keywords: ['reference', 'link', 'agent', 'task', 'copy'],
            // Not gated on `bodyWritable`: copying writes nothing to the page.
            when: (ctx) => ctx.taskOnLine === true,
            // It reads the caret's line, so it is offered in a part of a document too (ADR 0170).
            actsOnText: true,
            command: TASK_COPY_REFERENCE,
        }),
        registerContextMenuItem(contributions, {
            id: TASK_COPY_REFERENCE,
            label: 'Copy task reference',
            command: TASK_COPY_REFERENCE,
            icon: 'task-reference',
            // On an editor line, ahead of the bookmark rows (90) and Paste (95), after a link's own
            // rows when the right-click was on a link in the task's words.
            order: 85,
            separatorBefore: true,
            when: (target) => isTaskTarget(target) || lineTask(target) !== null,
        }),
    ]
    return () => {
        for (const dispose of disposers) dispose()
    }
}
