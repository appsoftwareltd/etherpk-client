import { describe, expect, it } from 'vitest'

import {
    BOARD_LANES,
    BOARD_SECTIONS,
    type BoardCard,
    type BoardSnapshot,
    laneAfter,
    type PendingMove,
    sectionAfter,
    taskDetailCard,
    unsettledMoves,
    withPendingMoves,
} from './board-model'

// The moves a [[Kanban Board]] shows before the index has caught up with them (ADR 0113): a
// dropped card lands at once and holds its new place until the index agrees, or gives way to
// the index after a while so a move the index never confirms cannot stand for ever.

function card(label: string, document = 'Acme', line = 0, due: string | null = null): BoardCard {
    return { key: `${document}:${line}`, document, line, text: label, label, due, dueState: due === null ? null : 'upcoming', parent: null }
}

/**
 * A board holding `cards` by (status, priority), every other section empty. The lanes in
 * `countedOnly` hold counts but no cards, as a collapsed lane does.
 */
function board(cells: Array<[string, number | null, BoardCard[]]>, countedOnly: Record<string, number> = {}): BoardSnapshot {
    return {
        concept: 'Acme',
        today: '2026-09-29',
        lanes: BOARD_LANES.map((lane) => {
            const loaded = !(lane.status in countedOnly)
            const sections = BOARD_SECTIONS.map((section) => {
                const cards = loaded ? (cells.find(([status, priority]) => status === lane.status && priority === section.priority)?.[2] ?? []) : []
                const total = loaded ? cards.length : section.priority === null ? countedOnly[lane.status] : 0
                return { ...section, cards, total, hasMore: false }
            })
            return { ...lane, loaded, sections, total: sections.reduce((n, s) => n + s.total, 0) }
        }),
    }
}

function labelsAt(snapshot: BoardSnapshot, status: string, priority: number | null): string[] {
    const section = snapshot.lanes.find((l) => l.status === status)?.sections.find((s) => s.priority === priority)
    return section?.cards.map((c) => c.label) ?? []
}

function totalAt(snapshot: BoardSnapshot, status: string, priority: number | null): number {
    return snapshot.lanes.find((l) => l.status === status)?.sections.find((s) => s.priority === priority)?.total ?? -1
}

const move = (moved: BoardCard, status: PendingMove['to']['status'], priority: PendingMove['to']['priority'], writtenAt: number | null = null): PendingMove => ({
    card: moved,
    to: { status, priority },
    writtenAt,
})

describe('withPendingMoves', () => {
    it('takes the card out of its section and puts it in the one it was dropped on', () => {
        const quote = card('Send the quote', 'Acme', 1)
        const shown = withPendingMoves(board([['open', 1, [quote, card('Other', 'Acme', 2)]]]), [move(quote, 'doing', 2)])
        expect(labelsAt(shown, 'open', 1)).toEqual(['Other'])
        expect(labelsAt(shown, 'doing', 2)).toEqual(['Send the quote'])
    })

    it('keeps the counts of both sections and both lanes true to what is shown', () => {
        const quote = card('Send the quote')
        const shown = withPendingMoves(board([['open', 1, [quote]]]), [move(quote, 'doing', 1)])
        expect(totalAt(shown, 'open', 1)).toBe(0)
        expect(totalAt(shown, 'doing', 1)).toBe(1)
        expect(shown.lanes.map((l) => l.total)).toEqual([0, 1, 0, 0, 0])
    })

    it('slots the card where the derived order puts it: due date, then document name, then line', () => {
        const quote = card('Send the quote', 'Beta', 4, '2026-10-02')
        const target: Array<[string, number | null, BoardCard[]]> = [
            ['doing', null, [card('Earlier', 'Zulu', 0, '2026-10-01'), card('Same day, earlier name', 'Alpha', 9, '2026-10-02'), card('Undated', 'Alpha', 0)]],
            ['open', null, [quote]],
        ]
        const shown = withPendingMoves(board(target), [move(quote, 'doing', null)])
        expect(labelsAt(shown, 'doing', null)).toEqual(['Earlier', 'Same day, earlier name', 'Send the quote', 'Undated'])
    })

    it('counts a card dropped on a collapsed lane without drawing it there, since that lane holds no cards', () => {
        const quote = card('Send the quote')
        const shown = withPendingMoves(board([['open', null, [quote]]], { done: 40 }), [move(quote, 'done', null)])
        expect(labelsAt(shown, 'open', null)).toEqual([])
        expect(labelsAt(shown, 'done', null)).toEqual([])
        expect(shown.lanes.find((l) => l.status === 'done')?.total).toBe(41)
    })

    it('changes nothing for a move the index already shows', () => {
        const quote = card('Send the quote')
        const snapshot = board([['doing', 2, [quote]]])
        const shown = withPendingMoves(snapshot, [move(quote, 'doing', 2)])
        expect(labelsAt(shown, 'doing', 2)).toEqual(['Send the quote'])
        expect(totalAt(shown, 'doing', 2)).toBe(1)
    })
})

