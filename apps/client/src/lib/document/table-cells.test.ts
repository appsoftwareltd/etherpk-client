import { describe, expect, it } from 'vitest'

import { findTables } from './markdown-table'
import {
    cellRect,
    cellsAsHtml,
    cellsAsMarkdown,
    cellsOfMarkdownTable,
    cellsOfTabbedText,
    cleanCellText,
    clearCells,
    columnAtOffset,
    emptyCellGuards,
    fillCells,
    HEADER_ROW,
    isCleanCellText,
    pasteCells,
    readCells,
    rectHolds,
    removeColumns,
    removeRows,
    rowCellSpans,
    tableLineOfRow,
    tableRowOfLine,
    wholeTableRect,
} from './table-cells'

/** The text each span holds, which is what the parser reads as the row's cells. */
function texts(line: string, start = 0): string[] {
    return rowCellSpans(line, start).map((span) => line.slice(span.from, span.to))
}

describe('rowCellSpans', () => {
    it('finds each cell of a row, trimmed', () => {
        expect(texts('| Beans | April |')).toEqual(['Beans', 'April'])
        expect(texts('|Beans|April|')).toEqual(['Beans', 'April'])
        expect(texts('|   Beans   |  water the beans |')).toEqual(['Beans', 'water the beans'])
    })

    it('reads a row without its outer pipes', () => {
        expect(texts('Beans | April')).toEqual(['Beans', 'April'])
    })

    it('keeps an escaped pipe inside its cell', () => {
        expect(texts('| a \\| b | either |')).toEqual(['a \\| b', 'either'])
    })

    it('starts past a bullet marker on the header of a table that is a bullet\'s content', () => {
        const line = '- | Month | Savings |'
        expect(texts(line, 2)).toEqual(['Month', 'Savings'])
        expect(rowCellSpans(line, 2)[0].from).toBe(4)
    })

    it('reads an indented row from its first pipe', () => {
        const line = '  | January | 250 |'
        expect(texts(line)).toEqual(['January', '250'])
        expect(rowCellSpans(line)[0]).toEqual({ from: 4, to: 11, open: 3, close: 12 })
    })

    it('puts an empty cell one space past its opening pipe, where there is one', () => {
        expect(rowCellSpans('|     | x |')[0]).toMatchObject({ from: 2, to: 2 })
        expect(rowCellSpans('|  | x |')[0]).toMatchObject({ from: 2, to: 2 })
        expect(rowCellSpans('| | x |')[0]).toMatchObject({ from: 2, to: 2 })
        expect(rowCellSpans('|| x |')[0]).toMatchObject({ from: 1, to: 1 })
    })

    it('reads the cells the parser reads, row by row', () => {
        const text = ['| Crop | Sow |', '| --- | --- |', '| Beans | April |', '| Kale |  |'].join('\n')
        const [table] = findTables(text)
        const lines = text.split('\n')
        expect(texts(lines[0])).toEqual(table.header)
        expect(texts(lines[2])).toEqual(table.rows[0])
        expect(texts(lines[3])).toEqual(table.rows[1])
    })
})

describe('emptyCellGuards', () => {
    it('writes the pipe an emptied end cell needs in a row written without its outer pipes', () => {
        expect(emptyCellGuards('Beans | April', 0, 0)).toEqual({ before: '| ', after: '' })
        expect(emptyCellGuards('Beans | April', 0, 1)).toEqual({ before: '', after: ' |' })
        expect(emptyCellGuards('  Beans | April | 2', 0, 1)).toEqual({ before: '', after: '' })
        expect(emptyCellGuards('Beans', 0, 0)).toEqual({ before: '| ', after: ' |' })
    })

    it('writes nothing for a row that has its outer pipes, or for a cell the row does not have', () => {
        expect(emptyCellGuards('| Beans | April |', 0, 0)).toEqual({ before: '', after: '' })
        expect(emptyCellGuards('| Beans | April |', 0, 1)).toEqual({ before: '', after: '' })
        expect(emptyCellGuards('- | Beans | April |', 2, 0)).toEqual({ before: '', after: '' })
        expect(emptyCellGuards('| Beans |', 0, 4)).toEqual({ before: '', after: '' })
    })
})

