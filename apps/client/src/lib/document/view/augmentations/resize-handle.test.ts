import { undo } from '@codemirror/commands'
import { describe, expect, it } from 'vitest'

import { editorFixture } from '../testing/editor-state-fixture'
import { MIN_DISPLAY_WIDTH, clampDisplayWidth, displayWidthChange } from './resize-handle'

describe('clampDisplayWidth', () => {
    it('keeps a width between the narrowest and the widest', () => {
        expect(clampDisplayWidth(320, { narrowest: MIN_DISPLAY_WIDTH, widest: 700 })).toBe(320)
        expect(clampDisplayWidth(900, { narrowest: MIN_DISPLAY_WIDTH, widest: 700 })).toBe(700)
        expect(clampDisplayWidth(10, { narrowest: MIN_DISPLAY_WIDTH, widest: 700 })).toBe(MIN_DISPLAY_WIDTH)
        expect(clampDisplayWidth(10, { narrowest: 240, widest: 700 })).toBe(240)
    })

    it('rounds to a whole pixel, never past the widest', () => {
        expect(clampDisplayWidth(320.6, { narrowest: MIN_DISPLAY_WIDTH, widest: 700 })).toBe(321)
        expect(clampDisplayWidth(900, { narrowest: MIN_DISPLAY_WIDTH, widest: 700.8 })).toBe(700)
    })

    it('never makes what is narrower than the narrowest wider than it can be', () => {
        expect(clampDisplayWidth(10, { narrowest: MIN_DISPLAY_WIDTH, widest: 30 })).toBe(30)
        expect(clampDisplayWidth(100, { narrowest: MIN_DISPLAY_WIDTH, widest: 30 })).toBe(30)
    })
})

describe('displayWidthChange', () => {
    const url = '../assets/garden.png'

    /** Apply the change for the image on line `n` (1-based) and return the document. */
    function resize(doc: string, n: number, width: number | null, imageUrl = url): string | null {
        const editor = editorFixture(doc + '§', { caret: '§' })
        const spec = displayWidthChange(editor.state, editor.state.doc.line(n).from, imageUrl, width)
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
        editor.dispatch(editor.state.update(displayWidthChange(editor.state, 0, url, 320)!))
        expect(editor.state.doc.toString()).toBe(`![Garden|320](${url})\na`)
        undo(editor)
        expect(editor.state.doc.toString()).toBe(`![Garden|800](${url})\na`)
    })

    it('writes the width of a recording as of a picture', () => {
        const clip = '../assets/planting.webm'
        expect(resize(`- ![Planting](${clip})\n`, 1, 480, clip)).toBe(`- ![Planting|480](${clip})\n`)
        expect(resize(`![Planting|480](${clip})\n`, 1, null, clip)).toBe(`![Planting](${clip})\n`)
    })
})
