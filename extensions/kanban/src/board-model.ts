/**
 * The shape of a [[Kanban Board]] (ADR 0113): six [[Lane]]s, one per [[Task Status]] but Archived, each
 * stacking one section per priority, and in each section the cards of the tasks that answer to
 * the board's concept.
 *
 * Framework-free, so the View renders it and the tests read it without a browser. The board is
 * a lens over documents: nothing here is stored, and every card is a task line that the
 * [[Derived Index]] reported.
 */
import type { TaskHit, TaskPriorityFilter, TaskStatus, TaskSubtaskCount } from '#lib/document/index-db.js'
import { bulletLabel, taskTitleKey } from '#lib/document/index-derive.js'
import { freeTagsIn, parseTaskLine, parseTaskTags, taskDisplay } from '#lib/document/task-tags.js'

/**
 * The View kind a board is registered under, which the manifest declares with its address
 * (`/g/<graph>/k/<concept>`) and its tab title, `Kanban: <concept>`.
 */
export const KANBAN_VIEW_KIND = 'kanban.board'

/**
 * The View kind of the **Graph Kanban**, the board of every task in the graph: one per graph, at
 * `/g/<graph>/kanban`, titled "Graph Kanban", its target fixed by the manifest.
 */
export const KANBAN_WHOLE_KIND = 'kanban.whole'

/** The Graph Kanban as a View. */
export const KANBAN_WHOLE = { kind: KANBAN_WHOLE_KIND, target: 'whole' } as const

/**
 * The concept a board's View is over, or null for the Graph Kanban, which answers to no one
 * concept: the same null the task query takes for every task in the graph.
 */
export function boardConceptOf(view: { kind: string; target: string }): string | null {
    return view.kind === KANBAN_WHOLE_KIND ? null : view.target
}

export interface BoardLaneSpec {
    status: TaskStatus
    label: string
}

/**
 * The lanes, in the order a task moves through them. Fixed and the same on every board: a
 * task's lane is read from its own line, so there is nothing per board to configure. Archived has
 * none: it is how a finished task leaves the board (ADR 0167).
 */
export const BOARD_LANES: readonly BoardLaneSpec[] = [
    { status: 'open', label: 'Open' },
    { status: 'doing', label: 'Doing' },
    { status: 'waiting', label: 'Waiting' },
    { status: 'test', label: 'Test' },
    { status: 'done', label: 'Done' },
    { status: 'cancelled', label: 'Cancelled' },
]

/** Where a card can be sent from its menu or a lane's: every lane, then Archived, which takes it off the board. */
export const MOVE_TARGETS: readonly BoardLaneSpec[] = [...BOARD_LANES, { status: 'archived', label: 'Archived' }]

export interface BoardSectionSpec {
    /** `null` is the real "No priority" section, as it is a real filter in the Tasks View. */
    priority: TaskPriorityFilter
    label: string
}

/** The sections every lane stacks, highest priority first. */
export const BOARD_SECTIONS: readonly BoardSectionSpec[] = [
    { priority: 1, label: 'P1' },
    { priority: 2, label: 'P2' },
    { priority: 3, label: 'P3' },
    { priority: null, label: 'No priority' },
]

/** How a card's due date stands against the day the board was read for. */
export type DueState = 'overdue' | 'today' | 'upcoming'

export interface BoardCard {
    /**
     * Where the task lives, its document and line, which is also what a move addresses. Never
     * the index's page id: a folder graph re-derives the whole graph with fresh page ids on any
     * file change.
     */
    key: string
    /** The concept of the document the task is written in. */
    document: string
    /** 0-based and body-relative, as the index records it. */
    line: number
    /** The text after the checkbox, tag run included, exactly as written. */
    text: string
    /** What a person reads: the text with its [[Task Tag]] run and its [[Free Tag]]s taken off. */
    label: string
    /** The Free Tags the card shows as pills, as written; none when they are all the task says. */
    freeTags: string[]
    /** The first Free Tag, lower-cased, or null: what orders the card in its section first (ADR 0166). */
    freeTag: string | null
    due: string | null
    dueState: DueState | null
    /**
     * The task this one sits under, as a person reads it (tag run off), or null. A [[Subtask]] has
     * a card only when its [[Parent Task]] is not on the board (ADR 0174), and this keeps it tied
     * to that task.
     */
    parent: string | null
    /**
     * The concept the task sits in, as written, or null: the nearest one linked above it, unless
     * that is the board's own or the task's document. Never beside a `parent`: a card says one
     * "in:", and the task above it is the nearer of the two.
     */
    inConcept: string | null
    /** The tasks nested under this one, which the board reaches only through this card. */
    subtasks: TaskSubtaskCount
}

