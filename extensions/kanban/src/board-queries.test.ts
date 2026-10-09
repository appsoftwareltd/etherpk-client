import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createSchema, type IndexDoc, ingest, type SqlDb, tasksMatching, tasksMatchingCount, type TaskPriorityFilter, type TaskStatus } from '$lib/document/index-db'
import { wrapOo1Db } from '$lib/document/index-db-sqlite'
import type { BoardSnapshot } from './board-model'
import { readBoard, type TaskSource } from './board-queries'

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
                '  - [ ] Tidy the notes',
                '- [ ] Buy milk',
            ]),
        ])
    })

    it('lays out five lanes in the order a task moves through them, each with a section per priority', async () => {
        const board = await readBoard(source, 'Acme', TODAY)
        expect(board.lanes.map((lane) => lane.label)).toEqual(['Open', 'Doing', 'Waiting', 'Done', 'Cancelled'])
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
    })

    it('leaves out tasks that do not answer to the concept', async () => {
        const board = await readBoard(source, 'Acme', TODAY)
        const everyLabel = board.lanes.flatMap((lane) => lane.sections.flatMap((section) => section.cards.map((c) => c.label)))
        expect(everyLabel).not.toContain('Buy milk')
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

    it('names the task a subtask sits under, as a person reads it', async () => {
        const board = await readBoard(source, 'Acme', TODAY)
        const subtask = board.lanes[0].sections[3].cards[0]
        expect(subtask.label).toBe('Hear back on the API')
        expect(subtask.parent).toBe('Launch site')
        expect(board.lanes[1].sections[0].cards[0].parent).toBeNull()
    })
})
