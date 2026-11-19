/**
 * Reading a [[Kanban Board]] from the [[Derived Index]]: one query per section, each the
 * [[Tasks View]]'s own query narrowed to one [[Task Status]] and one priority, so the board and
 * a Tasks View filtered to the same concept can never disagree (ADR 0113), but for the [[Subtask]]s
 * the board reaches through their parents' cards (ADR 0174).
 */
import { TASK_PRIORITY_FILTERS, type TaskHit, type TaskPriorityFilter, type TaskQuery, type TaskStatus } from '#lib/document/index-db.js'
import type { TaskPageResult } from '#lib/document/index-worker/client.js'
import { BOARD_LANES, BOARD_SECTIONS, type BoardCell, type BoardFilterChoice, boardFilterOf, type BoardLane, type BoardSnapshot, EVERY_TASK, toCard } from './board-model'

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
    /**
     * What the [[Board Filter]] holds; a part left out, or a blank one, hides nothing. Every lane is
     * read through it, the ones read for their counts alone too, so each lane counts what it would show.
     */
    filter?: Partial<BoardFilterChoice>
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
    const choice = { ...EVERY_TASK, ...options.filter }
    const filter = boardFilterOf(choice, today)
    const lanes = await Promise.all(
        BOARD_LANES.map(async (lane): Promise<BoardLane> => {
            // A limit of 0 still returns the total, which is all a collapsed lane shows.
            const loaded = !options.countOnly?.has(lane.status)
            const sections = await Promise.all(
                BOARD_SECTIONS.map(async (section) => {
                    const cell = { status: lane.status, priority: section.priority }
                    // A section whose priority the filter leaves out shows nothing, without asking.
                    if (filter?.priorities && !filter.priorities.includes(section.priority)) return { ...section, cards: [], total: 0, hasMore: false }
                    const limit = loaded ? (options.limitFor?.(cell) ?? defaultLimit) : 0
                    const page = await source.tasks(sectionQuery(concept, lane.status, section.priority, today, choice), 0, limit)
                    return {
                        ...section,
                        cards: page.hits.map((hit) => toCard(hit, today)),
                        total: page.total,
                        hasMore: loaded && page.hasMore,
                    }
                }),
            )
            const total = sections.reduce((sum, section) => sum + section.total, 0)
            // One more round trip, and only under a filter: the lane's whole count is its header's "of" and a lane reference's count.
            const unfiltered = filter === null ? total : (await source.tasks(laneQuery(concept, lane.status, today), 0, 0)).total
            return { ...lane, loaded, sections, total, filter, unfiltered }
        }),
    )
    return { concept, today, lanes }
}

function sectionQuery(concept: string | null, status: TaskStatus, priority: TaskPriorityFilter, today: string, choice: BoardFilterChoice): TaskQuery {
    return { concept, statuses: [status], priorities: [priority], due: choice.due, groupBy: 'due', byFreeTag: true, asBoard: true, textFilter: choice.text, today }
}

/** Every task in one lane, through `choice` (the whole lane, for its count, with {@link EVERY_TASK}). */
function laneQuery(concept: string | null, status: TaskStatus, today: string, choice: BoardFilterChoice = EVERY_TASK): TaskQuery {
    const priorities = choice.priorities.length === 0 ? TASK_PRIORITY_FILTERS : choice.priorities
    return { concept, statuses: [status], priorities, due: choice.due, groupBy: 'document', asBoard: true, textFilter: choice.text, today }
}

/** How many tasks {@link laneTasks} reads in one round trip. */
const LANE_PAGE_SIZE = 200

/**
 * Every task in one lane of the board for `concept` (null for the Graph Kanban), across its
 * priorities and past what the board has loaded: what "Move all to lane" moves, which is only what
 * the [[Board Filter]] lets through when there is one. Read a page at a time, in the index's own
 * order, so a lane of any length is read whole.
 */
export async function laneTasks(
    source: TaskSource,
    concept: string | null,
    status: TaskStatus,
    today: string,
    { pageSize = LANE_PAGE_SIZE, filter }: { pageSize?: number; filter?: Partial<BoardFilterChoice> } = {},
): Promise<TaskHit[]> {
    const query = laneQuery(concept, status, today, { ...EVERY_TASK, ...filter })
    const tasks: TaskHit[] = []
    for (;;) {
        const page = await source.tasks(query, tasks.length, pageSize)
        tasks.push(...page.hits)
        if (!page.hasMore || page.hits.length === 0) return tasks
    }
}
