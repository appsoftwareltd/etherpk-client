import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { type Align, type MarkdownTable } from '../markdown-table'
import { addColumns, addRows, buildTable, removeColumn, removeRow, setColumnAlign } from '../markdown-table-edit'
import { tableTextChanges } from './table-edit'

/** `before` with `changes` made, each given in offsets into `before`. */
function apply(before: string, changes: { from: number; to: number; insert: string }[]): string {
    let out = ''
    let at = 0
    for (const change of changes) {
        out += before.slice(at, change.from) + change.insert
        at = change.to
    }
    return out + before.slice(at)
}

const lines = (...rows: string[]) => rows.join('\n')

describe('tableTextChanges', () => {
    const TABLE = lines('| a   | b   |', '| --- | --- |', '| 1   | 2   |', '| 3   | 4   |')

    it('changes nothing for the same text', () => {
        expect(tableTextChanges(TABLE, TABLE)).toEqual([])
    })

    it('adds a row at the end as that row alone', () => {
        const after = lines(TABLE, '|     |     |')
        expect(tableTextChanges(TABLE, after)).toEqual([{ from: TABLE.length, to: TABLE.length, insert: '\n|     |     |' }])
    })

    it('adds a row in the middle as that row alone, and removes one as that row alone', () => {
        const after = lines('| a   | b   |', '| --- | --- |', '| 1   | 2   |', '|     |     |', '| 3   | 4   |')
        const at = TABLE.indexOf('| 3')
        expect(tableTextChanges(TABLE, after)).toEqual([{ from: at, to: at, insert: '|     |     |\n' }])
        expect(tableTextChanges(after, TABLE)).toEqual([{ from: at, to: at + '|     |     |\n'.length, insert: '' }])
    })

    it('changes one cell as a piece of its own line', () => {
        const after = TABLE.replace('| 1   |', '| x   |')
        const at = TABLE.indexOf('1')
        expect(tableTextChanges(TABLE, after)).toEqual([{ from: at, to: at + 1, insert: 'x' }])
    })

    it('adds a row to a table whose columns it lines up as that row and the padding of the others', () => {
        const ragged = lines('| Crop | Sow |', '| --- | --- |', '| Runner beans | April |')
        const after = lines('| Crop         | Sow   |', '| ------------ | ----- |', '| Runner beans | April |', '|              |       |')
        const changes = tableTextChanges(ragged, after)
        expect(apply(ragged, changes)).toBe(after)
        // No change reaches a cell's own text: a caret typing in one stays where it is.
        for (const change of changes) expect(ragged.slice(change.from, change.to)).not.toMatch(/[A-Za-z]/)
    })

    it('adds a column as a piece of each line', () => {
        const after = lines('| a   | b   |     |', '| --- | --- | --- |', '| 1   | 2   |     |', '| 3   | 4   |     |')
        const changes = tableTextChanges(TABLE, after)
        expect(changes).toHaveLength(4)
        expect(apply(TABLE, changes)).toBe(after)
        // Each change is on a line of its own, and none reaches the text of a cell that was there.
        for (const change of changes) expect(TABLE.slice(change.from, change.to)).not.toMatch(/[\n0-9ab]/)
    })
})

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261123 : Number(seed) }
}

const cell = fc.constantFrom('', 'Garden', 'Kitchen', 'water the beans', '12', '[[Garden]]', 'a \\| b')
const table: fc.Arbitrary<MarkdownTable> = fc.integer({ min: 1, max: 4 }).chain((width) =>
    fc.record({
        startLine: fc.constant(0),
        endLine: fc.constant(0),
        headerStart: fc.constant(0),
        header: fc.array(cell, { minLength: width, maxLength: width }),
        align: fc.array(fc.constantFrom<Align>(null, 'left', 'center', 'right'), { minLength: width, maxLength: width }),
        rows: fc.array(fc.array(cell, { minLength: width, maxLength: width }), { maxLength: 4 }),
    }),
)
const EDITS: ((t: MarkdownTable, seed: number) => MarkdownTable | null)[] = [
    (t, seed) => addRows(t, 1, (seed % (t.rows.length + 1)) - 1),
    (t, seed) => removeRow(t, seed % Math.max(t.rows.length, 1)),
    (t, seed) => addColumns(t, (seed % (t.header.length + 1)) - 1, 1),
    (t, seed) => removeColumn(t, seed % t.header.length),
    (t, seed) => setColumnAlign(t, seed % t.header.length, 'right'),
    (t, seed) => ({ ...t, header: t.header.map((text, i) => (i === seed % t.header.length ? text + ' longer than before' : text)) }),
]

describe('the changes of a table edit', () => {
    it('make the table\'s new text from its old, in order, without overlapping', () => {
        fc.assert(
            fc.property(table, fc.nat({ max: EDITS.length - 1 }), fc.nat(), fc.constantFrom('', '  '), (t, which, seed, indent) => {
                const next = EDITS[which](t, seed)
                fc.pre(next !== null)
                const before = buildTable(t, indent)
                const after = buildTable(next!, indent)
                const changes = tableTextChanges(before, after)
                expect(apply(before, changes)).toBe(after)
                changes.forEach((change, i) => {
                    expect(change.from).toBeLessThanOrEqual(change.to)
                    if (i > 0) expect(change.from).toBeGreaterThanOrEqual(changes[i - 1].to)
                })
            }),
            fuzz(500),
        )
    })

    it('leave every line alone that is the same before and after', () => {
        fc.assert(
            fc.property(table, fc.nat(), (t, seed) => {
                fc.pre(t.rows.length > 0)
                const before = buildTable(t)
                const after = buildTable(addRows(t, 1, (seed % (t.rows.length + 1)) - 1))
                const changes = tableTextChanges(before, after)
                expect(changes).toHaveLength(1)
                expect(changes[0].insert.trim().replace(/[| ]/g, '')).toBe('')
                expect(changes[0].to - changes[0].from).toBe(0)
            }),
            fuzz(200),
        )
    })
})
