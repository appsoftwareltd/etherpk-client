import { undo } from '@codemirror/commands'
import { describe, expect, it } from 'vitest'

import { editorFixture } from '../testing/editor-state-fixture'
import { MIN_DISPLAY_WIDTH, clampDisplayWidth, imageWidthChange } from './image-resize'

describe('clampDisplayWidth', () => {
    it('keeps a width between the minimum and the narrower of the natural size and the column', () => {
        expect(clampDisplayWidth(320, 1200, 700)).toBe(320)
        expect(clampDisplayWidth(900, 1200, 700)).toBe(700)
        expect(clampDisplayWidth(900, 500, 700)).toBe(500)
        expect(clampDisplayWidth(10, 1200, 700)).toBe(MIN_DISPLAY_WIDTH)
    })

    it('rounds to a whole pixel', () => {
        expect(clampDisplayWidth(320.6, 1200, 700)).toBe(321)
    })

    it('never makes a picture smaller than the minimum larger than it is', () => {
        expect(clampDisplayWidth(10, 30, 700)).toBe(30)
        expect(clampDisplayWidth(100, 30, 700)).toBe(30)
    })
})

describe('imageWidthChange', () => {
    const url = '../assets/garden.png'

    /** Apply the change for the image on line `n` (1-based) and return the document. */
    function resize(doc: string, n: number, width: number | null, imageUrl = url): string | null {
        const editor = editorFixture(doc + '§', { caret: '§' })
        const spec = imageWidthChange(editor.state, editor.state.doc.line(n).from, imageUrl, width)
        if (!spec) return null
        editor.dispatch(editor.state.update(spec))
        return editor.state.doc.toString()
    }

    it('writes the width into a bullet image’s alt text', () => {
        expect(resize(`- Notes\n- ![Garden|800](${url})\n`, 2, 320)).toBe(`- Notes\n- ![Garden|320](${url})\n`)
    })

    it('adds a hint to a standalone image that has none', () => {
        expect(resize(`![Garden](${url})\n`, 1, 320)).toBe(`![Garden|320](${url})\n`)
    })

    it('adds a hint to a task’s image', () => {
        expect(resize(`- [ ] ![](${url})\n`, 1, 320)).toBe(`- [ ] ![|320](${url})\n`)
    })

    it('replaces a width x height hint with the width', () => {
        expect(resize(`![Garden|640x480](${url})\n`, 1, 320)).toBe(`![Garden|320](${url})\n`)
    })

    it('removes the hint for null', () => {
        expect(resize(`  ![Garden|800](${url})\n`, 1, null)).toBe(`  ![Garden](${url})\n`)
    })

    it('does nothing when the width is already the hint', () => {
        expect(resize(`![Garden|320](${url})\n`, 1, 320)).toBeNull()
    })

    it('does nothing when the line no longer holds that image', () => {
        expect(resize(`![Garden|800](${url})\n`, 1, 320, '../assets/kitchen.png')).toBeNull()
        expect(resize('- water the beans\n', 1, 320)).toBeNull()
    })

    it('is one undo step of its own', () => {
        const editor = editorFixture(`![Garden|800](${url})\n§`, { caret: '§' })
        editor.dispatch(editor.state.update({ changes: { from: editor.state.doc.length, insert: 'a' }, userEvent: 'input.type' }))
        editor.dispatch(editor.state.update(imageWidthChange(editor.state, 0, url, 320)!))
        expect(editor.state.doc.toString()).toBe(`![Garden|320](${url})\na`)
        undo(editor)
        expect(editor.state.doc.toString()).toBe(`![Garden|800](${url})\na`)
    })
})
