import { describe, expect, it } from 'vitest'

import { wheelZoomFactor } from './pdf-pinch'

describe('how far the wheel zooms a PDF', () => {
    it('takes one step of a mouse wheel, however large the browser reports it', () => {
        const step = wheelZoomFactor(-120, 0)
        expect(step).toBeGreaterThan(1.1)
        expect(step).toBeLessThan(1.3)
        expect(wheelZoomFactor(-600, 0)).toBe(step)
        expect(wheelZoomFactor(-3, 1)).toBe(step)
    })

    it('zooms out by the same step it zooms in', () => {
        expect(wheelZoomFactor(120, 0)).toBeCloseTo(1 / wheelZoomFactor(-120, 0))
    })

    it('follows the small movements of a trackpad pinch', () => {
        expect(wheelZoomFactor(-2, 0)).toBeLessThan(wheelZoomFactor(-8, 0))
        expect(wheelZoomFactor(-2, 0)).toBeGreaterThan(1)
    })
})
