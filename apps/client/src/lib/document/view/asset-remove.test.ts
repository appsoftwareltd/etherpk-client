import { describe, expect, it } from 'vitest'

import { canRemoveAssetReference, minimalReplacement, removeAssetReference } from './asset-remove'
import { editorFixture } from './testing/editor-state-fixture'

const IMG = '../assets/chart.a1b2c3d4.png'
const PDF = '../assets/q3-report.a1b2c3d4.pdf'

/** Run the removal over a fixture (caret marked with ¦ so `|` stays available for size hints). */
function remove(doc: string, ref: string, line: number, occurrence = 0): string | false {
    const editor = editorFixture(doc, { caret: '¦' })
    const ran = removeAssetReference({ ref, line, occurrence })(editor as never)
    return ran ? editor.text() : false
}

describe('removeAssetReference', () => {
    it('takes the whole line for a standalone image, leaving no blank behind', () => {
        expect(remove(`¦Before\n![chart](${IMG})\nAfter`, IMG, 2)).toBe('Before\nAfter')
    })

    it('takes the whole line for a bullet whose only content is the image', () => {
        expect(remove(`¦- one\n- ![chart](${IMG})\n- three`, IMG, 2)).toBe('- one\n- three')
    })

    it('takes only the span from prose, closing the sentence up', () => {
        expect(remove(`¦Read [q3](${PDF}) before Friday.`, PDF, 1)).toBe('Read  before Friday.')
    })

    it('leaves children alone when they are still one level under a surviving ancestor', () => {
        const doc = `¦- top\n- ![chart](${IMG})\n  - child\n    - grandchild`

        expect(remove(doc, IMG, 2)).toBe('- top\n  - child\n    - grandchild')
    })

    it('pulls orphaned children up when the image bullet was the top of the tree', () => {
        // Nothing survives above them, so they would float at an indent with no parent at all.
        const doc = `¦- ![chart](${IMG})\n  - child\n    - grandchild`

        expect(remove(doc, IMG, 1)).toBe('- child\n  - grandchild')
    })

    it('removes a last-line image without leaving a trailing blank line', () => {
        expect(remove(`¦Before\n![chart](${IMG})`, IMG, 2)).toBe('Before')
    })

    it('handles a document that is nothing but the image', () => {
        expect(remove(`¦![chart](${IMG})`, IMG, 1)).toBe('')
    })

    it('keeps the display-size hint out of the way', () => {
        expect(remove(`¦![chart|300](${IMG})\ntail`, IMG, 1)).toBe('tail')
    })

    it('removes the occurrence that was acted on, not the first', () => {
        const doc = `¦[a](${PDF}) and [b](${PDF})`

        expect(remove(doc, PDF, 1, 1)).toBe(`[a](${PDF}) and `)
    })

    it('declines when the reference is no longer on that line', () => {
        expect(remove(`¦- one\n- two`, IMG, 2)).toBe(false)
        expect(remove(`¦![chart](${IMG})`, IMG, 9)).toBe(false)
    })

    it('is undoable, because only the bytes are permanent', () => {
        const editor = editorFixture(`¦Before\n![chart](${IMG})\nAfter`, { caret: '¦' })
        removeAssetReference({ ref: IMG, line: 2, occurrence: 0 })(editor as never)
        expect(editor.text()).toBe('Before\nAfter')

        editor.key('Mod-z')

        expect(editor.text()).toContain(IMG)
    })
})

describe('canRemoveAssetReference', () => {
    it('reports whether the reference is still where it was said to be', () => {
        const editor = editorFixture(`¦![chart](${IMG})`, { caret: '¦' })

        expect(canRemoveAssetReference(editor.state, { ref: IMG, line: 1, occurrence: 0 })).toBe(true)
        expect(canRemoveAssetReference(editor.state, { ref: IMG, line: 2, occurrence: 0 })).toBe(false)
        expect(canRemoveAssetReference(editor.state, { ref: PDF, line: 1, occurrence: 0 })).toBe(false)
    })
})

describe('minimalReplacement', () => {
    it('is null when nothing changed', () => {
        expect(minimalReplacement('same', 'same')).toBeNull()
    })

    it('trims the shared prefix and suffix so a heal is not a whole-document rewrite', () => {
        expect(minimalReplacement('- a\n    - b\n- c', '- a\n  - b\n- c')).toEqual({
            from: 6,
            to: 8,
            insert: '',
        })
    })
})
