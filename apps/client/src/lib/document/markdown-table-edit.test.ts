import { describe, expect, it } from 'vitest'

import {
    addColumns,
    addRows,
    buildTable,
    cellPosition,
    cursorColumn,
    DEFAULT_CELL_WIDTH,
    formatTable,
    generateTable,
    removeColumn,
    removeColumnsLeft,
    removeColumnsRight,
    removeRow,
    removeRowsAbove,
    removeRowsBelow,
} from './markdown-table-edit'
import { findTables, type MarkdownTable } from './markdown-table'

/** Parse the (single) table out of a markdown snippet. */
function parse(md: string): MarkdownTable {
    const tables = findTables(md)
    expect(tables.length).toBe(1)
    return tables[0]
}

const SAMPLE = ['| A | B | C |', '| - | - | - |', '| 1 | 2 | 3 |', '| 4 | 5 | 6 |'].join('\n')

describe('buildTable', () => {
    it('round-trips a simple table through parse and re-serialise', () => {
        const t = parse(SAMPLE)
        const out = buildTable(t)
        // Re-parsing the output yields the same model content.
        const t2 = parse(out)
        expect(t2.header).toEqual(['A', 'B', 'C'])
        expect(t2.rows).toEqual([
            ['1', '2', '3'],
            ['4', '5', '6'],
        ])
    })

    it('normalises column widths to the widest cell, min DEFAULT_CELL_WIDTH', () => {
        const t = parse('| Name | X |\n| - | - |\n| Alexander | y |')
        const out = buildTable(t).split('\n')
        // Column 0 widened to "Alexander" (9), column 1 floored at min width 3.
        expect(out[0]).toBe('| Name      | X   |')
        expect(out[2]).toBe('| Alexander | y   |')
        expect(DEFAULT_CELL_WIDTH).toBe(3)
    })

    it('renders alignment colons in the separator row', () => {
        const t = parse('| L | C | R |\n| :- | :-: | -: |\n| 1 | 2 | 3 |')
        const sep = buildTable(t).split('\n')[1]
        expect(sep).toBe('| :-- | :-: | --: |')
    })

    it('prefixes every line with the supplied indent', () => {
        const t = parse(SAMPLE)
        const out = buildTable(t, '    ').split('\n')
        expect(out.every((l) => l.startsWith('    | '))).toBe(true)
    })

    it("gives the header its own prefix, for a table rewritten after a bullet's marker", () => {
        const t = parse(SAMPLE)
        const out = buildTable(t, '  ', '').split('\n')
        expect(out[0]).toBe('| A   | B   | C   |')
        expect(out.slice(1).every((l) => l.startsWith('  | '))).toBe(true)
    })
})

describe('cursorColumn', () => {
    it('counts pipes before the cursor', () => {
        const line = '| A | B | C |'
        expect(cursorColumn(line, 2)).toBe(0) // inside "A"
        expect(cursorColumn(line, 6)).toBe(1) // inside "B"
        expect(cursorColumn(line, 10)).toBe(2) // inside "C"
    })

    it('clamps to 0 at the very start', () => {
        expect(cursorColumn('| A |', 0)).toBe(0)
    })

    it('ignores escaped pipes', () => {
        const line = '| a\\|b | c |'
        // The escaped pipe at index 4 must not advance the column.
        expect(cursorColumn(line, 5)).toBe(0)
    })
})

describe('generateTable', () => {
    it('creates placeholder headers and empty body cells', () => {
        const t = generateTable(3, 2)
        expect(t.header).toEqual(['Column 1', 'Column 2', 'Column 3'])
        expect(t.align).toEqual([null, null, null])
        expect(t.rows).toEqual([
            ['', '', ''],
            ['', '', ''],
        ])
    })

    it('serialises to a valid, re-parseable table', () => {
        const out = buildTable(generateTable(2, 1))
        const t = parse(out)
        expect(t.header).toEqual(['Column 1', 'Column 2'])
        expect(t.rows).toEqual([['', '']])
    })
})

describe('addColumns', () => {
    it('inserts an empty column after the given column', () => {
        const t = addColumns(parse(SAMPLE), 0)
        expect(t.header).toEqual(['A', '', 'B', 'C'])
        expect(t.rows[0]).toEqual(['1', '', '2', '3'])
        expect(t.align).toEqual([null, null, null, null])
    })

    it('appends when atColumn is the last column', () => {
        const t = addColumns(parse(SAMPLE), 2, 2)
        expect(t.header).toEqual(['A', 'B', 'C', '', ''])
        expect(t.rows[1]).toEqual(['4', '5', '6', '', ''])
    })

    it('does not mutate the input', () => {
        const original = parse(SAMPLE)
        addColumns(original, 0)
        expect(original.header).toEqual(['A', 'B', 'C'])
    })
})

describe('addRows', () => {
    it('appends empty body rows by default', () => {
        const t = addRows(parse(SAMPLE), 2)
        expect(t.rows.length).toBe(4)
        expect(t.rows[2]).toEqual(['', '', ''])
        expect(t.rows[3]).toEqual(['', '', ''])
    })

    it('inserts after a specific body row index when given', () => {
        const t = addRows(parse(SAMPLE), 1, 0)
        expect(t.rows).toEqual([
            ['1', '2', '3'],
            ['', '', ''],
            ['4', '5', '6'],
        ])
    })
})

