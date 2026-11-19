import { describe, expect, it } from 'vitest'

import { anchorFromArg, placeMenu } from './menu-placement'

const PHONE = { left: 0, top: 0, width: 390, height: 844 }

describe('placeMenu', () => {
    it('puts a menu asked for at a point with its corner there, when it fits', () => {
        expect(placeMenu({ x: 40, y: 100 }, { width: 200, height: 300 }, PHONE)).toEqual({ x: 40, y: 100, maxHeight: 828 })
    })

    it('puts a menu asked for above an anchor with its foot just above the anchor', () => {
        // A Command Bar button at the foot of the screen: the menu rises from it.
        const anchor = { left: 100, top: 790, right: 140, bottom: 830 }
        expect(placeMenu({ x: anchor.left, y: anchor.top, above: true }, { width: 200, height: 300 }, PHONE)).toEqual({ x: 100, y: 486, maxHeight: 828 })
    })

    it('keeps the menu inside the visible area, which the keyboard shortens', () => {
        // The keyboard covers the lower half: the visible area ends at 420.
        const visible = { left: 0, top: 0, width: 390, height: 420 }
        const placed = placeMenu({ x: 300, y: 380 }, { width: 200, height: 300 }, visible)
        expect(placed).toEqual({ x: 182, y: 112, maxHeight: 404 })
    })

    it('follows a visible area the page has been scrolled within', () => {
        const visible = { left: 0, top: 300, width: 390, height: 420 }
        expect(placeMenu({ x: 10, y: 0 }, { width: 200, height: 100 }, visible).y).toBe(308)
    })

    it('caps a menu taller than the visible area to it, from the top', () => {
        expect(placeMenu({ x: 10, y: 500, above: true }, { width: 200, height: 2000 }, PHONE)).toEqual({ x: 10, y: 8, maxHeight: 828 })
    })
})

describe('anchorFromArg', () => {
    it('reads the box a Command Bar button hands its Command, and nothing else', () => {
        expect(anchorFromArg({ anchor: { left: 1, top: 2, right: 3, bottom: 4 } })).toEqual({ left: 1, top: 2, right: 3, bottom: 4 })
        expect(anchorFromArg(undefined)).toBeNull()
        expect(anchorFromArg({ cols: 3, rows: 2 })).toBeNull()
        expect(anchorFromArg({ anchor: { left: 'a' } })).toBeNull()
    })
})
