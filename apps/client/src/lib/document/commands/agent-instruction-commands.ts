/**
 * **Copy agent instruction** (ADR 0114, ADR 0178): the [[Command]]s that put an [[Agent Instruction]]
 * on the clipboard, for a person to paste to an agent, and the rows that offer the one for a task:
 * the [[Command Menu]]'s while the caret is on a task line, the line menu's on a task's line (a
 * right-click on its checkbox or its words), and the menu of a task a list shows, such as a
 * [[Tasks View]] row. A [[Kanban Board]] card copies one through the same Command, naming its task
 * in the argument, and a lane through its sibling. The board names the lane in the argument, and the
 * Client knows the graph, the clipboard and how to say so, as for a card.
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
import { type AgentReach, formatLaneInstruction, formatTaskInstruction } from '../agent-instruction'
import { taskFingerprint, taskWords } from '../task-reference'
import { bookmarkEditorFor } from '../view/augmentations/bookmarks'
import { type CaretTask, caretTask, taskOnLine } from '../view/caret-task'

/** Copy an [[Agent Instruction]] for a task. The id predates the name, and menus and keybindings hold it. */
export const TASK_COPY_REFERENCE = 'task.copyReference'
/** Copy an [[Agent Instruction]] for the lane `{ concept, status, label, count }` names; a Kanban board runs it. */
export const TASK_COPY_LANE_REFERENCE = 'task.copyLaneReference'

export interface AgentInstructionCommandDeps {
    /** The open graph's id, or null with no graph open. */
    graphId(): string | null
    /**
     * How an agent can reach the open graph, and where `document` is in it (null for no one
     * document). May wait on the person, who is asked once where a local graph's folder is.
     */
    reach(document: string | null): Promise<AgentReach>
    writeClipboard(text: string): Promise<void>
    /** Say what happened: the clipboard shows nothing of its own. */
    notify(text: string, tone: 'info' | 'error'): void
}

/** Put `text` on the clipboard and say so. False when the clipboard refused, which the notice explains. */
async function copyInstruction(text: string, what: string, reach: AgentReach, deps: AgentInstructionCommandDeps): Promise<boolean> {
    try {
        await deps.writeClipboard(text)
    } catch (error) {
        deps.notify(`Could not copy the agent instruction: ${error instanceof Error ? error.message : String(error)}`, 'error')
        return false
    }
    deps.notify(reach.kind === 'browser' ? 'Copied, but an agent cannot reach this graph because it is kept in this browser.' : `Copied an agent instruction for ${what}. Paste it to your agent.`, 'info')
    return true
}

/** Copy the instruction for `task`, and say so. False when nothing was copied: no graph is open, or the clipboard refused. */
export async function copyTaskInstruction(task: CaretTask, deps: AgentInstructionCommandDeps): Promise<boolean> {
    const graphId = deps.graphId()
    if (graphId === null) return false
    const fingerprint = await taskFingerprint(task.label)
    const reach = await deps.reach(task.document)
    const text = formatTaskInstruction({ graphId, document: task.document, line: task.line, fingerprint }, task.label, reach)
    return copyInstruction(text, `"${taskWords(task.label)}"`, reach, deps)
}

/** A lane of a Kanban board, as the board names it: its concept (null on the Graph Kanban), status, name and task count. */
export interface LaneToCopy {
    concept: string | null
    status: TaskStatus
    label: string
    count: number
}

/** Copy the instruction for `lane`, and say so. False when nothing was copied: no graph is open, or the clipboard refused. */
export async function copyLaneInstruction(lane: LaneToCopy, deps: AgentInstructionCommandDeps): Promise<boolean> {
    const graphId = deps.graphId()
    if (graphId === null) return false
    const reach = await deps.reach(null)
    const text = formatLaneInstruction({ graphId, concept: lane.concept, status: lane.status }, { laneLabel: lane.label, count: lane.count }, reach)
    return copyInstruction(text, `the ${lane.label} lane of ${lane.concept ?? 'the Graph Kanban'}`, reach, deps)
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

export function registerAgentInstructionCommands(commands: CommandRegistry, contributions: ContributionRegistry, deps: AgentInstructionCommandDeps): () => void {
    const disposers = [
        commands.register(TASK_COPY_REFERENCE, async (arg) => {
            const task = taskFor(arg)
            if (task) await copyTaskInstruction(task, deps)
        }),
        commands.register(TASK_COPY_LANE_REFERENCE, async (arg) => {
            const lane = namedLane(arg)
            if (lane) await copyLaneInstruction(lane, deps)
        }),
        registerCommandMenuItem(contributions, {
            id: TASK_COPY_REFERENCE,
            title: 'Copy agent instruction',
            detail: 'To hand this task to an agent',
            icon: 'copy',
            group: 'Insert',
            order: 150,
            keywords: ['instruction', 'reference', 'link', 'agent', 'task', 'copy'],
            // Not gated on `bodyWritable`: copying writes nothing to the page.
            when: (ctx) => ctx.taskOnLine === true,
            // It reads the caret's line, so it is offered in a part of a document too (ADR 0170).
            actsOnText: true,
            command: TASK_COPY_REFERENCE,
        }),
        registerContextMenuItem(contributions, {
            id: TASK_COPY_REFERENCE,
            label: 'Copy agent instruction',
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
