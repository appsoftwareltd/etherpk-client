import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { boundsToKeep, DEFAULT_SIZE, parseWindowState, usableBounds } from './window-state.ts'

const screen = { x: 0, y: 0, width: 1920, height: 1040 }
const at = (x: number, y: number, width = 800, height = 600) => ({ bounds: { x, y, width, height }, maximized: false, scheme: null })

describe('where the window was', () => {
    it('is used while it is on a screen', () => {
        expect(usableBounds(at(100, 100), [screen])).toEqual({ x: 100, y: 100, width: 800, height: 600 })
        expect(usableBounds(at(2000, 100), [screen, { ...screen, x: 1920 }])).toMatchObject({ x: 2000 })
    })
    it('is not when that screen is gone, or the title bar would be out of reach', () => {
        for (const state of [at(2000, 100), at(-790, 100), at(100, -300), at(100, 1030), at(0, 0, 10, 10)]) expect(usableBounds(state, [screen])).toEqual(DEFAULT_SIZE)
    })
    it('does not grow where a window reports more than it was given', () => {
        const asked = { x: 60, y: 70, width: 900, height: 640 }
        const given = { x: 59, y: 69, width: 906, height: 646 }
        expect(boundsToKeep(asked, given, given)).toEqual(asked)
        expect(boundsToKeep(asked, given, { ...given, x: 159, width: 1006 })).toEqual({ ...asked, x: 160, width: 1000 })
        expect(boundsToKeep(asked, { ...given, x: 500 }, { ...given, x: 500 })).toEqual({ ...given, x: 500 })
        expect(boundsToKeep(null, null, given)).toEqual(given)
    })
    it('property: any kept text is read', () => {
        fc.assert(fc.property(fc.oneof(fc.json(), fc.string(), fc.constant(null)), (text) => {
            const state = parseWindowState(text)
            expect(usableBounds(state, [screen]).width).toBeGreaterThan(0)
        }), { seed: 20261125, numRuns: 500 })
    })
})
