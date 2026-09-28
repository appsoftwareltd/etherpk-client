/**
 * The caret clamp in Node: `clampColumn` is pure, and the selection filter itself only needs an
 * `EditorState`, so both run here. The browser spec (`tests-client/caret-clamp.test.ts`) keeps the
 * real arrow-key and click paths.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { clampColumn } from './caret-clamp'
import { editorFixture } from './testing/editor-state-fixture'

describe('clampColumn', () => {
    const L = (s: string) => s.split('\n')

    it('is the marker end on a bullet or task line', () => {
        expect(clampColumn(L('- a'), 0)).toBe(2)
        expect(clampColumn(L('  - a'), 0)).toBe(4)
        expect(clampColumn(L('- [ ] a'), 0)).toBe(6)
    })

    it('is the fence column inside a code block, and 0 on the opener itself when it is prose', () => {
        expect(clampColumn(L('- ```\n  x\n  ```'), 1)).toBe(2)
        expect(clampColumn(L('- ```\n  x\n  ```'), 2)).toBe(2)
        expect(clampColumn(L('```\nx\n```'), 0)).toBe(0)
    })

    it('is the continuation floor on a soft line, and 0 on a line short of it, which is prose', () => {
        expect(clampColumn(L('- a\n  x'), 1)).toBe(2)
        expect(clampColumn(L('- a\n   '), 1)).toBe(2) // a blank soft line past the content column
        // Short of the bullet's content column a line is not its continuation (continuationColumn):
        // a space typed at column 0 under a list must leave the caret after that space.
        expect(clampColumn(L('- a\n '), 1)).toBe(0)
        expect(clampColumn(L('- a\n x'), 1)).toBe(0)
    })

    it('is the bullet’s content column on a line the outline reaches across a soft line, a `*` item or a closer', () => {
        // The nearest shallower line above each is not the bullet, so the floor alone reads it as prose;
        // the outline walk gives it to the bullet, and the drawing hangs it at the bullet's column.
        expect(clampColumn(L('- a\n  cont\n    deeper'), 2)).toBe(2)
        expect(clampColumn(L('- a\n  * one\n    * two'), 2)).toBe(2)
        expect(clampColumn(L('- a\n  ```\n  x\n  ```\n    after'), 4)).toBe(2)
        expect(clampColumn(L('  - a\n    cont\n      deeper'), 2)).toBe(4)
    })

    it('is 0 on a blank line under a prose line short of the content column, as it is once text is typed there', () => {
        expect(clampColumn(L('- a\n p\n   \n- b'), 2)).toBe(0)
        expect(clampColumn(L('- a\n p\n   y\n- b'), 2)).toBe(0)
        expect(clampColumn(L('- a\n  cont\n    \n    deeper'), 2)).toBe(2) // under a soft line it is the bullet's, like the line below it
    })

    it('is 0 for prose, headings and blank lines', () => {
        expect(clampColumn(L('text'), 0)).toBe(0)
        expect(clampColumn(L('# h'), 0)).toBe(0)
        expect(clampColumn(L('- a\n\nb'), 1)).toBe(0)
    })
})

describe('caret clamp filter', () => {
    it('snaps a caret placed in the margin right to the content column', () => {
        const editor = editorFixture('- abc|')
        editor.select(1) // between `-` and the space
        expect(editor.fixture()).toBe('- |abc')
    })

    it('flows ArrowLeft at the clamp to the end of the previous line', () => {
        const editor = editorFixture('- a\n- |b')
        editor.select(editor.head() - 1) // a one-position leftward move from the clamp
        expect(editor.fixture()).toBe('- a|\n- b')
    })

    it('leaves prose unclamped', () => {
        const editor = editorFixture('text|')
        editor.select(0)
        expect(editor.fixture()).toBe('|text')
    })

    it('clamps a single-line selection out of the structural prefix, keeping its direction', () => {
        const editor = editorFixture('- abc|')
        editor.select(0, 3) // anchor in the marker, head after "a"
        expect([editor.state.selection.main.anchor, editor.state.selection.main.head]).toEqual([2, 3])
        editor.select(3, 0) // dragged leftward into the marker
        expect([editor.state.selection.main.anchor, editor.state.selection.main.head]).toEqual([3, 2])
        editor.select(0, 1) // wholly inside the marker → a caret at the clamp
        expect(editor.state.selection.main.empty).toBe(true)
        expect(editor.state.selection.main.head).toBe(2)
    })

    it('a selection over the marker cannot eat it: Shift+Enter, Enter and Ctrl+Enter act on the content only', () => {
        for (const [key, after] of [
            ['Shift-Enter', '- \n  |abc'],
            ['Enter', '- \n- |abc'],
            ['Mod-Enter', '- \n|abc'],
        ] as const) {
            const editor = editorFixture('- abc|')
            editor.select(0, 1)
            editor.key(key)
            expect(editor.fixture()).toBe(after)
        }
    })

    it('leaves a multi-line selection to the block selection filter', () => {
        const editor = editorFixture('- abc\n- def|')
        editor.select(0, 8)
        expect(editor.state.selection.main.from).toBe(0)
    })

    it('snaps a caret in the indent of a line the outline gives to a bullet to that bullet’s column', () => {
        const editor = editorFixture('- a\n  cont\n    deeper|')
        editor.select(12) // "- a\n  cont\n" is 11 characters: column 1 of "    deeper"
        expect(editor.fixture()).toBe('- a\n  cont\n  |  deeper')
    })

    it('reads a soft line turned into a heading at once: the line nested under it is prose from then on', () => {
        const editor = editorFixture('- a\n  |x\n    y')
        editor.type('#')
        editor.type(' ')
        editor.select(editor.text().indexOf('    y')) // leaving the heading trims its indent (leave-tidy)
        const line = editor.state.doc.lineAt(editor.head())
        expect([line.text, editor.head() - line.from]).toEqual(['    y', 0])
    })

    it('clamps each end of a range inside one block on its own line, keeping its direction', () => {
        const editor = editorFixture('- a\n  soft|')
        editor.select(0, 8) // from the far left of "- a" into "soft"
        expect(editor.fixture()).toBe('- «a\n  so»ft')
        editor.select(8, 0) // the same drag made upward, into the marker
        expect([editor.state.selection.main.anchor, editor.state.selection.main.head]).toEqual([8, 2])
    })

    it('never lets a caret rest left of the clamp for any placement on any bullet line', () => {
        const lineArb = fc.record({
            indent: fc.integer({ min: 0, max: 3 }),
            task: fc.boolean(),
            text: fc.stringMatching(/^[a-z ]{0,8}$/),
        })
        fc.assert(
            fc.property(fc.array(lineArb, { minLength: 1, maxLength: 4 }), fc.double({ min: 0, max: 1, noNaN: true }), (rows, at) => {
                const doc = rows.map((r) => `${'  '.repeat(r.indent)}- ${r.task ? '[ ] ' : ''}${r.text}`).join('\n')
                const editor = editorFixture(doc + '|')
                editor.select(Math.round(at * doc.length))
                const sel = editor.state.selection.main
                const line = editor.state.doc.lineAt(sel.head)
                expect(sel.head - line.from).toBeGreaterThanOrEqual(clampColumn(doc.split('\n'), line.number - 1))
            }),
            { numRuns: 200, seed: 20260902 },
        )
    })
})

describe('clampColumn — frontmatter', () => {
    const L = (s: string) => s.split('\n')

    it('leaves every frontmatter line unclamped, a YAML list entry included', () => {
        const doc = L('---\ntitle: A\naliases:\n  - B\n---\nbody')
        expect(clampColumn(doc, 0)).toBe(0)
        expect(clampColumn(doc, 3)).toBe(0)
        expect(clampColumn(doc, 4)).toBe(0)
    })

    it('a body line under a YAML list entry is not that entry\'s continuation', () => {
        const doc = L('---\naliases:\n  - B\n---\n    prose')
        expect(clampColumn(doc, 4)).toBe(0)
    })
})
