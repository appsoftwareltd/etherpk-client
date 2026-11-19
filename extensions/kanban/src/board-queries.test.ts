import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createSchema, type IndexDoc, ingest, ingestOne, type SqlDb, tasksMatching, tasksMatchingCount, type TaskPriorityFilter, type TaskStatus } from '#lib/document/index-db.js'
import { wrapOo1Db } from '#lib/document/index-db-sqlite.js'
import type { BoardSnapshot } from './board-model'
import { laneTasks, readBoard, type TaskSource } from './board-queries'

// A [[Kanban Board]] as it reads from a graph (ADR 0113): the tasks that answer to its concept,
// in a lane per [[Task Status]] and a section per priority. Against a real in-memory index, so
// the Task Concept rule and the status partition are the index's own rather than a copy.

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>

beforeAll(async () => {
    sqlite3 = await sqlite3InitModule()
})

let db: SqlDb

beforeEach(() => {
    db = wrapOo1Db(new sqlite3.oo1.DB(':memory:'))
    createSchema(db)
})

/** The index client's `tasks` round trip, answered from the test's database. */
const source: TaskSource = {
    tasks: async (query, offset, limit) => ({ ...tasksMatching(db, query, offset, limit), total: tasksMatchingCount(db, query) }),
}

const TODAY = '2026-09-29'

function page(concept: string, lines: string[]): IndexDoc {
    return { concept, kind: 'page', aliases: [], text: lines.join('\n') }
}

/** One section's cards as a person reads them. */
function labels(board: BoardSnapshot, status: TaskStatus, priority: TaskPriorityFilter): string[] {
    const lane = board.lanes.find((l) => l.status === status)
    const section = lane?.sections.find((s) => s.priority === priority)
    return section?.cards.map((card) => card.label) ?? []
}

describe('reading a board', () => {
    beforeEach(() => {
        ingest(db, [
            page('2026-09-29', [
                '- Call with [[Acme]]',
                '  - [ ] #P1 Send the quote',
                '  - [ ] #D #P2 Draft the brief',
                '  - [ ] #W Hear back on the API',
                '  - [x] Pick a venue',
                '  - [x] #C Book the old venue',
                '  - [ ] #T Check the booking form',
                '  - [x] #A Print last year\'s flyers',
                '  - [ ] Tidy the notes',
                '- [ ] Buy milk',
            ]),
        ])
    })

    it('lays out six lanes in the order a task moves through them, each with a section per priority', async () => {
        const board = await readBoard(source, 'Acme', TODAY)
        expect(board.lanes.map((lane) => lane.label)).toEqual(['Open', 'Doing', 'Waiting', 'Test', 'Done', 'Cancelled'])
        for (const lane of board.lanes) {
            expect(lane.sections.map((section) => section.label)).toEqual(['P1', 'P2', 'P3', 'No priority'])
        }
    })

    it('puts each task in the lane of its status and the section of its priority', async () => {
        const board = await readBoard(source, 'Acme', TODAY)
        expect(labels(board, 'open', 1)).toEqual(['Send the quote'])
        expect(labels(board, 'open', null)).toEqual(['Tidy the notes'])
        expect(labels(board, 'doing', 2)).toEqual(['Draft the brief'])
        expect(labels(board, 'waiting', null)).toEqual(['Hear back on the API'])
        expect(labels(board, 'done', null)).toEqual(['Pick a venue'])
        expect(labels(board, 'cancelled', null)).toEqual(['Book the old venue'])
        expect(labels(board, 'test', null)).toEqual(['Check the booking form'])
    })

    it('has no lane for Archived, so an archived task is on no board', async () => {
        const board = await readBoard(source, 'Acme', TODAY)
        const everyLabel = board.lanes.flatMap((lane) => lane.sections.flatMap((section) => section.cards.map((c) => c.label)))
        expect(everyLabel).not.toContain("Print last year's flyers")
    })

    it('leaves out tasks that do not answer to the concept', async () => {
        const board = await readBoard(source, 'Acme', TODAY)
        const everyLabel = board.lanes.flatMap((lane) => lane.sections.flatMap((section) => section.cards.map((c) => c.label)))
        expect(everyLabel).not.toContain('Buy milk')
    })

    it('reads every task in the graph for the Graph Kanban, which answers to no concept', async () => {
        const board = await readBoard(source, null, TODAY)
        expect(board.concept).toBeNull()
        expect(labels(board, 'open', 1)).toEqual(['Send the quote'])
        expect(labels(board, 'open', null)).toEqual(['Tidy the notes', 'Buy milk'])
    })

    it('knows where each card lives: its document and its line', async () => {
        const board = await readBoard(source, 'Acme', TODAY)
        const card = board.lanes[0].sections[0].cards[0]
        expect(card.label).toBe('Send the quote')
        expect(card.document).toBe('2026-09-29')
        expect(card.line).toBe(1)
    })
})