describe('unsettledMoves', () => {
    const HOLD_MS = 5000

    it('keeps a move whose write is still under way', () => {
        const quote = card('Send the quote')
        const pending = [move(quote, 'doing', 1, null)]
        expect(unsettledMoves(board([['open', 1, [quote]]]), pending, 10_000, HOLD_MS)).toEqual(pending)
    })

    it('lets go of a move once the index shows the card where it was dropped, whatever its line now', () => {
        const quote = card('Send the quote', 'Acme', 1)
        const moved = { ...card('Send the quote', 'Acme', 3), text: '#D Send the quote' }
        expect(unsettledMoves(board([['doing', 1, [moved]]]), [move(quote, 'doing', 1, 1000)], 1200, HOLD_MS)).toEqual([])
    })

    it('lets go of a move onto a collapsed lane once the card has left every section the board shows', () => {
        const quote = card('Send the quote')
        const pending = [move(quote, 'done', null, 1000)]
        // Still in Open: the index has not caught up.
        expect(unsettledMoves(board([['open', null, [quote]]], { done: 40 }), pending, 1200, HOLD_MS)).toEqual(pending)
        // Gone from Open, and Done shows no cards to find it in: the index has it.
        expect(unsettledMoves(board([], { done: 41 }), pending, 1200, HOLD_MS)).toEqual([])
    })

    it('holds a written move while the index has not caught up, then gives way to it', () => {
        const quote = card('Send the quote')
        const pending = [move(quote, 'doing', 1, 1000)]
        const stale = board([['open', 1, [quote]]])
        expect(unsettledMoves(stale, pending, 1000 + HOLD_MS - 1, HOLD_MS)).toEqual(pending)
        expect(unsettledMoves(stale, pending, 1000 + HOLD_MS, HOLD_MS)).toEqual([])
    })
})

describe('moving by one lane or one section', () => {
    it('steps through the lanes in board order, stopping at either end', () => {
        expect(laneAfter('open', 1)).toBe('doing')
        expect(laneAfter('waiting', -1)).toBe('doing')
        expect(laneAfter('open', -1)).toBeUndefined()
        expect(laneAfter('cancelled', 1)).toBeUndefined()
    })

    it('steps through the priorities, with No priority (null) below P3', () => {
        expect(sectionAfter(1, 1)).toBe(2)
        expect(sectionAfter(3, 1)).toBeNull()
        expect(sectionAfter(null, -1)).toBe(3)
        // Nothing above P1 or below No priority.
        expect(sectionAfter(1, -1)).toBeUndefined()
        expect(sectionAfter(null, 1)).toBeUndefined()
    })
})

// The card a Task Detail shows, on each read of the board. The index lags the Task Detail's editor,
// and the words and line it knows a task by are both things the Task Detail is there to change.
describe('taskDetailCard', () => {
    const last = { document: 'Acme', line: 3, label: 'Send the quote' }

    it('finds the task by what its line says now, once the index has read the edit', () => {
        const edited = card('Send the quote today', 'Acme', 3)
        const snapshot = board([['open', 1, [card('Call Sam', 'Acme', 1), edited]]])
        expect(taskDetailCard(snapshot, last, { line: 3, text: '  - [ ] #P1 Send the quote today' })).toBe(edited)
    })

    it('keeps the card it last found while the index has yet to read the edit', () => {
        const before = card('Send the quote', 'Acme', 3)
        const snapshot = board([['open', 1, [before]]])
        expect(taskDetailCard(snapshot, last, { line: 3, text: '- [ ] #P1 Send the quote tod' })).toBe(before)
    })

    it('follows the task to another line, taking the one nearest the editor’s line when the words repeat', () => {
        const far = card('Send the quote', 'Acme', 1)
        const near = card('Send the quote', 'Acme', 9)
        const snapshot = board([['open', 1, [far, near]]])
        expect(taskDetailCard(snapshot, last, { line: 8, text: '- [ ] Send the quote' })).toBe(near)
    })

    it('matches the document whatever its case, and never a card in another document', () => {
        const elsewhere = card('Send the quote today', 'Beta', 3)
        const here = card('Send the quote today', 'acme', 5)
        const snapshot = board([['open', 1, [elsewhere, here]]])
        expect(taskDetailCard(snapshot, last, { line: 5, text: '- [ ] Send the quote today' })).toBe(here)
    })

    it('falls back to the words it last had when its line is no longer a task, or it has none', () => {
        const moved = card('Send the quote', 'Acme', 6)
        const snapshot = board([['open', 1, [moved]]])
        expect(taskDetailCard(snapshot, last, { line: 3, text: 'some prose' })).toBe(moved)
        expect(taskDetailCard(snapshot, last, null)).toBe(moved)
    })

    it('finds nothing when the task is not on the board', () => {
        expect(taskDetailCard(board([['open', 1, [card('Call Sam', 'Acme', 1)]]]), last, { line: 3, text: '- [ ] Send the quote' })).toBeNull()
    })
})
