import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { MENU_GAP, MENU_MARGIN, placeMenu } from './menu-placement'

/**
 * Wherever a menu is asked for, and however small the keyboard leaves the visible area, the menu
 * the person sees is inside it: a menu that fits is wholly inside, margin and all, and one that
 * does not is capped to it. A menu asked for above an anchor, with room above, never covers it.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.SURFACE_FUZZ_SEED
    return { numRuns: Number(process.env.SURFACE_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261119 : Number(seed) }
}

const area = fc.record({
    left: fc.integer({ min: 0, max: 50 }),
    top: fc.integer({ min: 0, max: 400 }),
    width: fc.integer({ min: 200, max: 1400 }),
    height: fc.integer({ min: 150, max: 1000 }),
})
const size = fc.record({ width: fc.integer({ min: 40, max: 180 }), height: fc.integer({ min: 20, max: 1200 }) })
const point = fc.record({ x: fc.integer({ min: -100, max: 1600 }), y: fc.integer({ min: -100, max: 1600 }), above: fc.boolean() })

describe('placeMenu', () => {
    it('keeps the menu inside the visible area, capped to it when it is taller', () => {
        fc.assert(
            fc.property(point, size, area, (at, menu, visible) => {
                const placed = placeMenu(at, menu, visible)
                const height = Math.min(menu.height, placed.maxHeight)
                expect(placed.maxHeight).toBe(visible.height - 2 * MENU_MARGIN)
                expect(placed.x).toBeGreaterThanOrEqual(visible.left + MENU_MARGIN)
                expect(placed.x + menu.width).toBeLessThanOrEqual(visible.left + visible.width - MENU_MARGIN)
                expect(placed.y).toBeGreaterThanOrEqual(visible.top + MENU_MARGIN)
                expect(placed.y + height).toBeLessThanOrEqual(visible.top + visible.height - MENU_MARGIN)
            }),
            fuzz(500),
        )
    })

    it('never covers the anchor it rises from, when there is room above it', () => {
        fc.assert(
            fc.property(point, size, area, (at, menu, visible) => {
                const roomAbove = at.y - (visible.top + MENU_MARGIN)
                fc.pre(at.above && at.y <= visible.top + visible.height - MENU_MARGIN && roomAbove >= menu.height + MENU_GAP)
                expect(placeMenu(at, menu, visible).y + menu.height).toBeLessThanOrEqual(at.y)
            }),
            fuzz(500),
        )
    })
})
