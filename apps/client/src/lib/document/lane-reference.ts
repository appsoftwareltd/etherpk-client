/**
 * A [[Lane Reference]]: the address of a lane of a [[Kanban Board]] inside the [[Agent Instruction]]
 * a person copies to hand an agent every task in it, to work through or to triage
 * (agent-instruction.ts). It is the board's address under the `etherpk:` scheme with the lane's
 * [[Task Status]] as the fragment: `etherpk:<graph address>/k/<concept>#lane=<status>`, or
 * `etherpk:<graph address>/kanban#lane=…` for the Graph Kanban, the [[Graph Address]] being
 * `/graph/sync/<id>` or `/graph/folder/<folder name>` (ADR 0192). Like a [[Task Reference]] it is not a web
 * address, and nothing is written into a document to make one.
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
import { REFERENCED_GRAPH_PATTERN, referencedGraphFrom, referencedGraphPath, type ReferencedGraph } from '../navigation/graph-address'
import { TASK_STATUSES, type TaskStatus } from './index-db'

export interface LaneReference {
    /** The graph the board is in, by its [[Graph Address]]. */
    graph: ReferencedGraph
    /** The board's concept, or null for the Graph Kanban, the board of every task in the graph. */
    concept: string | null
    status: TaskStatus
}

/** The scheme that marks a reference as EtherPK's own, and not a web address to fetch. */
const SCHEME = 'etherpk:'

/** The board's address: the Kanban extension's, `<graph address>/k/<concept>` or `<graph address>/kanban`. */
function boardPath(graph: ReferencedGraph, concept: string | null): string {
    const base = referencedGraphPath(graph)
    return concept === null ? `${base}/kanban` : `${base}/k/${encodeConceptPath(concept)}`
}

/** The reference as an agent is handed it: `etherpk:`, the board's address and the lane. */
export function laneReferenceId(reference: LaneReference): string {
    return `${SCHEME}${boardPath(reference.graph, reference.concept)}#lane=${reference.status}`
}

/** `<graph address>/k/<concept>#lane=<status>` or `<graph address>/kanban#lane=<status>`, the scheme before it optional. */
const LANE_REFERENCE = new RegExp(`(?:etherpk:)?${REFERENCED_GRAPH_PATTERN}${String.raw`\/(?:k\/([^?#\s]+?)|kanban)#lane=([a-z]+)(?![a-z])`}`)

/**
 * The lane reference in `input`: the text as copied, or the `etherpk:` reference alone; null when
 * `input` holds none, or names a lane that is no task status.
 */
export function parseLaneReference(input: string): LaneReference | null {
    const match = LANE_REFERENCE.exec(input)
    if (!match) return null
    const [, where, graph, path, status] = match
    if (!TASK_STATUSES.includes(status as TaskStatus)) return null
    try {
        return {
            graph: referencedGraphFrom(where, graph),
            concept: path === undefined ? null : path.split('/').map(decodeURIComponent).join('/'),
            status: status as TaskStatus,
        }
    } catch {
        // A malformed escape: this is no reference EtherPK wrote.
        return null
    }
}
