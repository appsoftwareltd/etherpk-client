import { describe, expect, it } from 'vitest'

import { planTableInsert, tableInsertNeighbours } from './table-insert'

/** A line as the planner sees it, positioned inside a document that starts at `from`. */
function line(text: string, from = 0) {
    return { text, from, to: from + text.length }
}

/** The lines the plan writes, minus a leading newline when it appends below the line. */
function written(text: string, cols = 2, rows = 1, from = 0): string[] {
    return planTableInsert(line(text, from), cols, rows).insert.replace(/^\n/, '').split('\n')
}

describe('tableInsertNeighbours — the lines a new table must not touch', () => {
    it('is the line below for an empty bullet (a bullet line ends any table above it)', () => {
        expect(tableInsertNeighbours('- ')).toEqual([1])
        expect(tableInsertNeighbours('  - [ ] ')).toEqual([1])
    })

    it('is both neighbours for an empty line, which the table replaces', () => {
        expect(tableInsertNeighbours('')).toEqual([-1, 1])
        expect(tableInsertNeighbours('   ')).toEqual([-1, 1])
    })

    it('is the line below for any other line, which the table is appended under', () => {
        expect(tableInsertNeighbours('- note')).toEqual([1])
        expect(tableInsertNeighbours('prose')).toEqual([1])
    })
})

describe('planTableInsert — where a new table lands', () => {
    it('replaces an empty prose line at its own indent', () => {
        const plan = planTableInsert(line(''), 2, 1)
        expect(plan.from).toBe(0)
        expect(plan.to).toBe(0)
        expect(plan.insert.split('\n')).toEqual(['| Column 1 | Column 2 |', '| -------- | -------- |', '|          |          |'])
    })

    it('keeps an indented empty line inside its block (a continuation line)', () => {
        expect(written('    ')).toEqual(['    | Column 1 | Column 2 |', '    | -------- | -------- |', '    |          |          |'])
        const plan = planTableInsert(line('    '), 2, 1)
        expect(plan.from).toBe(0)
        expect(plan.to).toBe(4) // the whitespace is replaced, not kept in front of the table
    })

    it("makes the table an empty bullet's content: header after the marker, rows at the content column", () => {
        const plan = planTableInsert(line('- '), 2, 1)
        expect(plan.from).toBe(2)
        expect(plan.to).toBe(2)
        expect(plan.insert.split('\n')).toEqual(['| Column 1 | Column 2 |', '  | -------- | -------- |', '  |          |          |'])
    })

    it('keeps a task marker and a nested bullet indent in place', () => {
        const plan = planTableInsert(line('  - [ ] '), 2, 1)
        expect(plan.from).toBe(8)
        expect(plan.insert.split('\n')).toEqual(['| Column 1 | Column 2 |', '    | -------- | -------- |', '    |          |          |'])
    })

    it('appends below a non-empty bullet as a continuation of that block, never splitting the line', () => {
        const plan = planTableInsert(line('- note'), 2, 1)
        expect(plan.from).toBe(6)
        expect(plan.to).toBe(6)
        expect(plan.insert.startsWith('\n')).toBe(true)
        expect(written('- note')).toEqual(['  | Column 1 | Column 2 |', '  | -------- | -------- |', '  |          |          |'])
    })

    it('appends below a non-empty prose line at its indent', () => {
        expect(written('Some prose')).toEqual(['| Column 1 | Column 2 |', '| -------- | -------- |', '|          |          |'])
        expect(written('   deeper')).toEqual(['   | Column 1 | Column 2 |', '   | -------- | -------- |', '   |          |          |'])
    })

    it('honours the chosen size: rows exclude the header', () => {
        expect(written('', 3, 2)).toEqual([
            '| Column 1 | Column 2 | Column 3 |',
            '| -------- | -------- | -------- |',
            '|          |          |          |',
            '|          |          |          |',
        ])
        expect(written('', 1, 1)).toEqual(['| Column 1 |', '| -------- |', '|          |'])
    })

    it("selects the first header cell's placeholder so typing replaces it", () => {
        const flat = planTableInsert(line(''), 2, 1)
        expect(flat.insert.slice(flat.selectFrom - flat.from, flat.selectTo - flat.from)).toBe('Column 1')

        const below = planTableInsert(line('- note', 10), 2, 1)
        // `\n` + two spaces of content column + `| ` before the placeholder.
        expect(below.selectFrom).toBe(16 + 1 + 2 + 2)
        expect(below.insert.slice(below.selectFrom - below.from, below.selectTo - below.from)).toBe('Column 1')

        const bullet = planTableInsert(line('- ', 10), 2, 1)
        expect(bullet.selectFrom).toBe(12 + 2)
        expect(bullet.insert.slice(bullet.selectFrom - bullet.from, bullet.selectTo - bullet.from)).toBe('Column 1')
    })
})
