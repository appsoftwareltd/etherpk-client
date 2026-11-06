import { describe, expect, it } from 'vitest'

import { drawingImage, drawingImageName, imageScale, MOST_IMAGE_SIDE } from './drawing-image'

const header = JSON.stringify({ type: 'excalidraw.drawing', version: 1, id: 'k1', background: '#ffffff' })
const fence = (...lines: string[]) => ({ info: 'excalidraw.drawing', body: [header, ...lines], document: 'Garden', ordinal: 0 })

describe('the name of a drawing as an image', () => {
    it('is the document and the word drawing, numbered from a document’s second drawing', () => {
        expect(drawingImageName('Garden', 0)).toBe('Garden drawing')
        expect(drawingImageName('Garden', 1)).toBe('Garden drawing 2')
        expect(drawingImageName('2026-11-06', 2)).toBe('2026-11-06 drawing 3')
    })

    it('is the word drawing alone with no document to name it', () => {
        expect(drawingImageName(null, 0)).toBe('drawing')
        expect(drawingImageName(null, 1)).toBe('drawing 2')
        expect(drawingImageName('///', 0)).toBe('drawing')
    })

    it('leaves out what a file name cannot hold', () => {
        expect(drawingImageName('Garden/Shed: plans?', 0)).toBe('Garden Shed plans drawing')
        expect(drawingImageName('  ..Garden..  ', 0)).toBe('Garden drawing')
        expect(drawingImageName('Garden\u0007\tShed', 0)).toBe('Garden Shed drawing')
    })

    it('keeps a long document name within what a file system allows', () => {
        expect(drawingImageName('Beans '.repeat(60), 0).length).toBeLessThanOrEqual(120)
    })
})

describe('the size of a drawing as an image', () => {
    it('is twice the drawing’s', () => {
        expect(imageScale(640, 360)).toBe(2)
        expect(imageScale(MOST_IMAGE_SIDE / 2, 10)).toBe(2)
    })

    it('scales down until the long side fits, whichever side it is', () => {
        expect(imageScale(MOST_IMAGE_SIDE, 10)).toBe(1)
        expect(imageScale(10, MOST_IMAGE_SIDE * 2)).toBe(0.5)
    })
})

describe('a drawing with nothing to draw', () => {
    const nothing = { drawn: false, reason: "There's nothing in it yet.", tryAgain: false }

    it('says so, with no line but the header', async () => {
        await expect(drawingImage(fence(), async () => null)).resolves.toEqual(nothing)
    })

    it('says so when every shape was deleted', async () => {
        const deleted = JSON.stringify({ id: 'r1', type: 'rectangle', version: 2, versionNonce: 1, isDeleted: true, x: 0, y: 0, width: 10, height: 10 })
        await expect(drawingImage(fence(deleted), async () => null)).resolves.toEqual(nothing)
    })

    it('says so for a share link not yet imported', async () => {
        await expect(drawingImage(fence('https://excalidraw.com/#json=abc,def'), async () => null)).resolves.toEqual(nothing)
    })
})