describe('counting', () => {
    beforeEach(() => {
        ingest(db, [page('Acme', ['- [ ] #P1 First', '- [ ] #P1 Second', '- [ ] #P1 Third', '- [ ] Undated'])])
    })

    it('counts every task in a section and a lane, beyond the cards it loaded', async () => {
        const board = await readBoard(source, 'Acme', TODAY, { sectionLimit: 2 })
        const open = board.lanes[0]
        expect(open.sections[0].cards.map((c) => c.label)).toEqual(['First', 'Second'])
        expect(open.sections[0].total).toBe(3)
        expect(open.sections[0].hasMore).toBe(true)
        expect(open.total).toBe(4)
    })

    it('loads more cards in the one section that asks for them', async () => {
        const board = await readBoard(source, 'Acme', TODAY, {
            sectionLimit: 1,
            limitFor: (cell) => (cell.status === 'open' && cell.priority === 1 ? 3 : undefined),
        })
        expect(board.lanes[0].sections[0].cards.map((c) => c.label)).toEqual(['First', 'Second', 'Third'])
        expect(board.lanes[0].sections[0].hasMore).toBe(false)
        expect(board.lanes[0].sections[3].cards.map((c) => c.label)).toEqual(['Undated'])
    })

    it('reads a collapsed lane for its counts alone', async () => {
        const board = await readBoard(source, 'Acme', TODAY, { countOnly: new Set(['open']) })
        const open = board.lanes[0]
        expect(open.loaded).toBe(false)
        expect(open.sections.flatMap((s) => s.cards)).toEqual([])
        expect(open.sections.map((s) => s.total)).toEqual([3, 0, 0, 1])
        expect(open.total).toBe(4)
        expect(board.lanes[1].loaded).toBe(true)
    })
})

describe('due dates', () => {
    beforeEach(() => {
        ingest(db, [
            page('Acme', [
                '- [ ] #D-2026-09-28 Late',
                '- [ ] #D-2026-09-29 Today',
                '- [ ] #D-2026-10-03 Later',
                '- [ ] Undated',
            ]),
        ])
    })

    it('marks a due date as overdue, due today or upcoming against the day the board was read for', async () => {
        const board = await readBoard(source, 'Acme', TODAY)
        const cards = board.lanes[0].sections[3].cards
        expect(cards.map((c) => [c.label, c.due, c.dueState])).toEqual([
            ['Late', '2026-09-28', 'overdue'],
            ['Today', '2026-09-29', 'today'],
            ['Later', '2026-10-03', 'upcoming'],
            ['Undated', null, null],
        ])
    })
})

describe('subtasks', () => {
    beforeEach(() => {
        ingest(db, [page('Acme', ['- [ ] #P1 #D Launch site', '  - [ ] Hear back on the API'])])
    })

    it('names the task a subtask sits under when that task is not on the board', async () => {
        ingest(db, [page('Planning', ['- [ ] #P1 Plan the launch', '  - Notes', '    - [ ] [[Garden]] Water the beans'])])
        const board = await readBoard(source, 'Garden', TODAY)
        const subtask = board.lanes[0].sections[3].cards[0]
        expect(subtask.label).toBe('[[Garden]] Water the beans')
        expect(subtask.parent).toBe('Plan the launch')
    })
})

describe('a subtask on a board (ADR 0174)', () => {
    beforeEach(() => {
        ingest(db, [
            page('2026-11-04', [
                '- [[Projects]]',
                '  - [[Acme]]',
                '    - [ ] #P1 Build the shed',
                '      - measure the floor',
                '      - [x] Cut the timber',
                '      - [ ] Fix the roof',
                '      - [ ] Paint the door',
            ]),
        ])
    })

    it('reaches a subtask through its parent, whose card counts it', async () => {
        const board = await readBoard(source, 'Projects', TODAY)
        expect(labels(board, 'open', 1)).toEqual(['Build the shed'])
        expect(labels(board, 'open', null)).toEqual([])
        expect(board.lanes[0].total).toBe(1)
        expect(board.lanes[4].total).toBe(0)
        expect(board.lanes[0].sections[0].cards[0].subtasks).toEqual({ done: 1, total: 3 })
    })

    it('names the concept a task sits in on a board for a concept further out, and none on its own', async () => {
        const further = await readBoard(source, 'Projects', TODAY)
        expect(further.lanes[0].sections[0].cards[0].inConcept).toBe('Acme')
        const own = await readBoard(source, 'Acme', TODAY)
        expect(labels(own, 'open', 1)).toEqual(['Build the shed'])
        expect(own.lanes[0].sections[0].cards[0].inConcept).toBeNull()
    })

    it('moves all of a lane as the board shows it: the cards, not the subtasks they stand for', async () => {
        expect((await laneTasks(source, 'Projects', 'open', TODAY)).map((task) => task.text)).toEqual(['#P1 Build the shed'])
    })
})

