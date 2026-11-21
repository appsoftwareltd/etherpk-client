import { describe, expect, it } from 'vitest'

import { scrollAfterResize, type StripResize } from './tab-strip-anchor'

/**
 * A tab strip that changes width keeps the tabs beside the edge that moved in place against that
 * edge. Resizing a Pane from its right (widening the right Sidebar, dragging the sash to a Pane on
 * the right) slides the strip's scroll with that edge, so the right-hand tabs keep their place
 * against it. Resizing from the left leaves the scroll alone, so the left-hand tabs keep their
 * place against the left edge. Either way, an active tab that was in view stays in view.
 */

/** Ten tabs of 150px: 1500px of tabs. */
const CONTENT = 1500
const base = { contentWidth: CONTENT, active: null } satisfies Partial<StripResize>

describe('scrollAfterResize', () => {
    it('a strip narrowed from the right keeps its right-hand tabs against the right edge', () => {
        // 600px wide, scrolled to the end; the right edge comes in by 100px.
        const next = scrollAfterResize({ ...base, before: { left: 0, right: 600 }, after: { left: 0, right: 500 }, scroll: 900 })
        expect(next).toBe(1000)
    })

    it('a strip widened from the right slides its scroll back with the edge', () => {
        const next = scrollAfterResize({ ...base, before: { left: 0, right: 500 }, after: { left: 0, right: 600 }, scroll: 400 })
        expect(next).toBe(300)
    })

    it('a strip narrowed from the left keeps its scroll, so its left-hand tabs stay against the left edge', () => {
        const next = scrollAfterResize({ ...base, before: { left: 300, right: 900 }, after: { left: 400, right: 900 }, scroll: 200 })
        expect(next).toBe(200)
    })

    it('a strip widened from the left past the end of its tabs scrolls back only as far as it must', () => {
        // 600 wide at scroll 900 shows the last tab; 700 wide can show no further than 800.
        const next = scrollAfterResize({ ...base, before: { left: 300, right: 900 }, after: { left: 200, right: 900 }, scroll: 900 })
        expect(next).toBe(800)
    })

    it('a strip widened from the right never scrolls before its first tab', () => {
        const next = scrollAfterResize({ ...base, before: { left: 0, right: 500 }, after: { left: 0, right: 800 }, scroll: 100 })
        expect(next).toBe(0)
    })

    it('an active tab in view on the left stays in view when the strip narrows from the right', () => {
        // The active tab (300..450) sits at the left edge of a strip showing 300..900.
        const next = scrollAfterResize({
            ...base,
            before: { left: 0, right: 600 },
            after: { left: 0, right: 400 },
            scroll: 300,
            active: { start: 300, end: 450 },
        })
        expect(next).toBe(300)
    })

    it('an active tab in view on the right stays in view when the strip narrows from the left', () => {
        // The active tab (750..900) is the right-hand one of a strip showing 300..900.
        const next = scrollAfterResize({
            ...base,
            before: { left: 0, right: 600 },
            after: { left: 200, right: 600 },
            scroll: 300,
            active: { start: 750, end: 900 },
        })
        expect(next).toBe(500)
    })

    it('an active tab already out of view is not pulled into view by a resize', () => {
        const next = scrollAfterResize({
            ...base,
            before: { left: 0, right: 600 },
            after: { left: 0, right: 500 },
            scroll: 600,
            active: { start: 0, end: 150 },
        })
        expect(next).toBe(700)
    })

    it('a strip that was hidden, or is hidden now, keeps its scroll', () => {
        expect(scrollAfterResize({ ...base, before: { left: 0, right: 0 }, after: { left: 0, right: 600 }, scroll: 400 })).toBe(400)
        expect(scrollAfterResize({ ...base, before: { left: 0, right: 600 }, after: { left: 0, right: 0 }, scroll: 400 })).toBe(400)
    })
})
