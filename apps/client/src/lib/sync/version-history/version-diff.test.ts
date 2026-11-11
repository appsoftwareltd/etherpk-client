import { describe, expect, it } from 'vitest'
import { diffVersions, type VersionDiff, type VersionDiffRow } from './version-diff'

/** Every row of every hunk, in order. */
const rowsOf = (diff: VersionDiff): VersionDiffRow[] => diff.hunks.flatMap((hunk) => hunk.rows)
/** A row as `git diff` prints it: a sign and the text. */
const printed = (diff: VersionDiff): string[] =>
    rowsOf(diff).map((row) => `${row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ' '}${row.text}`)

describe('the changes between two versions of a document', () => {
    it('has no hunks when the text is the same', () => {
        const diff = diffVersions('- water the beans\n- dig the bed', '- water the beans\n- dig the bed')
        expect(diff).toEqual({ hunks: [], added: 0, removed: 0, skippedAfter: 0 })
    })

    it('shows a changed line as removed then added, with three lines of context each side', () => {
        const before = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'].join('\n')
        const after = ['one', 'two', 'three', 'four', 'FIVE', 'six', 'seven', 'eight', 'nine'].join('\n')
        const diff = diffVersions(before, after)
        expect(printed(diff)).toEqual([' two', ' three', ' four', '-five', '+FIVE', ' six', ' seven', ' eight'])
        expect(diff.hunks[0].skippedBefore).toBe(1)
        expect(diff.skippedAfter).toBe(1)
        expect({ added: diff.added, removed: diff.removed }).toEqual({ added: 1, removed: 1 })
    })

    it('numbers each row by its line in the version before and in this one', () => {
        const diff = diffVersions('a\nb\nc', 'a\nnew\nb\nc')
        expect(rowsOf(diff).map((row) => [row.kind, row.oldLine, row.newLine])).toEqual([
            ['context', 1, 1],
            ['added', null, 2],
            ['context', 2, 3],
            ['context', 3, 4],
        ])
    })

    it('keeps changes far apart in separate hunks, and joins them when their context meets', () => {
        const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
        const far = [...lines]
        far[1] = 'changed 2'
        far[17] = 'changed 18'
        const apart = diffVersions(lines.join('\n'), far.join('\n'))
        expect(apart.hunks).toHaveLength(2)
        // The first hunk ends at line 5 and the second starts at line 15: lines 6 to 14 are left out.
        expect(apart.hunks[1].skippedBefore).toBe(9)

        const near = [...lines]
        near[5] = 'changed 6'
        near[11] = 'changed 12'
        expect(diffVersions(lines.join('\n'), near.join('\n')).hunks).toHaveLength(1)
    })

    it('shows every line as added when the version before was empty, and as removed when this one is', () => {
        expect(printed(diffVersions('', '- water the beans\n- dig the bed'))).toEqual(['+- water the beans', '+- dig the bed'])
        expect(printed(diffVersions('- water the beans', ''))).toEqual(['-- water the beans'])
    })

    it('finds the fewest changes, so lines that stayed are shown as context', () => {
        const before = ['a', 'b', 'c', 'a', 'b', 'b', 'a']
        const after = ['c', 'b', 'a', 'b', 'a', 'c']
        const diff = diffVersions(before.join('\n'), after.join('\n'), { context: Number.POSITIVE_INFINITY })
        // The shortest edit script between these two is five lines (Myers, 1986).
        expect(diff.added + diff.removed).toBe(5)
        const rows = rowsOf(diff)
        expect(rows.filter((r) => r.kind !== 'added').map((r) => r.text)).toEqual(before)
        expect(rows.filter((r) => r.kind !== 'removed').map((r) => r.text)).toEqual(after)
    })

    it('reads \\r\\n, \\r and \\n as line ends, and a final line break adds no empty line', () => {
        expect(diffVersions('a\r\nb\r\n', 'a\nb').hunks).toEqual([])
        expect(printed(diffVersions('a\rb\n', 'a\nc\n'))).toEqual([' a', '-b', '+c'])
    })

    it('shows the texts as replaced outright when they differ too much to search for the fewest changes', () => {
        const before = Array.from({ length: 50 }, (_, i) => `old ${i}`)
        const after = Array.from({ length: 50 }, (_, i) => `new ${i}`)
        const diff = diffVersions(['same', ...before, 'end'].join('\n'), ['same', ...after, 'end'].join('\n'), { maxEdits: 10 })
        expect({ added: diff.added, removed: diff.removed }).toEqual({ added: 50, removed: 50 })
        const rows = rowsOf(diff)
        // The lines both texts share at either end are still context.
        expect([rows[0], rows.at(-1)].map((r) => [r?.kind, r?.text])).toEqual([['context', 'same'], ['context', 'end']])
        expect(rows.filter((r) => r.kind === 'removed').map((r) => r.text)).toEqual(before)
        expect(rows.filter((r) => r.kind === 'added').map((r) => r.text)).toEqual(after)
    })

    it('gives every row a key unique in the diff', () => {
        const diff = diffVersions('a\nb\na\nb', 'b\na\nb\na', { context: Number.POSITIVE_INFINITY })
        const keys = rowsOf(diff).map((row) => row.key)
        expect(new Set(keys).size).toBe(keys.length)
    })
})
