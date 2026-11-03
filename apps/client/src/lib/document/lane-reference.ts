/**
 * A [[Lane Reference]]: what a person copies from a lane of a [[Kanban Board]] to hand an agent
 * every task in it, to work through or to triage. A few lines: the graph by name and id, the board,
 * the lane and how many tasks it holds, the reference itself, and how an agent lists the tasks. The
 * reference is the board's address under the `etherpk:` scheme with the lane's [[Task Status]] as
 * the fragment: `etherpk:/g/<graph>/k/<concept>#lane=<status>`, or `etherpk:/g/<graph>/kanban#lane=…`
 * for the Graph Kanban. Like a [[Task Reference]] it is not a web address, and nothing is written
 * into a document to make one.
 *
 * It names a selection rather than tasks: the tasks that answer to the board's concept (every task,
 * on the Graph Kanban) with that status, which is the query the board reads its lane with. So an
 * agent listing it with the Headless Client's `tasks` sees what the lane shows when it reads it,
 * whatever moved in or out since it was copied.
 *
 * The board addresses are the Kanban extension's (its manifest's `k` and `kanban` segments, ADR
 * 0121), written out here because the Headless Client, which reads a reference, has no manifest;
 * the extension's own tests check the two agree.
 *
 * Framework-free, and shared with the Headless Client through the `#lib` alias.
 */
import { encodeConceptPath } from '../navigation/concept-path'
import { TASK_STATUSES, type TaskStatus } from './index-db'

export interface LaneReference {
    graphId: string
    /** The board's concept, or null for the Graph Kanban, the board of every task in the graph. */
    concept: string | null
    status: TaskStatus
}

export interface LaneReferenceContext {
    /** The graph's name, which tells an agent with several EtherPK servers which one to use; null when it has none. */
    graphName: string | null
    /** The lane's name on the board: `Doing`. */
    laneLabel: string
    /** How many tasks the lane holds as it is copied. */
    count: number
}

/** The scheme that marks a reference as EtherPK's own, and not a web address to fetch. */
const SCHEME = 'etherpk:'

/** The board's address: the Kanban extension's, `/g/<graph>/k/<concept>` or `/g/<graph>/kanban`. */
function boardPath(graphId: string, concept: string | null): string {
    const graph = `/g/${encodeURIComponent(graphId)}`
    return concept === null ? `${graph}/kanban` : `${graph}/k/${encodeConceptPath(concept)}`
}

/** The reference as an agent is handed it: `etherpk:`, the board's address and the lane. */
export function laneReferenceId(reference: LaneReference): string {
    return `${SCHEME}${boardPath(reference.graphId, reference.concept)}#lane=${reference.status}`
}

/**
 * The text a person copies. An agent does not know the reference format, so the last line says
 * which `tasks` call lists the lane, the same query the board reads it with, and that the whole
 * text can be passed instead.
 */
export function formatLaneReference(reference: LaneReference, context: LaneReferenceContext): string {
    const { graphName, laneLabel, count } = context
    const graph = graphName ? `the graph "${graphName}" (${reference.graphId})` : `the graph ${reference.graphId}`
    const server = graphName ? `"${graphName}"` : 'that graph'
    const statuses = JSON.stringify([reference.status])
    const query = reference.concept === null ? `tasks with statuses ${statuses}` : `tasks with concept ${JSON.stringify(reference.concept)} and statuses ${statuses}`
    return [
        `EtherPK Kanban lane from ${graph}`,
        `Board: ${reference.concept ?? 'Graph Kanban'}`,
        `Lane: ${laneLabel} (${count === 1 ? '1 task' : `${count} tasks`})`,
        `Reference: ${laneReferenceId(reference)}`,
        `This is not a web address. Use the EtherPK MCP server connected to ${server}: ${query} lists the lane's tasks (or pass this whole text as reference); read_task, set_task and add_task_note work on each task.`,
    ].join('\n')
}

/** `/g/<graph>/k/<concept>#lane=<status>` or `/g/<graph>/kanban#lane=<status>`, the scheme before it optional. */
const LANE_REFERENCE = /(?:etherpk:)?\/g\/([^/?#\s]+)\/(?:k\/([^?#\s]+?)|kanban)#lane=([a-z]+)(?![a-z])/

/**
 * The lane reference in `input`: the text as copied, or the `etherpk:` reference alone; null when
 * `input` holds none, or names a lane that is no task status.
 */
export function parseLaneReference(input: string): LaneReference | null {
    const match = LANE_REFERENCE.exec(input)
    if (!match) return null
    const [, graph, path, status] = match
    if (!TASK_STATUSES.includes(status as TaskStatus)) return null
    try {
        return {
            graphId: decodeURIComponent(graph),
            concept: path === undefined ? null : path.split('/').map(decodeURIComponent).join('/'),
            status: status as TaskStatus,
        }
    } catch {
        // A malformed escape: this is no reference EtherPK wrote.
        return null
    }
}
