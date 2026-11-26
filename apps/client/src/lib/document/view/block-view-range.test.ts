import { describe, expect, it } from 'vitest'

import { outlineBaseIn } from './augmentations/outline-base'
import { blockFingerprintAt } from '../block-link'
import { blockLinkInEditor, blockViewRange, blockViewRoot } from './block-view-range'
import { EXTERNAL } from './cm-document'
import { refusalIn } from './edit-refused'
import { anchorLine, lineAnchor } from './line-anchor'
import { lineShownIn, shownRange, shownRangeIn } from './shown-range'
import { editorFixture } from './testing/editor-state-fixture'

// A [[Block View]]: an editor showing one Block and everything nested under it. The key rules are
// rows in outliner-keymap.rules.test.ts; these are the range, its drawing and the changes that are
// not keys.

const GARDEN = ['- [[Garden]]', '  - Beds', '    - water the beans', '    - weed', '  - Shed', '- Kitchen'].join('\n')

/** An editor on `text` showing the Block on 1-based `line`, the caret at `caret`. */
function showing(text: string, line: number, caret: number) {
    const editor = editorFixture(text.slice(0, caret) + '|' + text.slice(caret), { extensions: [lineAnchor(), shownRange(blockViewRange())] })
    editor.dispatch(editor.state.update({ effects: anchorLine.of(editor.state.doc.line(line).from) }))
    return editor
}

const at = (text: string, words: string) => text.indexOf(words)
const shownLines = (editor: ReturnType<typeof showing>) => editor.text().split('\n').filter((_line, i) => lineShownIn(editor.state, i + 1))

describe('a Block View range', () => {
    it('is the Block and everything nested under it, its own line drawn at the left edge', () => {
        const editor = showing(GARDEN, 2, at(GARDEN, 'weed'))
        expect(shownLines(editor)).toEqual(['  - Beds', '    - water the beans', '    - weed'])
        expect(shownRangeIn(editor.state)).toMatchObject({ nestedUnder: 2, wholeBlock: true })
        expect(outlineBaseIn(editor.state)).toMatchObject({ depth: 1, indent: 2 })
    })

    it('is null on a line that is not a bullet', () => {
        const text = '# Garden\n- Beds'
        expect(shownRangeIn(showing(text, 1, 3).state)).toBeNull()
    })

    it('follows the Block when someone else adds lines above it or under it', () => {
        const editor = showing(GARDEN, 2, at(GARDEN, 'weed'))
        editor.dispatch(editor.state.update({ changes: { from: 0, insert: '- Hall\n' }, annotations: EXTERNAL.of(true) }))
        const end = editor.text().indexOf('weed') + 'weed'.length
        editor.dispatch(editor.state.update({ changes: { from: end, insert: '\n    - mulch' }, annotations: EXTERNAL.of(true) }))
        expect(shownLines(editor)).toEqual(['  - Beds', '    - water the beans', '    - weed', '    - mulch'])
    })

    it('keeps the Block when someone else edits its words', () => {
        const editor = showing(GARDEN, 2, at(GARDEN, 'weed'))
        const words = editor.text().indexOf('Beds')
        editor.dispatch(editor.state.update({ changes: { from: words, to: words + 4, insert: 'Raised beds' }, annotations: EXTERNAL.of(true) }))
        expect(shownLines(editor)[0]).toBe('  - Raised beds')
    })

    it('shows nothing once someone else deletes the Block, rather than the line after it', () => {
        const editor = showing(GARDEN, 2, at(GARDEN, 'weed'))
        const from = at(GARDEN, '  - Beds')
        const to = at(GARDEN, '  - Shed')
        editor.dispatch(editor.state.update({ changes: { from, to }, annotations: EXTERNAL.of(true) }))
        expect(editor.text()).toBe('- [[Garden]]\n  - Shed\n- Kitchen')
        expect(shownRangeIn(editor.state)).toBeNull()
        expect(blockViewRoot(editor.state)).toBeNull()
    })

    it('shows nothing once the person deletes everything it shows', () => {
        const editor = showing(GARDEN, 2, at(GARDEN, 'weed'))
        editor.key('Mod-a')
        editor.key('Backspace')
        expect(editor.text()).toBe('- [[Garden]]\n  - Shed\n- Kitchen')
        expect(shownRangeIn(editor.state)).toBeNull()
    })

    it('refuses an indent or outdent of the Block’s own line, and takes one of a line under it', () => {
        for (const key of ['Tab', 'Shift-Tab']) {
            const editor = showing(GARDEN, 5, at(GARDEN, 'Shed') + 4)
            const before = editor.text()
            editor.key(key)
            expect(editor.text(), key).toBe(before)
        }
        const editor = showing(GARDEN, 2, at(GARDEN, 'weed') + 4)
        editor.key('Tab')
        expect(shownLines(editor)).toEqual(['  - Beds', '    - water the beans', '      - weed'])
        // Outdenting a line the Block holds directly would take it out of the Block.
        editor.key('Shift-Tab')
        editor.key('Shift-Tab')
        expect(shownLines(editor)).toEqual(['  - Beds', '    - water the beans', '    - weed'])
    })

    it('names the Block in the notice for an edit it refuses', () => {
        const editor = showing(GARDEN, 2, at(GARDEN, 'Beds'))
        const tr = editor.state.update({ changes: { from: at(GARDEN, '- [[Garden]]'), insert: 'x' }, userEvent: 'input.type' })
        expect(refusalIn(tr)).toMatchObject({ edge: 'outside', names: { field: 'block' } })
    })

    it('says where the Block is and what it says, with the bullets above it', () => {
        const editor = showing(['---', 'title: Garden', '---', GARDEN].join('\n'), 5, 60)
        expect(blockViewRoot(editor.state)).toEqual({
            line: 1,
            text: '  - Beds',
            ancestors: [{ line: 0, text: '- [[Garden]]' }],
            markdown: '- Beds\n  - water the beans\n  - weed',
        })
    })

    it('links a bullet by its body line and the fingerprint its document’s body gives it', async () => {
        const text = ['---', 'title: Garden', '---', GARDEN].join('\n')
        const editor = showing(text, 5, 60)
        const link = await blockLinkInEditor(editor.state, 6, 'Garden')
        expect(link).toEqual({ document: 'Garden', line: 2, fingerprint: await blockFingerprintAt(GARDEN.split('\n'), 2) })
        expect(await blockLinkInEditor(editor.state, 1, 'Garden')).toBeNull()
    })
})

describe('a Block View of the document’s first Block', () => {
    // Found by block-view.property.test.ts: emptying the first Block left a blank line in its place.
    it('takes the line it leaves empty out, with the break after it', () => {
        const editor = showing('- w0\n- w1', 1, 4)
        for (let i = 0; i < 3; i++) editor.key('Backspace')
        expect(editor.text()).toBe('- w1')
        expect(shownRangeIn(editor.state)).toBeNull()
    })
})

describe('a Block View of a Block emptied and then deleted', () => {
    // Found by block-view.property.test.ts: the anchor slid onto the Block after it.
    it('shows nothing, rather than the Block after it', () => {
        const editor = showing('- w0\n- w1', 1, 2)
        editor.key('Enter')
        editor.key('Mod-a')
        editor.key('Backspace')
        expect(editor.text()).toBe('- w1')
        expect(shownRangeIn(editor.state)).toBeNull()
    })
})
