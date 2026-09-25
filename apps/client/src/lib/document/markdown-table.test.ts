import { describe, expect, it } from 'vitest'

import { findTables } from './markdown-table'

describe('findTables', () => {
    it('returns nothing when there is no table', () => {
        expect(findTables('just prose\n- a bullet')).toEqual([])
    })

    it('parses a basic table with alignment', () => {
        const text = ['| Name | Age |', '| :--- | --: |', '| Ann | 30 |', '| Bob | 25 |'].join('\n')
        const [t] = findTables(text)
        expect(t).toMatchObject({ startLine: 0, endLine: 3 })
        expect(t.header).toEqual(['Name', 'Age'])
        expect(t.align).toEqual(['left', 'right'])
        expect(t.rows).toEqual([
            ['Ann', '30'],
            ['Bob', '25'],
        ])
    })

    it('requires a delimiter row right after the header', () => {
        expect(findTables('| a | b |\nnot a delimiter')).toEqual([])
    })

    it('locates a table embedded in surrounding prose', () => {
        const text = ['# Heading', '', '| x | y |', '| - | - |', '| 1 | 2 |', '', 'after'].join('\n')
        const [t] = findTables(text)
        expect(t).toMatchObject({ startLine: 2, endLine: 4 })
        expect(t.header).toEqual(['x', 'y'])
    })

    it('tolerates rows without outer pipes', () => {
        const [t] = findTables('a | b\n--- | ---\n1 | 2')
        expect(t.header).toEqual(['a', 'b'])
        expect(t.rows).toEqual([['1', '2']])
    })

    it("skips an outliner bullet marker on the header line: the `-` is structure, not a cell", () => {
        const text = ['- | Month | Savings |', '  | -------- | ------- |', '  | January | $250 |', '  | March | $420 |'].join('\n')
        const [t] = findTables(text)
        expect(t).toMatchObject({ startLine: 0, endLine: 3 })
        expect(t.header).toEqual(['Month', 'Savings'])
        expect(t.rows).toEqual([
            ['January', '$250'],
            ['March', '$420'],
        ])
    })

    it('skips the marker of a nested or task bullet too', () => {
        const [nested] = findTables('  - | a | b |\n    | - | - |\n    | 1 | 2 |')
        expect(nested.header).toEqual(['a', 'b'])
        expect(nested.rows).toEqual([['1', '2']])
        const [task] = findTables('- [ ] | a | b |\n  | - | - |')
        expect(task.header).toEqual(['a', 'b'])
    })

it('records where the table starts on its header line (past a bullet marker)', () => {
        expect(findTables('| a | b |\n| - | - |')[0].headerStart).toBe(0)
        expect(findTables('- | a | b |\n  | - | - |')[0].headerStart).toBe(2)
        expect(findTables('  - | a | b |\n    | - | - |')[0].headerStart).toBe(4)
        expect(findTables('- [ ] | a | b |\n  | - | - |')[0].headerStart).toBe(6)
    })

    it("ends a bullet's table at the next bullet, and at a line left of its content column", () => {
        // A sibling bullet is a new block, not a row — even when it contains a pipe.
        const [t] = findTables('- | a | b |\n  | - | - |\n  | 1 | 2 |\n- next a | b')
        expect(t).toMatchObject({ startLine: 0, endLine: 2 })
        expect(t.rows).toEqual([['1', '2']])
        // A pipe line back at column 0 after an indented bullet table is outside the bullet.
        const [u] = findTables('- | a | b |\n  | - | - |\n| 1 | 2 |')
        expect(u).toMatchObject({ startLine: 0, endLine: 1 })
        expect(u.rows).toEqual([])
    })

    it('never reads a bullet line as a delimiter row or a row of a plain table', () => {
        // Three sibling bullets that happen to hold pipes and dashes are three bullets.
        expect(findTables('- | a | b |\n- | - | - |\n- | 1 | 2 |')).toEqual([])
        const [t] = findTables('| a | b |\n| - | - |\n- | 1 | 2 |')
        expect(t.rows).toEqual([])
    })

    it('does not treat an image line as a table header (the | is a display-size hint, not a column)', () => {
        // A pipe inside an image alt must never be read as a table, even with a delimiter-looking line after.
        expect(findTables('![sonos|800](../assets/sonos.69962b3e.jpg)')).toEqual([])
        expect(findTables('![sonos|800](../assets/x.jpg)\n--- | ---\n1 | 2')).toEqual([])
    })
})
