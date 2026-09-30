import { describe, expect, it } from 'vitest'

import { DRAG_THRESHOLD_PX, edgeStep, EDGE_MAX_STEP_PX, pastThreshold } from './pointer-drag'

// Dragging a card on a [[Kanban Board]] (ADR 0113): when a press becomes a drag, and how fast the
// board scrolls while a card is held near its edge.

describe('pastThreshold', () => {
    it('keeps a press a click until the pointer has travelled the threshold', () => {
        expect(pastThreshold(0, 0)).toBe(false)
        expect(pastThreshold(DRAG_THRESHOLD_PX - 1, 0)).toBe(false)
        expect(pastThreshold(DRAG_THRESHOLD_PX, 0)).toBe(true)
        expect(pastThreshold(-3, 3)).toBe(true)
    })
})

describe('edgeStep', () => {
    it('does not scroll while the pointer is away from both edges', () => {
        expect(edgeStep(500, 0, 1000)).toBe(0)
        expect(edgeStep(40, 0, 1000)).toBe(0)
        expect(edgeStep(960, 0, 1000)).toBe(0)
    })

    it('scrolls towards the nearer edge, faster the closer the pointer is to it', () => {
        expect(edgeStep(20, 0, 1000)).toBe(-9)
        expect(edgeStep(0, 0, 1000)).toBe(-EDGE_MAX_STEP_PX)
        expect(edgeStep(980, 0, 1000)).toBe(9)
        expect(edgeStep(1000, 0, 1000)).toBe(EDGE_MAX_STEP_PX)
    })

    it('holds the top speed once the pointer is past the edge', () => {
        expect(edgeStep(-50, 0, 1000)).toBe(-EDGE_MAX_STEP_PX)
        expect(edgeStep(1100, 0, 1000)).toBe(EDGE_MAX_STEP_PX)
    })
})
