/**
 * An [[Agent Instruction]] (ADR 0178): the few lines a person copies from a task or a lane to hand
 * it to an agent. They name where the task or lane is from, carry its [[Task Reference]] or
 * [[Lane Reference]], and say how to reach the graph. That last part depends on the graph, not on
 * the View it was copied from:
 *
 * - A synced graph is reached only through the [[Headless Client]]. An agent without it has nothing
 *   to read, so it is told to stop: searching the disk finds the sign-in rather than the notes, and
 *   a [[Local Mirror]] is overwritten.
 * - A [[Local Graph]] is plain files, so the [[Headless Client]] is optional. The agent gets the
 *   file, and finds the task by its words. A reference counts body lines and a file also holds
 *   frontmatter, so no line number is given.
 * - A graph in the browser's private storage, such as the [[Demo Graph]], is out of an agent's reach.
 *
 * The Headless Client reads the reference out of the whole text, so a variant can add lines around
 * it without an installed version noticing.
 */
import { joinGraphPath } from '../storage/fs/folder-path'
import type { Subdir } from '../storage/fs/directory-adapter'
import type { TaskStatus } from './index-db'
import { laneReferenceId, type LaneReference } from './lane-reference'
import { parseTaskTags } from './task-tags'
import { taskReferenceId, type TaskReference } from './task-reference'

/** A document's file inside its graph folder. */
export interface GraphFile {
    subdir: Subdir
    fileName: string
}

/** How an agent can reach the open graph, which decides what an instruction tells it. */
export type AgentReach =
    /**
     * `graphName` tells an agent with several EtherPK servers which one to use; null when it has
     * none. `agentsUrl` is this graph's Agents tab, where the person finds how to connect an agent.
     */
    | { kind: 'synced'; graphName: string | null; agentsUrl: string }
    /**
     * A folder on disk. `folderPath` is null when the person has not said where it is (the browser
     * cannot), and `file` when the document has no file to name, as for a whole lane.
     */
    | { kind: 'folder'; folderName: string; folderPath: string | null; file: GraphFile | null }
    | { kind: 'browser'; graphName: string | null; agentsUrl: string }

/** A lane as its board shows it when copied. */
export interface LaneShown {
    laneLabel: string
    count: number
}

const NOT_AN_ADDRESS = 'This is not a web address.'

/** For an agent to pass on: signing in needs a code from the person, so it cannot set itself up. */
function noServer(agentsUrl: string): string {
    return `If you have no EtherPK MCP server for this graph, stop. Do not search this device for it or work from a folder copy, which EtherPK overwrites. Tell the user to connect you from the Agents tab in EtherPK's Settings, which they can open at ${agentsUrl}`
}

function outOfReach(agentsUrl: string): string {
    return `This graph is kept inside this browser, so an agent cannot reach it. Tell the user that the Agents tab in EtherPK's Settings explains how to work with an agent. They can open it at ${agentsUrl}`
}

/**
 * The task as the copied text shows it: the text after the tag run, whitespace collapsed, with its
 * [[Free Tag]]s where they were written. A tag can be part of a sentence ("e.g. #bug."), and an
 * agent reads this line as the request.
 */
function taskTextAsWritten(label: string): string {
    return (parseTaskTags(label).text || label).normalize('NFC').replace(/\s+/g, ' ').trim()
}

/** The graph as the first line names it. A folder's id differs per browser, so it goes by its folder's name. */
function graphSource(graphId: string, reach: AgentReach): string {
    if (reach.kind === 'folder') return `the graph folder "${reach.folderName}"`
    if (reach.kind === 'browser') return reach.graphName ? `the graph "${reach.graphName}"` : 'a graph in this browser'
    return reach.graphName ? `the graph "${reach.graphName}" (${graphId})` : `the graph ${graphId}`
}

/** The lines that say how to use the tools on a synced graph, and to stop without them. */
function syncedLines(reach: Extract<AgentReach, { kind: 'synced' }>, tools: string): string[] {
    return [`${NOT_AN_ADDRESS} Use the EtherPK MCP server connected to ${reach.graphName ? `"${reach.graphName}"` : 'that graph'}: ${tools}`, noServer(reach.agentsUrl)]
}