export interface BoardSection extends BoardSectionSpec {
    cards: BoardCard[]
    /** Every task in the section, not only the cards loaded. */
    total: number
    hasMore: boolean
}

export interface BoardLane extends BoardLaneSpec {
    sections: BoardSection[]
    total: number
    /**
     * Whether the lane's cards were read. A collapsed lane is read for its counts only, so its
     * sections hold totals and no cards.
     */
    loaded: boolean
    /** The lane's [[Lane Filter]] as it is searched for, or null when it shows all its tasks. `total` counts the matches. */
    filter: string | null
    /** Every task in the lane, whatever its Lane Filter hides. */
    unfiltered: number
}

export interface BoardSnapshot {
    /** The concept the board is over, or null for the Graph Kanban. */
    concept: string | null
    /** The day the due dates were measured against, `YYYY-MM-DD`. */
    today: string
    lanes: BoardLane[]
}

export function cardKey(document: string, line: number): string {
    return `${document}:${line}`
}

/** A lane and a section: where a card sits, or where it is dropped. */
export interface BoardCell {
    status: TaskStatus
    priority: TaskPriorityFilter
}

/** The lane `step` places along from `status`, or undefined past either end. */
export function laneAfter(status: TaskStatus, step: -1 | 1): TaskStatus | undefined {
    const index = BOARD_LANES.findIndex((lane) => lane.status === status)
    return BOARD_LANES[index + step]?.status
}

/**
 * The section `step` places along from `priority`, or undefined past either end. `null` is a
 * real answer, the No priority section below P3, which is why "none" is undefined.
 */
export function sectionAfter(priority: TaskPriorityFilter, step: -1 | 1): TaskPriorityFilter | undefined {
    const index = BOARD_SECTIONS.findIndex((section) => section.priority === priority)
    const next = BOARD_SECTIONS[index + step]
    return next === undefined ? undefined : next.priority
}

/**
 * A move the board shows before the index has caught up with it: the card lands at once and
 * holds its new place until the index agrees (ADR 0113).
 */
export interface PendingMove {
    /** The card as the board showed it when it was moved. */
    card: BoardCard
    to: BoardCell
    /** When the write finished (ms), or null while it is under way. */
    writtenAt: number | null
}

/**
 * The same task, by where it is written and what it says. Not by line, which a move can
 * change, and not by the tag run, which a move rewrites.
 */
export function sameTask(a: BoardCard, b: BoardCard): boolean {
    return a.document.toLowerCase() === b.document.toLowerCase() && a.label === b.label
}

/**
 * The order a section's cards are in: the first [[Free Tag]] A–Z with untagged cards last, then
 * due date with undated last, then the document's name, then the line. The index sorts a section
 * the same way (`byFreeTag`, `TIE_BREAK_SQL`), so a card a move slots in sits where the next read
 * will put it.
 */
function compareCards(a: BoardCard, b: BoardCard): number {
    if (a.freeTag !== b.freeTag) {
        if (a.freeTag === null) return 1
        if (b.freeTag === null) return -1
        return a.freeTag < b.freeTag ? -1 : 1
    }
    if (a.due !== b.due) {
        if (a.due === null) return 1
        if (b.due === null) return -1
        return a.due < b.due ? -1 : 1
    }
    const aDocument = a.document.toLowerCase()
    const bDocument = b.document.toLowerCase()
    if (aDocument !== bDocument) return aDocument < bDocument ? -1 : 1
    return a.line - b.line
}

/**
 * `board` as it looks with `moves` made: each card out of wherever it is and into its target. A
 * card moved into a lane whose cards were not read (a collapsed lane) is counted there and not
 * drawn, like the rest of that lane's cards.
 */
export function withPendingMoves(board: BoardSnapshot, moves: readonly PendingMove[]): BoardSnapshot {
    if (moves.length === 0) return board
    let lanes = board.lanes
    for (const move of moves) lanes = lanes.map((lane) => laneWithMove(lane, move))
    return { ...board, lanes }
}

/** Whether a lane's [[Lane Filter]] lets `card` through. */
export function passesFilter(lane: Pick<BoardLane, 'filter'>, card: BoardCard): boolean {
    return lane.filter === null || taskTitleKey(card.text).includes(lane.filter)
}

function laneWithMove(lane: BoardLane, move: PendingMove): BoardLane {
    const passes = passesFilter(lane, move.card)
    let removedFromLane = 0
    const sections = lane.sections.map((section) => {
        const kept = section.cards.filter((card) => !sameTask(card, move.card))
        const removed = section.cards.length - kept.length
        removedFromLane += removed
        const into = lane.status === move.to.status && section.priority === move.to.priority
        const cards = into && lane.loaded && passes ? [...kept, move.card].sort(compareCards) : kept
        return { ...section, cards, total: section.total - removed + (into && passes ? 1 : 0) }
    })
    const arrives = lane.status === move.to.status
    return {
        ...lane,
        sections,
        total: sections.reduce((sum, section) => sum + section.total, 0),
        unfiltered: lane.unfiltered - removedFromLane + (arrives ? 1 : 0),
    }
}