describe('a section with Free Tags (ADR 0166)', () => {
    it('orders its cards by their first Free Tag A–Z, untagged last, then due date, then journals oldest first and pages A–Z', async () => {
        ingest(db, [
            page('Shed', ['- [ ] #P1 Oil the hinge', '- [ ] #P1 Paint the door #paint', '- [ ] #P1 #D-2026-10-03 Fix the gate #bug']),
            page('2026-09-28', ['- [ ] #bug #P1 Sweep the path', '- [ ] #P1 Rake the leaves']),
            page('2026-09-27', ['- [ ] #P1 Sharpen the saw #Paint']),
        ])
        const board = await readBoard(source, null, TODAY)
        expect(labels(board, 'open', 1)).toEqual(['Fix the gate', 'Sweep the path', 'Sharpen the saw', 'Paint the door', 'Rake the leaves', 'Oil the hinge'])
        expect(board.lanes[0].sections[0].cards.map((card) => card.freeTags)).toEqual([['bug'], ['bug'], ['Paint'], ['paint'], [], []])
    })
})

describe("a lane's tasks, for moving them all", () => {
    it('lists every task in the lane on the board, across priorities and past a page', async () => {
        const many = Array.from({ length: 7 }, (_, i) => `  - [x] #P${(i % 3) + 1} Water bed ${i}`)
        ingest(db, [page('Garden', ['- [ ] Weed', ...many.map((line) => line.slice(2)), '- [x] #C Plant leeks']), page('Kitchen', ['- [x] Wash up'])])
        const tasks = await laneTasks(source, 'Garden', 'done', TODAY, { pageSize: 3 })
        expect(tasks.map((task) => task.text).sort()).toEqual(many.map((line) => line.replace('  - [x] ', '')).sort())
        expect(tasks.every((task) => task.concept === 'Garden')).toBe(true)
    })

    it('lists the whole graph on the Graph Kanban', async () => {
        ingest(db, [page('Garden', ['- [x] Water the beans']), page('Kitchen', ['- [x] Wash up'])])
        expect((await laneTasks(source, null, 'done', TODAY)).map((task) => task.text).sort()).toEqual(['Wash up', 'Water the beans'])
    })
})

describe('a board narrowed by priority and due date', () => {
    beforeEach(() => {
        ingest(db, [
            page('Garden', [
                '- [ ] #P1 #D-2026-09-20 Mend the gate',
                '- [ ] #P1 Dig the bed',
                '- [ ] #P2 #D-2026-09-29 Water the beans',
                '- [ ] #P3 #D-2026-10-03 Sow the seeds',
                '- [ ] Weed the path',
                '- [ ] #D #D-2026-12-01 Paint the shed',
            ]),
        ])
    })
    const open = (board: BoardSnapshot) => board.lanes[0]

    it('shows only the priorities chosen, No priority among them, and counts each lane against its whole', async () => {
        const board = await readBoard(source, 'Garden', TODAY, { filter: { priorities: [1, null] } })
        expect(labels(board, 'open', 1)).toEqual(['Mend the gate', 'Dig the bed'])
        expect(labels(board, 'open', 2)).toEqual([])
        expect(labels(board, 'open', null)).toEqual(['Weed the path'])
        expect(open(board)).toMatchObject({ filter: { priorities: [1, null] }, total: 3, unfiltered: 5 })
    })

    it('shows only the tasks in the due window, an undated task under No due date alone', async () => {
        const overdue = await readBoard(source, 'Garden', TODAY, { filter: { due: 'overdue' } })
        expect(open(overdue).total).toBe(1)
        expect(labels(overdue, 'open', 1)).toEqual(['Mend the gate'])
        const soon = await readBoard(source, 'Garden', TODAY, { filter: { due: 'next7' } })
        expect([...labels(soon, 'open', 2), ...labels(soon, 'open', 3)]).toEqual(['Water the beans', 'Sow the seeds'])
        const undated = await readBoard(source, 'Garden', TODAY, { filter: { due: 'none' } })
        expect([...labels(undated, 'open', 1), ...labels(undated, 'open', null)]).toEqual(['Dig the bed', 'Weed the path'])
        expect(undated.lanes[1].total).toBe(0)
    })

    it('combines the words, the priorities and the due window', async () => {
        const board = await readBoard(source, 'Garden', TODAY, { filter: { text: 'the', priorities: [1], due: 'overdue' } })
        expect(open(board).total).toBe(1)
        expect(labels(board, 'open', 1)).toEqual(['Mend the gate'])
    })

    it('lists a lane through the priorities and the due window for Move all to lane', async () => {
        const tasks = await laneTasks(source, 'Garden', 'open', TODAY, { filter: { priorities: [1], due: 'none' } })
        expect(tasks.map((task) => task.text)).toEqual(['#P1 Dig the bed'])
    })
})

