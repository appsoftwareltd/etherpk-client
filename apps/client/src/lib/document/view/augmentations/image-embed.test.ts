import type { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import { editorFixture } from '../testing/editor-state-fixture'
import { imageDecoded, imageEmbedAugmentation, imageKey, markImageDecoded } from './image-embed'

/**
 * The image widget's redraw after a decode (Document Editor.md → Blocks and augmentations; ADR 0022).
 * The decoded `<img>` replaces its placeholder inside the widget's DOM, which CodeMirror does not
 * watch, so the widget marks the decode and dispatches `imageDecoded`, and the field must answer with
 * a widget that is not `eq` to the one on screen: a changed block decoration is what makes CodeMirror
 * measure the visible blocks again. On anything else the field keeps its set, so no other transaction
 * rebuilds the picture. Geometry, and the DOM surviving the redraw, are the browser's:
 * tests-client/block-widget-height-map.test.ts.
 */

/** What this tier reads of the widget: its decode generation and CodeMirror's equality. */
interface ImageWidgetShape {
    decodeGeneration: number
    eq(other: ImageWidgetShape): boolean
}

/** The image widgets in the state's decorations, in document order. */
function imageWidgets(state: EditorState): ImageWidgetShape[] {
    const found: ImageWidgetShape[] = []
    for (const set of state.facet(EditorView.decorations)) {
        if (typeof set === 'function') continue
        for (const cursor = set.iter(); cursor.value; cursor.next()) {
            const widget = cursor.value.spec.widget as Partial<ImageWidgetShape> | undefined
            if (widget && typeof widget.decodeGeneration === 'number') found.push(widget as ImageWidgetShape)
        }
    }
    return found
}

const extensions = [imageEmbedAugmentation({ resolveAsset: () => Promise.resolve(null) })]

describe('the image widget after its picture decodes', () => {
    it('is rebuilt as a widget that is not eq to the one on screen', () => {
        const editor = editorFixture('![pic](decode-a.png)\n\nafter|', { extensions })
        const [before] = imageWidgets(editor.state)
        expect(before.decodeGeneration).toBe(0)

        markImageDecoded(imageKey('decode-a.png'))
        editor.dispatch(editor.state.update({ effects: imageDecoded.of(imageKey('decode-a.png')) }))

        const [after] = imageWidgets(editor.state)
        expect(after.decodeGeneration).toBe(1)
        expect(after.eq(before)).toBe(false)
        expect(before.eq(after)).toBe(false)
    })

    it('keeps its set through a transaction that changes nothing it reads', () => {
        const editor = editorFixture('![pic](decode-b.png)\n\nafter|', { extensions })
        const [before] = imageWidgets(editor.state)

        editor.dispatch(editor.state.update({}))

        expect(imageWidgets(editor.state)[0]).toBe(before)
    })

    it('rebuilds an equal widget for another image, so that picture stays as it is', () => {
        const editor = editorFixture('![one](decode-c.png)\n\n![two](decode-d.png)\n\nafter|', { extensions })
        const [one, two] = imageWidgets(editor.state)

        markImageDecoded(imageKey('decode-d.png'))
        editor.dispatch(editor.state.update({ effects: imageDecoded.of(imageKey('decode-d.png')) }))

        const [oneAfter, twoAfter] = imageWidgets(editor.state)
        expect(oneAfter.eq(one)).toBe(true)
        expect(twoAfter.eq(two)).toBe(false)
    })
})