describe('columnAtOffset', () => {
    const line = '| Beans | April |'
    const spans = rowCellSpans(line)

    it('names the cell whose room holds the offset', () => {
        expect(columnAtOffset(spans, 3)).toBe(0)
        expect(columnAtOffset(spans, 11)).toBe(1)
    })

    it('gives the ends of the line to the first and last cell', () => {
        expect(columnAtOffset(spans, 0)).toBe(0)
        expect(columnAtOffset(spans, line.length)).toBe(1)
    })

    it('gives a divider to the cell before it', () => {
        expect(columnAtOffset(spans, 8)).toBe(0)
        expect(columnAtOffset(spans, 9)).toBe(1)
    })
})

describe('rows and lines', () => {
    const [table] = findTables(['intro', '| a | b |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |'].join('\n'))

    it('names the header, skips the delimiter row and counts body rows from 0', () => {
        expect(tableRowOfLine(table, 1)).toBe(HEADER_ROW)
        expect(tableRowOfLine(table, 2)).toBeNull()
        expect(tableRowOfLine(table, 3)).toBe(0)
        expect(tableRowOfLine(table, 4)).toBe(1)
        expect(tableRowOfLine(table, 0)).toBeNull()
        expect(tableRowOfLine(table, 5)).toBeNull()
    })

    it('goes back from a row to its line', () => {
        expect(tableLineOfRow(table, HEADER_ROW)).toBe(1)
        expect(tableLineOfRow(table, 1)).toBe(4)
    })
})

describe('cleanCellText', () => {
    it('escapes a bare pipe and leaves an escaped one', () => {
        expect(cleanCellText('a | b')).toBe('a \\| b')
        expect(cleanCellText('a \\| b')).toBe('a \\| b')
        expect(cleanCellText('||')).toBe('\\|\\|')
    })

    it('makes line breaks and tabs spaces', () => {
        expect(cleanCellText('water\nthe\r\nbeans\tnow')).toBe('water the beans now')
    })

    it('leaves ordinary text alone', () => {
        expect(cleanCellText('see [[Garden]] **now**')).toBe('see [[Garden]] **now**')
        expect(isCleanCellText('see [[Garden]]')).toBe(true)
        expect(isCleanCellText('a | b')).toBe(false)
    })
})

