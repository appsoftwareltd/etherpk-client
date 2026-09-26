import type { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AssetUnavailableError } from '$lib/storage/fs/asset-store'

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

/**
 * An asset whose fetch fails in a way that passes (the connection, a server failing for a moment):
 * the placeholder says it is retrying, in the same box, and stops asking once CodeMirror destroys
 * the widget. The DOM here is a stub (no browser in this tier); the box's height in a real layout
 * is tests-client/synced-asset-upload.test.ts's.
 */
describe('the image widget while its asset cannot be fetched', () => {
    class FakeElement {
        className = ''
        textContent = ''
        alt = ''
        src = ''
        style: Record<string, string> = {}
        dataset: Record<string, string> = {}
        attrs = new Map<string, string>()
        children: FakeElement[] = []
        classList = {
            add: (name: string) => {
                this.className = [...this.className.split(' ').filter(Boolean), name].join(' ')
            },
            contains: (name: string) => this.className.split(' ').includes(name),
        }
        constructor(readonly tag: string) {}
        setAttribute(name: string, value: string) {
            this.attrs.set(name, value)
        }
        getAttribute(name: string) {
            return this.attrs.get(name) ?? null
        }
        appendChild<T extends FakeElement>(child: T): T {
            this.children.push(child)
            return child
        }
        replaceChildren(...children: FakeElement[]) {
            this.children = children
        }
        addEventListener() {}
    }

    /** Every element under `root`, depth first. */
    const descendants = (root: FakeElement): FakeElement[] =>
        root.children.flatMap((child) => [child, ...descendants(child)])

    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    function mount(resolveAsset: () => Promise<null>) {
        vi.useFakeTimers()
        vi.stubGlobal('document', { createElement: (tag: string) => new FakeElement(tag) })
        vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        const editor = editorFixture('![pic](../assets/pic.png)\n\nafter|', {
            extensions: [imageEmbedAugmentation({ resolveAsset })],
        })
        const [widget] = imageWidgets(editor.state) as unknown as Array<{
            toDOM(view: EditorView): FakeElement
            destroy(dom: FakeElement): void
        }>
        const root = widget.toDOM(null as unknown as EditorView)
        return { widget, root }
    }

    it('says it is retrying in the placeholder, as an image rather than a live region', async () => {
        const { root } = mount(async () => {
            throw new AssetUnavailableError('down', { status: 503 })
        })
        await vi.advanceTimersByTimeAsync(0)

        const placeholder = descendants(root).find((node) => node.classList.contains('cm-md-image--loading'))!
        expect(placeholder.classList.contains('cm-md-image--unavailable')).toBe(true)
        expect(placeholder.getAttribute('role')).toBe('img')
        expect(placeholder.getAttribute('aria-label')).toBe('Image not loaded. Retrying')
        expect(placeholder.children.map((child) => child.textContent)).toEqual(['Image not loaded. Retrying…'])
    })

    it('stops asking for the asset once CodeMirror destroys the widget', async () => {
        const resolveAsset = vi.fn(async (): Promise<null> => {
            throw new AssetUnavailableError('down', { status: 503 })
        })
        const { widget, root } = mount(resolveAsset)
        await vi.advanceTimersByTimeAsync(0)

        widget.destroy(root)
        await vi.advanceTimersByTimeAsync(10 * 60_000)
        expect(resolveAsset).toHaveBeenCalledOnce()
    })
})
