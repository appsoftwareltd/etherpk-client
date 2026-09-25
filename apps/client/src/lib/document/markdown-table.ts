/**
 * A small, pure GFM-table detector for the table grid widget (Dual Mode Editor.md →
 * Inline markdown formatting). Independent of the editor's Lezer parser so it is
 * node-testable and robust. Pure.
 *
 * A table may be an outliner bullet's content — `- | a | b |` on the bullet line, the remaining
 * rows indented to its content column. The bullet marker is structure, not a cell: it is skipped
 * on the header line, so `- | Month | Savings |` reads as the two columns the author wrote, not
 * three with a `-` in the first. This is CommonMark's reading too: a list item is a container
 * whose content is parsed as blocks, so a pipe table under a `- ` is a table inside the item (as
 * GitHub and Obsidian render it), and it ends where the next block begins — a sibling bullet, or a
 * line indented left of the item's content column. The table widget
 * (view/augmentations/markdown-table.ts) leaves that marker as real text, exactly as the bullet
 * image does.
 */

import { markdownLinks } from './markdown-link-target'

import { contentColumn, contentStart, isBulletLine, lineIndent } from './outliner'

export type Align = 'left' | 'center' | 'right' | null

export interface MarkdownTable {
    /** 0-based inclusive source line range. */
    startLine: number
    endLine: number
    /** Offset into the header line where the table begins: past a bullet's indent and marker, else 0. */
    headerStart: number
    header: string[]
    align: Align[]
    rows: string[][]
}

/** Split a table row into trimmed cells, dropping the optional leading/trailing pipes. */
function splitCells(line: string): string[] {
    let s = line.trim()
    if (s.startsWith('|')) s = s.slice(1)
    if (s.endsWith('|')) s = s.slice(0, -1)
    return s.split('|').map((c) => c.trim())
}

/** A line carrying markdown image syntax `![alt](url)` — never a table header, even with a `|` in the alt. */
function hasImageSyntax(line: string): boolean {
    return [...markdownLinks(line)].some((link) => link.bang === '!')
}

function isDelimiterRow(line: string): boolean {
    if (!line.includes('-')) return false
    const cells = splitCells(line)
    return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c))
}

function alignOf(cell: string): Align {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
}

/** All GFM tables in `text`, in document order. */
export function findTables(text: string): MarkdownTable[] {
    const lines = text.split('\n')
    const tables: MarkdownTable[] = []
    let i = 0
    while (i < lines.length) {
        // The outliner's `- ` / `- [ ] ` marker on a bullet line is structure, not the first cell.
        const raw = lines[i]
        const bullet = raw !== undefined && isBulletLine(raw)
        const headerStart = bullet ? contentStart(raw) : 0
        const header = raw?.slice(headerStart)
        const delim = lines[i + 1]
        if (
            header !== undefined &&
            header.includes('|') &&
            header.trim() !== '' &&
            !hasImageSyntax(header) &&
            delim !== undefined &&
            !isBulletLine(delim) && // a bullet line starts a block of its own; it is never a delimiter row
            isDelimiterRow(delim)
        ) {
            const headerCells = splitCells(header)
            const align = splitCells(delim).map(alignOf)
            const rows: string[][] = []
            // A bullet's rows sit at (or right of) its content column; a bullet line ends any table.
            const floor = bullet ? contentColumn(raw) : 0
            const isRow = (line: string) =>
                line.trim() !== '' && line.includes('|') && !isBulletLine(line) && lineIndent(line) >= floor
            let j = i + 2
            while (j < lines.length && isRow(lines[j])) {
                rows.push(splitCells(lines[j]))
                j++
            }
            tables.push({ startLine: i, endLine: j - 1, headerStart, header: headerCells, align, rows })
            i = j
            continue
        }
        i++
    }
    return tables
}