describe('Task Tags written in lower case, after a Free Tag', () => {
    it('put the card in the lane and section they name, and a filter in either case finds it', async () => {
        ingest(db, [page('Garden', ['- [ ] #bug #p3 #d water the beans', '- [ ] #P1 weed the path'])])
        const board = await readBoard(source, 'Garden', TODAY)
        expect(labels(board, 'doing', 3)).toEqual(['water the beans'])
        for (const typed of ['#P3', '#p3', '#BUG']) {
            const filtered = await readBoard(source, 'Garden', TODAY, { filter: { text: typed } })
            expect(labels(filtered, 'doing', 3)).toEqual(['water the beans'])
        }
    })
})

describe('a board with a filter', () => {
    beforeEach(() => {
        const many = Array.from({ length: 60 }, (_, i) => `- [ ] Water bed ${String(i).padStart(2, '0')}`)
        ingest(db, [page('Garden', [...many, '- [ ] #P1 Dig the bed', '- [ ] #D Water the beans', '- [ ] #D Weed'])])
    })

    const open = (board: BoardSnapshot) => board.lanes[0]
    const doing = (board: BoardSnapshot) => board.lanes[1]

    it('narrows every lane alike, and counts each against its whole lane', async () => {
        const board = await readBoard(source, 'Garden', TODAY, { filter: { text: ' WEED ' } })
        expect(doing(board)).toMatchObject({ filter: { text: { words: 'weed', tags: [] } }, total: 1, unfiltered: 2 })
        expect(labels(board, 'doing', null)).toEqual(['Weed'])
        expect(open(board)).toMatchObject({ filter: { text: { words: 'weed', tags: [] } }, total: 0, unfiltered: 61 })
    })

    it('counts a lane read for its counts alone through the filter too', async () => {
        const board = await readBoard(source, 'Garden', TODAY, { filter: { text: 'bed 5' }, countOnly: new Set(['open']) })
        expect(open(board)).toMatchObject({ loaded: false, total: 10, unfiltered: 61 })
        expect(labels(board, 'open', null)).toEqual([])
    })

    it('finds a match past the page the lane would load without the filter', async () => {
        const board = await readBoard(source, 'Garden', TODAY, { sectionLimit: 3, filter: { text: 'bed 59' } })
        expect(labels(board, 'open', null)).toEqual(['Water bed 59'])
        expect(open(board).total).toBe(1)
    })

    it('treats nothing but spaces as no filter', async () => {
        const board = await readBoard(source, 'Garden', TODAY, { filter: { text: '   ' } })
        expect(open(board)).toMatchObject({ filter: null, total: 61 })
    })

    it('narrows the board by a tag, and by words and a tag together', async () => {
        ingestOne(db, page('Shed', ['- [ ] [[Garden]] Water the fence #urgent', '- [ ] [[Garden]] Mend the fence #bug']))
        const byTag = await readBoard(source, 'Garden', TODAY, { filter: { text: '#urgent' } })
        expect(labels(byTag, 'open', null)).toEqual(['[[Garden]] Water the fence'])
        expect(open(byTag)).toMatchObject({ filter: { text: { words: '', tags: ['urgent'] } }, total: 1, unfiltered: 63 })
        expect(doing(byTag).total).toBe(0)

        const both = await readBoard(source, 'Garden', TODAY, { filter: { text: 'mend #urgent' } })
        expect(open(both).total).toBe(0)
    })

    it('lists a lane through the same filter for Move all to lane', async () => {
        expect((await laneTasks(source, 'Garden', 'doing', TODAY, { filter: { text: 'weed' } })).map((task) => task.text)).toEqual(['#D Weed'])
    })
})