describe('a block of cells', () => {
    const [table] = findTables(['| Crop | Sow | Rows |', '| --- | :-: | --: |', '| Beans | April | 2 |', '| Carrots | March | 4 |', '| Kale | May | 1 |'].join('\n'))

    it('is the rectangle between two cells, whichever corner each is', () => {
        expect(cellRect({ row: 1, column: 2 }, { row: HEADER_ROW, column: 0 })).toEqual({ top: HEADER_ROW, bottom: 1, left: 0, right: 2 })
        expect(rectHolds(cellRect({ row: 0, column: 0 }, { row: 1, column: 1 }), { row: 1, column: 0 })).toBe(true)
        expect(rectHolds(cellRect({ row: 0, column: 0 }, { row: 1, column: 1 }), { row: 2, column: 0 })).toBe(false)
        expect(wholeTableRect(table)).toEqual({ top: HEADER_ROW, bottom: 2, left: 0, right: 2 })
    })

    it('reaches the widest row of a table whose rows are not all as wide as its header, and loses none of their cells', () => {
        const [ragged] = findTables(['| Crop | Sow |', '| --- | --- |', '| Beans | April | 2 |', '| Kale |'].join('\n'))
        expect(wholeTableRect(ragged)).toEqual({ top: HEADER_ROW, bottom: 1, left: 0, right: 2 })
        const cleared = clearCells(ragged, { top: 0, bottom: 0, left: 0, right: 0 })
        expect(cleared.header).toEqual(['Crop', 'Sow', ''])
        expect(cleared.rows).toEqual([['', 'April', '2'], ['Kale', '', '']])
        expect(removeColumns(ragged, 2, 2)?.rows).toEqual([['Beans', 'April'], ['Kale']])
    })

    it('reads its cells row by row, the header as its first row', () => {
        expect(readCells(table, { top: HEADER_ROW, bottom: 0, left: 0, right: 1 })).toEqual([
            ['Crop', 'Sow'],
            ['Beans', 'April'],
        ])
    })

    it('clears and fills its cells and leaves the rest', () => {
        const rect = { top: 0, bottom: 1, left: 1, right: 2 }
        expect(clearCells(table, rect).rows).toEqual([['Beans', '', ''], ['Carrots', '', ''], ['Kale', 'May', '1']])
        expect(clearCells(table, rect).header).toEqual(['Crop', 'Sow', 'Rows'])
        expect(fillCells(table, rect, 'x | y').rows[0]).toEqual(['Beans', 'x \\| y', 'x \\| y'])
    })

    it('takes pasted cells from a cell rightwards and downwards, over what was there', () => {
        const { table: pasted, rect } = pasteCells(table, { row: 1, column: 0 }, [['Leeks', 'June'], ['Peas', 'July']])
        expect(pasted.rows).toEqual([['Beans', 'April', '2'], ['Leeks', 'June', '4'], ['Peas', 'July', '1']])
        expect(rect).toEqual({ top: 1, bottom: 2, left: 0, right: 1 })
    })

    it('grows to hold pasted cells that run past its last row and column', () => {
        const { table: pasted, rect } = pasteCells(table, { row: 2, column: 2 }, [['7', 'late'], ['8', 'early']])
        expect(pasted.header).toEqual(['Crop', 'Sow', 'Rows', ''])
        expect(pasted.align).toEqual([null, 'center', 'right', null])
        expect(pasted.rows).toEqual([['Beans', 'April', '2', ''], ['Carrots', 'March', '4', ''], ['Kale', 'May', '7', 'late'], ['', '', '8', 'early']])
        expect(rect).toEqual({ top: 2, bottom: 3, left: 2, right: 3 })
    })

    it('pastes over the header when the paste starts there', () => {
        expect(pasteCells(table, { row: HEADER_ROW, column: 0 }, [['Plant'], ['Peas']]).table).toMatchObject({ header: ['Plant', 'Sow', 'Rows'], rows: [['Peas', 'April', '2'], ['Carrots', 'March', '4'], ['Kale', 'May', '1']] })
    })

    it('removes body rows and columns, never the header and never the last column', () => {
        expect(removeRows(table, 0, 1)?.rows).toEqual([['Kale', 'May', '1']])
        expect(removeRows(table, HEADER_ROW, 0)?.rows).toEqual([['Carrots', 'March', '4'], ['Kale', 'May', '1']])
        expect(removeRows(table, HEADER_ROW, HEADER_ROW)).toBeNull()
        expect(removeColumns(table, 1, 2)).toMatchObject({ header: ['Crop'], align: [null], rows: [['Beans'], ['Carrots'], ['Kale']] })
        expect(removeColumns(table, 0, 2)).toBeNull()
    })
})

describe('cells on the clipboard', () => {
    it('reads rows from text a spreadsheet copied, and leaves words alone', () => {
        expect(cellsOfTabbedText('Beans\tApril\nKale\tMay\n')).toEqual([['Beans', 'April'], ['Kale', 'May']])
        expect(cellsOfTabbedText('one\r\ntwo\tthree')).toEqual([['one'], ['two', 'three']])
        expect(cellsOfTabbedText('water the beans\nand the kale')).toBeNull()
    })

    it('writes a markdown table with the first row as its header, and one cell as its text', () => {
        expect(cellsAsMarkdown([['Crop', 'Rows'], ['Beans', '2']], [null, 'right'])).toBe('| Crop  | Rows |\n| ----- | ---: |\n| Beans | 2    |')
        expect(cellsAsMarkdown([['a \\| b']])).toBe('a | b')
    })

    it('reads back the markdown table it wrote, and no other text', () => {
        const cells = [['Crop', 'Sow'], ['Beans', 'April'], ['Kale', '']]
        expect(cellsOfMarkdownTable(cellsAsMarkdown(cells))).toEqual(cells)
        expect(cellsOfMarkdownTable('intro\n| a | b |\n| - | - |')).toBeNull()
        expect(cellsOfMarkdownTable('just words')).toBeNull()
    })

    it('writes an HTML table with each cell escaped, an escaped pipe as a pipe', () => {
        expect(cellsAsHtml([['a < b', 'x \\| y'], ['1 & 2', '']])).toBe('<table><tbody><tr><td>a &lt; b</td><td>x | y</td></tr><tr><td>1 &amp; 2</td><td></td></tr></tbody></table>')
    })
})