describe('formatTable', () => {
    it('is identity on the model (reflow happens in buildTable)', () => {
        const t = parse(SAMPLE)
        expect(formatTable(t)).toEqual(t)
    })
})

describe('removeColumn', () => {
    it('removes the targeted column', () => {
        const t = removeColumn(parse(SAMPLE), 1)!
        expect(t.header).toEqual(['A', 'C'])
        expect(t.rows[0]).toEqual(['1', '3'])
    })

    it('refuses to remove the last remaining column', () => {
        const single = parse('| A |\n| - |\n| 1 |')
        expect(removeColumn(single, 0)).toBeNull()
    })

    it('returns null for an out-of-range column', () => {
        expect(removeColumn(parse(SAMPLE), 9)).toBeNull()
    })
})

describe('removeRow', () => {
    it('removes the targeted body row', () => {
        const t = removeRow(parse(SAMPLE), 0)!
        expect(t.rows).toEqual([['4', '5', '6']])
    })

    it('returns null when there are no body rows', () => {
        const noBody = parse('| A | B |\n| - | - |')
        expect(removeRow(noBody, 0)).toBeNull()
    })

    it('returns null for an out-of-range index', () => {
        expect(removeRow(parse(SAMPLE), 5)).toBeNull()
    })
})

describe('removeRowsAbove / removeRowsBelow', () => {
    it('removes body rows above the index', () => {
        const md = ['| A |', '| - |', '| 1 |', '| 2 |', '| 3 |'].join('\n')
        const t = removeRowsAbove(parse(md), 2)
        expect(t.rows).toEqual([['3']])
    })

    it('is a no-op when removing above the first body row', () => {
        const t = removeRowsAbove(parse(SAMPLE), 0)
        expect(t.rows).toEqual([
            ['1', '2', '3'],
            ['4', '5', '6'],
        ])
    })

    it('removes body rows below the index', () => {
        const md = ['| A |', '| - |', '| 1 |', '| 2 |', '| 3 |'].join('\n')
        const t = removeRowsBelow(parse(md), 0)
        expect(t.rows).toEqual([['1']])
    })

    it('is a no-op when removing below the last body row', () => {
        const t = removeRowsBelow(parse(SAMPLE), 1)
        expect(t.rows.length).toBe(2)
    })
})

describe('removeColumnsLeft / removeColumnsRight', () => {
    it('removes all columns to the left', () => {
        const t = removeColumnsLeft(parse(SAMPLE), 2)!
        expect(t.header).toEqual(['C'])
        expect(t.rows[0]).toEqual(['3'])
    })

    it('refuses when there is nothing to the left', () => {
        expect(removeColumnsLeft(parse(SAMPLE), 0)).toBeNull()
    })

    it('removes all columns to the right', () => {
        const t = removeColumnsRight(parse(SAMPLE), 0)!
        expect(t.header).toEqual(['A'])
        expect(t.rows[1]).toEqual(['4'])
    })

    it('refuses when there is nothing to the right', () => {
        expect(removeColumnsRight(parse(SAMPLE), 2)).toBeNull()
    })
})

describe('end-to-end edits preserve alignment and indentation', () => {
    it('keeps alignment colons through a column insert', () => {
        const t = parse('| L | R |\n| :- | -: |\n| 1 | 2 |')
        const edited = addColumns(t, 0)
        const sep = buildTable(edited).split('\n')[1]
        // New middle column has no alignment; outer columns keep theirs.
        expect(sep).toBe('| :-- | --- | --: |')
    })

    it('keeps alignment through a row removal and re-serialise', () => {
        const t = parse('| L | C |\n| :- | :-: |\n| 1 | 2 |\n| 3 | 4 |')
        const edited = removeRow(t, 0)!
        const out = buildTable(edited).split('\n')
        expect(out[1]).toBe('| :-- | :-: |')
        expect(out[2]).toBe('| 3   | 4   |')
    })

    it('preserves indentation when re-serialising an indented table', () => {
        const md = ['  | A | B |', '  | - | - |', '  | 1 | 2 |'].join('\n')
        const t = parse(md)
        const out = buildTable(t, '  ')
        expect(out.split('\n').every((l) => l.startsWith('  | '))).toBe(true)
    })
})

describe('cellPosition', () => {
    const text = buildTable(generateTable(2, 2)) // "| Column 1 | Column 2 |" / separator / two body rows
    const at = (line: number, col: number) => text.slice(cellPosition(text, line, col), cellPosition(text, line, col) + 8)

    it('lands on the content of the asked-for cell', () => {
        expect(at(0, 0)).toBe('Column 1')
        expect(at(0, 1)).toBe('Column 2')
        expect(cellPosition(text, 1, 0)).toBe(text.indexOf('\n') + 3) // separator: past "| "
        expect(text[cellPosition(text, 2, 1)]).toBe(' ') // an empty body cell
        expect(text.slice(0, cellPosition(text, 2, 1)).split('\n').length).toBe(3)
    })

    it('clamps a row or column the table no longer has to the last one', () => {
        expect(cellPosition(text, 9, 0)).toBe(cellPosition(text, 3, 0))
        expect(cellPosition(text, 0, 9)).toBe(cellPosition(text, 0, 1))
    })

    it('skips escaped pipes when counting cells', () => {
        const escaped = '| a \\| b | c |'
        expect(escaped.slice(cellPosition(escaped, 0, 1))).toBe('c |')
    })
})
