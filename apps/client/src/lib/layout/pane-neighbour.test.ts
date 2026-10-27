import { describe, expect, it } from 'vitest'

import { paneToTheRight } from './pane-neighbour'
import type { PaneBounds } from './types'

// Which Pane is "the one to the right" of another, read from where the Panes sit on screen
// (ADR 0155): the Pane whose left edge meets the source's right edge, the one sharing the most
// height with it when several do, the higher one on a tie.

const box = (left: number, top: number, right: number, bottom: number): PaneBounds => ({ left, top, right, bottom })
const pane = (id: string, bounds: PaneBounds) => ({ item: id, bounds })

describe('the Pane to the right', () => {
    it('is the Pane whose left edge meets the right edge, in a row of Panes', () => {
        const source = box(0, 0, 400, 800)
        expect(paneToTheRight(source, [pane('middle', box(400, 0, 800, 800)), pane('far', box(800, 0, 1200, 800))])).toBe('middle')
    })

    it('is none for the rightmost Pane', () => {
        expect(paneToTheRight(box(400, 0, 800, 800), [pane('left', box(0, 0, 400, 800))])).toBeUndefined()
    })

    it('is none for a Pane further right that does not touch', () => {
        expect(paneToTheRight(box(0, 0, 400, 800), [pane('far', box(800, 0, 1200, 800))])).toBeUndefined()
    })

    it('allows for a fraction of a pixel between edges that meet', () => {
        expect(paneToTheRight(box(0, 0, 400.4, 800), [pane('next', box(401, 0, 800, 800))])).toBe('next')
    })

    it('is none for a Pane that meets the edge only above or below the source', () => {
        // A Pane in the right-hand column that sits wholly below the source, touching only at a corner.
        expect(paneToTheRight(box(0, 0, 400, 400), [pane('below', box(400, 400, 800, 800))])).toBeUndefined()
    })

    it('is the one sharing the most height when the right-hand column is split', () => {
        const source = box(0, 0, 400, 500)
        const neighbours = [pane('top', box(400, 0, 800, 200)), pane('bottom', box(400, 200, 800, 800))]
        expect(paneToTheRight(source, neighbours)).toBe('bottom')
    })

    it('is the higher one when two share the same height with the source', () => {
        const source = box(0, 0, 400, 800)
        const neighbours = [pane('bottom', box(400, 400, 800, 800)), pane('top', box(400, 0, 800, 400))]
        expect(paneToTheRight(source, neighbours)).toBe('top')
    })

    it('is the Pane beside a Pane in a split column, not the one beside its neighbour', () => {
        // Left column split top and bottom, one Pane on the right: both left Panes have it to the right.
        const right = pane('right', box(400, 0, 800, 800))
        expect(paneToTheRight(box(0, 0, 400, 400), [pane('lower-left', box(0, 400, 400, 800)), right])).toBe('right')
        expect(paneToTheRight(box(0, 400, 400, 800), [pane('upper-left', box(0, 0, 400, 400)), right])).toBe('right')
    })
})
