import { describe, expect, it } from 'vitest'

import { drawingHeight, excalidrawOwns, imagesLeftOut } from './widget'

const header = JSON.stringify({ type: 'excalidraw.drawing', version: 1, id: 'k1', background: '#ffffff' })
const rectangle = JSON.stringify({ id: 'r1', type: 'rectangle', version: 1, versionNonce: 1, x: 0, y: 0, width: 160, height: 80 })

describe('drawingHeight', () => {
    it("is the editor's while the drawing is edited, the frame's toolbar being the Client's to add", () => {
        expect(drawingHeight({ body: [header, rectangle], editing: true })).toBe(520)
    })

    it("is the picture's otherwise, at the column's width", () => {
        expect(drawingHeight({ body: [header, rectangle], editing: false }, 680)).toBe(120)
        expect(drawingHeight({ body: [header, JSON.stringify({ id: 'r2', type: 'rectangle', version: 1, versionNonce: 1, x: 0, y: 0, width: 200, height: 300 })] }, 680)).toBe(332)
    })

    it("is an empty drawing's, or an import card's, whatever the editing", () => {
        expect(drawingHeight({ body: [header] })).toBe(120)
        expect(drawingHeight({ body: [header, 'https://excalidraw.com/#json=AbC123_-xyz,abcdefghijklmnopqrstuv'], editing: true })).toBe(148)
    })
})

describe('what the person is told of images left out', () => {
    it('says how to add them, one or several', () => {
        expect(imagesLeftOut(1, 'pasted')).toBe('The drawing was pasted without its image. Paste the image into the drawing to add it.')
        expect(imagesLeftOut(3, 'imported')).toBe('The drawing was imported without its 3 images. Paste the images into the drawing to add them.')
    })
})

describe('excalidrawOwns', () => {
    /** A stand-in element: what the check reads of one. */
    const el = (className: string | null, parent: Element | null = null) =>
        ({ nodeType: 1, parentElement: parent, getAttribute: (name: string) => (name === 'class' ? className : null) }) as unknown as Element
    const text = (parent: Element) => ({ nodeType: 3, parentElement: parent }) as unknown as Node

    it("owns Excalidraw's dialogs, menus and tooltips in the page's body, and everything inside them", () => {
        const dialog = el('excalidraw excalidraw-modal-container')
        expect(excalidrawOwns(dialog)).toBe(true)
        expect(excalidrawOwns(el('Island', el('popover', dialog)))).toBe(true)
        expect(excalidrawOwns(text(el('color-picker', dialog)))).toBe(true)
        expect(excalidrawOwns(el('excalidraw-tooltip'))).toBe(true)
    })

    it("owns nothing else in the page, the Client's own elements included", () => {
        expect(excalidrawOwns(el('cm-line', el('cm-content')))).toBe(false)
        expect(excalidrawOwns(el(null))).toBe(false)
        expect(excalidrawOwns(el('gk-button gk-menu-item', el('gk-fence-frame')))).toBe(false)
        expect(excalidrawOwns(el('notexcalidraw'))).toBe(false)
    })
})
