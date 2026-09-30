/**
 * Reading a [[Kanban Board]] from the [[Derived Index]]: one query per section, each the
 * [[Tasks View]]'s own query narrowed to one [[Task Status]] and one priority, so the board and
 * a Tasks View filtered to the same concept can never disagree (ADR 0113).
 */
import type { TaskPriorityFilter, TaskQuery, TaskStatus } from '../document/index-db'
import type { TaskPageResult } from '../document/index-worker/client'
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
}

/**
 * The board for `concept`, with due dates measured against `today` (`YYYY-MM-DD`, read from the
 * clock by the caller at the moment of asking: a board is left open for days).
 *
 * The sections are asked in parallel. The index answers each in its own worker round trip, and
 * a section ordered by due date is exactly the index's `due` ordering, whose ties fall to the
 * document's name and the task's line.
 */
export async function readBoard(source: TaskSource, concept: string, today: string, options: ReadBoardOptions = {}): Promise<BoardSnapshot> {
    const defaultLimit = options.sectionLimit ?? SECTION_PAGE_SIZE
    const lanes = await Promise.all(
        BOARD_LANES.map(async (lane): Promise<BoardLane> => {
            // A limit of 0 still returns the total, which is all a collapsed lane shows.
            const loaded = !options.countOnly?.has(lane.status)
            const sections = await Promise.all(
                BOARD_SECTIONS.map(async (section) => {
                    const cell = { status: lane.status, priority: section.priority }
                    const limit = loaded ? (options.limitFor?.(cell) ?? defaultLimit) : 0
                    const page = await source.tasks(sectionQuery(concept, lane.status, section.priority, today), 0, limit)
                    return {
                        ...section,
                        cards: page.hits.map((hit) => toCard(hit, today)),
                        total: page.total,
                        hasMore: loaded && page.hasMore,
                    }
                }),
            )
            return { ...lane, loaded, sections, total: sections.reduce((sum, section) => sum + section.total, 0) }
        }),
    )
    return { concept, today, lanes }
}

function sectionQuery(concept: string, status: TaskStatus, priority: TaskPriorityFilter, today: string): TaskQuery {
    return { concept, statuses: [status], priorities: [priority], due: 'any', groupBy: 'due', today }
}