/** A sentence that opens with the tools for a local graph, which an agent may or may not have. */
function folderToolsSentence(tools: string): string {
    return `${NOT_AN_ADDRESS} If an EtherPK MCP server for this graph is connected, use it: ${tools}`
}

const TASK_TOOLS = 'read_task with this whole text to read the task and its detail, set_task if you are asked to change its status, add_task_note to record what you did.'

/** The line that says where a local task is, when anything is known about that. */
function fileLine(reach: Extract<AgentReach, { kind: 'folder' }>): string[] {
    const { file, folderPath } = reach
    if (file && folderPath) return [`File: ${joinGraphPath(folderPath, file.subdir, file.fileName)}`]
    if (file) return [`File: ${file.subdir}/${file.fileName}, inside the graph folder`]
    return folderPath ? [`Folder: ${folderPath}`] : []
}

/** The text a person copies from a task. The same wherever it is copied from: a task is a task, whichever View showed it. */
export function formatTaskInstruction(reference: TaskReference, label: string, reach: AgentReach): string {
    const head = [`EtherPK task from ${graphSource(reference.graphId, reach)}`, `Task: ${taskTextAsWritten(label)}`]
    const line = `Reference: ${taskReferenceId(reference)}`
    if (reach.kind === 'browser') return [...head, outOfReach(reach.agentsUrl)].join('\n')
    if (reach.kind === 'synced') return [...head, line, ...syncedLines(reach, TASK_TOOLS)].join('\n')
    const find = reach.file ? 'Otherwise open the file and find the task by its words. If it is not there, search the graph folder.' : 'Otherwise search the graph folder for the task by its words.'
    const rest = 'If none or several match, ask the user. Follow AGENTS.md at the top of the graph folder, and change the status only if you are asked.'
    return [...head, ...fileLine(reach), line, `${folderToolsSentence(TASK_TOOLS)} ${find} ${rest}`].join('\n')
}

/** Which tasks a lane holds, by the checkbox and [[Task Tag]]s an agent reading the files sees. */
export function laneSelectionInFiles(status: TaskStatus): string {
    const selections: Record<TaskStatus, string> = {
        open: 'unticked tasks with no #W, #D or #T',
        doing: 'unticked tasks tagged #D',
        waiting: 'unticked tasks tagged #W',
        test: 'unticked tasks tagged #T',
        done: 'ticked tasks with no #C or #A',
        cancelled: 'ticked tasks tagged #C',
        archived: 'ticked tasks tagged #A',
    }
    return selections[status]
}

/**
 * The text a person copies from a lane. An agent does not know the reference format, so it says
 * which `tasks` call lists the lane, the same query the board reads it with, and that the whole
 * text can be passed instead. Membership of a lane comes from the index, so a local agent without
 * the tools gets the selection in words, which stays true whatever has moved since.
 */
export function formatLaneInstruction(reference: LaneReference, lane: LaneShown, reach: AgentReach): string {
    const { concept, status, graphId } = reference
    const head = [
        `EtherPK Kanban lane from ${graphSource(graphId, reach)}`,
        `Board: ${concept ?? 'Graph Kanban'}`,
        `Lane: ${lane.laneLabel} (${lane.count === 1 ? '1 task' : `${lane.count} tasks`})`,
    ]
    const line = `Reference: ${laneReferenceId(reference)}`
    if (reach.kind === 'browser') return [...head, outOfReach(reach.agentsUrl)].join('\n')
    const statuses = JSON.stringify([status])
    const query = concept === null ? `tasks with statuses ${statuses}` : `tasks with concept ${JSON.stringify(concept)} and statuses ${statuses}`
    const tools = `${query} lists the lane's tasks (or pass this whole text as reference); read_task, set_task and add_task_note work on each task.`
    if (reach.kind === 'synced') return [...head, line, ...syncedLines(reach, tools)].join('\n')
    const selection = laneSelectionInFiles(status)
    const find =
        concept === null
            ? `Otherwise, in the graph folder, find the ${selection}. Follow AGENTS.md at the top of the folder.`
            : `Otherwise, in the graph folder, find the ${selection} that are about [[${concept}]]. AGENTS.md at the top of the folder says what makes a task about a concept.`
    return [...head, ...fileLine(reach), line, `${folderToolsSentence(tools)} ${find}`].join('\n')
}
