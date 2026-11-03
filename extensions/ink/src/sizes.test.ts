import { describe, expect, it } from 'vitest'

import { EDITING_HEIGHT, fitPicture, inkHeight, PICTURE_MAX_HEIGHT, PICTURE_MIN_HEIGHT } from './sizes'

describe('the picture’s height in the document', () => {
    it('keeps a drawing that fits at its own size', () => {
        expect(fitPicture(300, 200, 640)).toEqual({ width: 300, height: 200, boxHeight: 200 })
    })

    it('never draws a box shorter than the floor, and never magnifies a small drawing to fill it', () => {
        expect(fitPicture(100, 40, 640)).toEqual({ width: 100, height: 40, boxHeight: PICTURE_MIN_HEIGHT })
    })

    it('shrinks a wide drawing to the column', () => {
        expect(fitPicture(1280, 400, 640)).toEqual({ width: 640, height: 200, boxHeight: 200 })
    })

    it('shrinks a tall drawing to the ceiling', () => {
        expect(fitPicture(400, 960, 640)).toEqual({ width: 200, height: 480, boxHeight: PICTURE_MAX_HEIGHT })
    })
})

describe('the height the editor reserves', () => {
    const header = '{"type":"ink.drawing","version":1,"id":"garden0001","paper":"plain"}'
    const info = (body: string[], editing = false) => ({ info: 'ink.drawing', body, document: 'Garden', ordinal: 0, editing })

    it('is the board’s while edited, the floor for an empty or newer drawing, and the picture’s otherwise', () => {
        expect(inkHeight(info([header], true), 640)).toBe(EDITING_HEIGHT)
        expect(inkHeight(info([header]), 640)).toBe(PICTURE_MIN_HEIGHT)
        expect(inkHeight(info(['{"type":"ink.drawing","version":4}']), 640)).toBe(PICTURE_MIN_HEIGHT)
        // 0..200 tall plus half the width (2) and the margin (16) each side: 236.
        const tall = '{"id":"aaaaaaaa","tool":"pen","colour":"#1e1e1e","size":4,"pts":[0,0,0.5,0,200,0.5]}'
        expect(inkHeight(info([header, tall]), 640)).toBe(236)
    })
})
