/**
 * **Copy task reference** (ADR 0114): the [[Command]] that puts a [[Task Reference]] on the
 * clipboard, for a person to paste to an agent connected to the graph, and its [[Command Menu]]
 * row, offered while the caret is on a task line. A [[Kanban Board]] card's menu copies one through
 * the same Command, naming its task in the argument.
 */
import { getActiveEditorView } from '../active-editor'
import { formatTaskReference, taskFingerprint, taskWords } from '../task-reference'
import { type CaretTask, caretTask } from '../view/caret-task'
import { type CommandRegistry, type ContributionRegistry, registerCommandMenuItem } from '../../surface'

export const TASK_COPY_REFERENCE = 'task.copyReference'

export interface TaskReferenceCommandDeps {
    /** The open graph's id, or null with no graph open. */
    graphId(): string | null
    /** The Client's origin, so the reference is an address a person can open. */
    origin(): string
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
    const text = formatTaskReference({ graphId, document: task.document, line: task.line, fingerprint }, task.label, deps.origin())
    try {
        await deps.writeClipboard(text)
    } catch (error) {
        deps.notify(`Could not copy the task reference: ${error instanceof Error ? error.message : String(error)}`, 'error')
        return false
    }
    deps.notify(`Copied a reference to "${taskWords(task.label)}". Paste it to an agent connected to this graph.`, 'info')
    return true
}

/** A task named in the Command's argument, as a board card's menu passes it. */
function taskArg(arg: unknown): CaretTask | null {
    const task = arg as Partial<CaretTask> | undefined
    return typeof task?.document === 'string' && typeof task.line === 'number' && typeof task.label === 'string'
        ? { document: task.document, line: task.line, label: task.label }
        : null
}

export function registerTaskReferenceCommands(commands: CommandRegistry, contributions: ContributionRegistry, deps: TaskReferenceCommandDeps): () => void {
    const disposers = [
        commands.register(TASK_COPY_REFERENCE, async (arg) => {
            const view = getActiveEditorView()
            const task = taskArg(arg) ?? (view ? caretTask(view.state) : null)
            if (task) await copyTaskReference(task, deps)
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
            command: TASK_COPY_REFERENCE,
        }),
    ]
    return () => {
        for (const dispose of disposers) dispose()
    }
}
