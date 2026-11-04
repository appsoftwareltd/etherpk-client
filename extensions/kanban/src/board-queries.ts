/**
 * Reading a [[Kanban Board]] from the [[Derived Index]]: one query per section, each the
 * [[Tasks View]]'s own query narrowed to one [[Task Status]] and one priority, so the board and
 * a Tasks View filtered to the same concept can never disagree (ADR 0113), but for the [[Subtask]]s
 * the board reaches through their parents' cards (ADR 0174).
 */
import { TASK_PRIORITY_FILTERS, type TaskHit, type TaskPriorityFilter, type TaskQuery, type TaskStatus } from '#lib/document/index-db.js'
import { taskTitleSearchKey } from '#lib/document/index-derive.js'
import type { TaskPageResult } from '#lib/document/index-worker/client.js'
import { BOARD_LANES, BOARD_SECTIONS, type BoardCell, type BoardLane, type BoardSnapshot, toCard } from './board-model'

/** The one round trip a board needs from the index client. */
export interface TaskSource {
    tasks(query: TaskQuery, offset: number, limit: number): Promise<TaskPageResult>
}

/** Cards a section loads before it offers more. */
export const SECTION_PAGE_SIZE = 50

export interface ReadBoardOptions {
    /** How many cards each section loads; the totals always count every task. */
    sectionLimit?: number
    /** A section's own limit, where Show more has raised it; undefined leaves `sectionLimit`. */
    limitFor?: (cell: BoardCell) => number | undefined
    /** Lanes to read for their counts alone: the collapsed ones, whose cards are not shown. */
    countOnly?: ReadonlySet<TaskStatus>
    /** What a lane's [[Lane Filter]] holds, as typed; undefined for a lane without one. */
    titleFilterFor?: (status: TaskStatus) => string | undefined
}

/**
 * The board for `concept`, or for every task in the graph when it is null (the Graph Kanban), with
 * due dates measured against `today` (`YYYY-MM-DD`, read from the clock by the caller at the
 * moment of asking: a board is left open for days).
 *
 * The sections are asked in parallel. The index answers each in its own worker round trip, and
 * a section ordered by its first [[Free Tag]] and then due date is exactly the index's `due`
 * ordering with `byFreeTag`, whose ties fall to the document's name and the task's line.
 */
export async function readBoard(source: TaskSource, concept: string | null, today: string, options: ReadBoardOptions = {}): Promise<BoardSnapshot> {
    const defaultLimit = options.sectionLimit ?? SECTION_PAGE_SIZE
    const lanes = await Promise.all(
        BOARD_LANES.map(async (lane): Promise<BoardLane> => {
            // A limit of 0 still returns the total, which is all a collapsed lane shows.
            const loaded = !options.countOnly?.has(lane.status)
            const filter = taskTitleSearchKey(options.titleFilterFor?.(lane.status) ?? '') || null
            const sections = await Promise.all(
                BOARD_SECTIONS.map(async (section) => {
                    const cell = { status: lane.status, priority: section.priority }
                    const limit = loaded ? (options.limitFor?.(cell) ?? defaultLimit) : 0
                    const page = await source.tasks(sectionQuery(concept, lane.status, section.priority, today, filter), 0, limit)
                    return {
                        ...section,
                        cards: page.hits.map((hit) => toCard(hit, today)),
                        total: page.total,
                        hasMore: loaded && page.hasMore,
                    }
                }),
            )
            const total = sections.reduce((sum, section) => sum + section.total, 0)
            // One more round trip, and only for a filtered lane: the lane's whole count is its header's "of" and a lane reference's count.
            const unfiltered = filter === null ? total : (await source.tasks(laneQuery(concept, lane.status, today), 0, 0)).total
            return { ...lane, loaded, sections, total, filter, unfiltered }
        }),
    )
    return { concept, today, lanes }
}

function sectionQuery(concept: string | null, status: TaskStatus, priority: TaskPriorityFilter, today: string, titleContains: string | null): TaskQuery {
    return { concept, statuses: [status], priorities: [priority], due: 'any', groupBy: 'due', byFreeTag: true, asBoard: true, titleContains: titleContains ?? undefined, today }
}

function laneQuery(concept: string | null, status: TaskStatus, today: string, titleContains?: string): TaskQuery {
    return { concept, statuses: [status], priorities: TASK_PRIORITY_FILTERS, due: 'any', groupBy: 'document', asBoard: true, titleContains, today }
}

/** How many tasks {@link laneTasks} reads in one round trip. */
const LANE_PAGE_SIZE = 200

/**
 * Every task in one lane of the board for `concept` (null for the Graph Kanban), across its
 * priorities and past what the board has loaded: what "Move all to lane" moves, which is only what
 * the lane's [[Lane Filter]] lets through when it has one. Read a page at a time, in the index's own
 * order, so a lane of any length is read whole.
 */
export async function laneTasks(
    source: TaskSource,
    concept: string | null,
    status: TaskStatus,
    today: string,
    { pageSize = LANE_PAGE_SIZE, titleContains }: { pageSize?: number; titleContains?: string } = {},
): Promise<TaskHit[]> {
    const query = laneQuery(concept, status, today, titleContains)
    const tasks: TaskHit[] = []
    for (;;) {
        const page = await source.tasks(query, tasks.length, pageSize)
        tasks.push(...page.hits)
        if (!page.hasMore || page.hits.length === 0) return tasks
    }
}
