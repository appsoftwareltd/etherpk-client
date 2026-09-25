/**
 * The shared table-under-caret reading (`table-context.ts`): what the table Commands rewrite,
 * what the Command Menu and Command Bar gate on, and where a new table may be inserted.
 */
import { describe, expect, it } from 'vitest'

import { editorFixture } from './testing/editor-state-fixture'
import { tableAtCaret, tableInsertable } from './table-context'

// `^` marks the caret in these fixtures: `|` is a table cell boundary.
const at = (fixture: string) => editorFixture(fixture, { caret: '^' }).state

describe('tableAtCaret', () => {
    it('is null off a table', () => {
        expect(tableAtCaret(at('prose^\n| a | b |\n| - | - |\n| 1 | 2 |'))).toBeNull()
    })

    it('reads the column and body row, header and separator counting as negative rows', () => {
        expect(tableAtCaret(at('| a | b^ |\n| - | - |\n| 1 | 2 |'))).toMatchObject({ column: 1, bodyRow: -2, columns: 2 })
        expect(tableAtCaret(at('| a | b |\n| -^ | - |\n| 1 | 2 |'))).toMatchObject({ column: 0, bodyRow: -1 })
        expect(tableAtCaret(at('| a | b |\n| - | - |\n| 1^ | 2 |'))).toMatchObject({ column: 0, bodyRow: 0 })
    })

    it('clamps the column to the last one when the caret sits after the closing pipe', () => {
        expect(tableAtCaret(at('| a | b |^\n| - | - |\n| 1 | 2 |'))).toMatchObject({ column: 1, columns: 2 })
        expect(tableAtCaret(at('| a | b |\n| - | - |\n| 1 | 2 | ^'))).toMatchObject({ column: 1, bodyRow: 0 })
    })

    it("starts a bullet's table after its marker, with the rows at the content column", () => {
        const hit = tableAtCaret(at('- | a | b |\n  | - | - |\n  | 1 | 2^ |'))
        expect(hit).toMatchObject({ from: 2, indent: '  ', headerIndent: '', column: 1, bodyRow: 0 })
    })
})

describe('tableInsertable', () => {
    it('allows prose, bullets and headings', () => {
        expect(tableInsertable(at('prose^'))).toBe(true)
        expect(tableInsertable(at('- ^'))).toBe(true)
        expect(tableInsertable(at('# Title^'))).toBe(true)
    })

    it('refuses fenced code and frontmatter', () => {
        expect(tableInsertable(at('```\ncode^\n```'))).toBe(false)
        expect(tableInsertable(at('---\ntitle: x^\n---\nbody'))).toBe(false)
    })

    it('refuses inside a table, where a new header would read as more rows', () => {
        expect(tableInsertable(at('| a | b |\n| - | - |\n| 1^ | 2 |'))).toBe(false)
    })

    it('refuses directly beside a table, where the two would merge', () => {
        // An empty line right under a table: the table would absorb the new rows.
        expect(tableInsertable(at('| a | b |\n| - | - |\n| 1 | 2 |\n^'))).toBe(false)
        // Prose right above a table: the new table would swallow the old one's rows.
        expect(tableInsertable(at('prose^\n| a | b |\n| - | - |'))).toBe(false)
        // An empty line right above a table, likewise.
        expect(tableInsertable(at('^\n| a | b |\n| - | - |'))).toBe(false)
        // One blank line between is enough.
        expect(tableInsertable(at('| a | b |\n| - | - |\n| 1 | 2 |\n\n^'))).toBe(true)
        // An empty bullet under a table is fine: the bullet line ends the table above it.
        expect(tableInsertable(at('| a | b |\n| - | - |\n| 1 | 2 |\n- ^'))).toBe(true)
    })
})
