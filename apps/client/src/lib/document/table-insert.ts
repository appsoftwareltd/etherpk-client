/**
 * Where a new table lands when the [[Table Size Picker]] accepts (CONTEXT.md → **Table Size
 * Picker**): a pure plan over the caret's line, applied by the picker as one transaction.
 *
 * The rule follows the line the caret is on, never the caret's offset within it, so nothing is
 * ever split. An **empty bullet** takes the table as its content — the header sits after the
 * marker and the rows at the content column, the shape the grid widget renders inline after the
 * dot and the table commands rewrite (`view/augmentations/markdown-table.ts`). An **empty prose
 * line** is replaced at its own indent, which keeps an indented blank line's table inside the
 * block it was a continuation of. Any **other line** gets the table on a new line beneath it at
 * that line's content column: a continuation of a bullet, or prose at the line's indent. The
 * caret was in that block's text, so making a sibling block for the table would be a structural
 * change nobody asked for; an author who wants the table as its own block makes an empty bullet
 * first, which is the case above.
 *
 * Fenced code, frontmatter, and a caret in or directly beside a table are refused before this is
 * asked (`view/table-context.ts`, using {@link tableInsertNeighbours}).
 */

import { buildTable, generateTable } from './markdown-table-edit'
import { bulletContent, contentColumn, contentStart, isBulletLine, lineIndent } from './outliner'

/** The caret's line as CodeMirror describes it: its text and its document offsets. */
export interface CaretLine {
    text: string
    from: number
    to: number
}

export interface TableInsertPlan {
    /** The document range the insertion replaces (empty when it only appends). */
    from: number
    to: number
    insert: string
    /**
     * The first header cell's placeholder ("Column 1"), selected after the insertion so that
     * typing straight away replaces it. Document offsets.
     */
    selectFrom: number
    selectTo: number
}

/** The offset of the first header cell's text within a header line prefixed by `headerPrefix`. */
const CELL_OPEN = '| '.length

/**
 * The neighbouring lines a table inserted at `lineText` would sit against, as offsets from the
 * caret's line. A GFM table runs on through any following non-blank line with a pipe in it, so a
 * new table written directly above or below an existing one merges with it, and the next rewrite
 * would then truncate the wider rows. The insert is refused when any of these lines is in a
 * table. An empty bullet's own line is not a neighbour: a bullet line ends any table above it.
 */
export function tableInsertNeighbours(lineText: string): number[] {
    if (isBulletLine(lineText) && bulletContent(lineText).trim() === '') return [1]
    if (lineText.trim() === '') return [-1, 1]
    return [1]
}

export function planTableInsert(line: CaretLine, cols: number, rows: number): TableInsertPlan {
    const table = generateTable(cols, rows)
    const placeholder = table.header[0]

    if (isBulletLine(line.text) && bulletContent(line.text).trim() === '') {
        // Empty bullet: the header follows the marker on the bullet line; the rows sit at the
        // bullet's content column. Whatever whitespace trailed the marker is replaced.
        const from = line.from + contentStart(line.text)
        const insert = buildTable(table, ' '.repeat(contentColumn(line.text)), '')
        const selectFrom = from + CELL_OPEN
        return { from, to: line.to, insert, selectFrom, selectTo: selectFrom + placeholder.length }
    }

    if (line.text.trim() === '') {
        // Empty line: the table takes its place at the line's own indent.
        const indent = ' '.repeat(lineIndent(line.text))
        const insert = buildTable(table, indent)
        const selectFrom = line.from + indent.length + CELL_OPEN
        return { from: line.from, to: line.to, insert, selectFrom, selectTo: selectFrom + placeholder.length }
    }

    // Anything else: a new line beneath, at the line's content column. Text after the caret
    // stays where it is.
    const indent = ' '.repeat(contentColumn(line.text))
    const insert = '\n' + buildTable(table, indent)
    const selectFrom = line.to + '\n'.length + indent.length + CELL_OPEN
    return { from: line.to, to: line.to, insert, selectFrom, selectTo: selectFrom + placeholder.length }
}