/** Where the board shows `card`'s task, or undefined when it does not show it. */
function cellOf(board: BoardSnapshot, card: BoardCard): BoardCell | undefined {
    for (const lane of board.lanes) {
        for (const section of lane.sections) {
            if (section.cards.some((shown) => sameTask(shown, card))) return { status: lane.status, priority: section.priority }
        }
    }
    return undefined
}

/**
 * The moves still to hold over `board`, a fresh read of the index. A move lets go once the read
 * shows its card where it was dropped. A written move the index has not confirmed after
 * `holdMs` lets go too, so the index's answer wins in the end; one whose write is still under
 * way is always held.
 */
export function unsettledMoves(board: BoardSnapshot, moves: readonly PendingMove[], now: number, holdMs: number): PendingMove[] {
    return moves.filter((move) => {
        if (move.writtenAt === null) return true
        if (now - move.writtenAt >= holdMs) return false
        const shown = cellOf(board, move.card)
        // A lane that holds no cards, one whose Lane Filter hides this card, or no lane at all
        // (Archived) cannot show the card arriving, so a move into one settles when the card has
        // left every section the board does show.
        const target = board.lanes.find((lane) => lane.status === move.to.status)
        if (!target || !target.loaded || !passesFilter(target, move.card)) return shown !== undefined
        return !(shown && shown.status === move.to.status && shown.priority === move.to.priority)
    })
}

/** Dates are `YYYY-MM-DD`, so comparing the strings compares the days. */
export function dueState(due: string | null, today: string): DueState | null {
    if (due === null) return null
    if (due < today) return 'overdue'
    if (due === today) return 'today'
    return 'upcoming'
}

/**
 * What a card says for a task's text as the index records it: its words without the tag run or
 * its [[Free Tag]]s. A task written as nothing but tags still gets a card, and its tags are then
 * its words.
 */
function cardLabel(taskText: string): string {
    return taskDisplay(taskText).text
}

/** A card's Free Tags: the pills it shows, and the first one, which orders it as the index does. */
function cardFreeTags(taskText: string): Pick<BoardCard, 'freeTags' | 'freeTag'> {
    return { freeTags: taskDisplay(taskText).freeTags, freeTag: freeTagsIn(parseTaskTags(taskText).text)[0]?.toLowerCase() ?? null }
}

export function toCard(hit: TaskHit, today: string): BoardCard {
    return {
        key: cardKey(hit.concept, hit.line),
        document: hit.concept,
        line: hit.line,
        text: hit.text,
        label: cardLabel(hit.text),
        ...cardFreeTags(hit.text),
        due: hit.due,
        dueState: dueState(hit.due, today),
        parent: hit.parentTask === null ? null : cardLabel(hit.parentTask),
        inConcept: hit.parentTask === null ? hit.ancestorConcept : null,
        subtasks: hit.subtasks,
    }
}

/** What a [[Task Detail]]'s editor says of its task now: the body line it has followed it to (0-based), and that line's text. */
export interface ShownTaskLine {
    line: number
    text: string
}

/**
 * The card a [[Task Detail]] shows, in a fresh read of the board.
 *
 * The index lags the Task Detail's editor, and a card knows its task by a line and words that the
 * Task Detail is there to change. So the editor's line decides: the card whose words are what that
 * line says now, the nearest to it when the words repeat. Until the index has read an edit to them,
 * the card last matched (`last`) stays, or one with its words on another line. Null when neither is
 * on the board.
 */
export function taskDetailCard(board: BoardSnapshot, last: Pick<BoardCard, 'document' | 'line' | 'label'>, shown: ShownTaskLine | null): BoardCard | null {
    const document = last.document.toLowerCase()
    const cards = board.lanes.flatMap((lane) => lane.sections.flatMap((section) => section.cards)).filter((card) => card.document.toLowerCase() === document)
    if (shown !== null && parseTaskLine(shown.text) !== null) {
        // The words as the index would record the line (`bulletLabel` is the function it uses),
        // trimmed on both sides so trailing spaces a tidy has yet to take never decide.
        const words = cardLabel(bulletLabel(shown.text)).trim()
        const distance = (card: BoardCard) => Math.abs(card.line - shown.line)
        const nearest = cards.filter((card) => card.label.trim() === words).sort((a, b) => distance(a) - distance(b))[0]
        if (nearest) return nearest
    }
    return cards.find((card) => card.line === last.line && card.label === last.label) ?? cards.find((card) => card.label === last.label) ?? null
}
