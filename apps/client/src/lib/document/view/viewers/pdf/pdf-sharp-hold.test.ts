import { describe, expect, it } from 'vitest'

import { REST_MS, SharpRest } from './pdf-sharp-hold'
import { handClock } from './pdf-sharp-hold.fixture'

function harness() {
    const time = handClock()
    let rests = 0
    const rest = new SharpRest(time.clock, () => rests++)
    return { ...time, rest, rests: () => rests }
}

describe('the sharp part of a zoomed PDF page', () => {
    it('is free to be drawn while nothing moves', () => {
        expect(harness().rest.held).toBe(false)
    })

    it('is held while the page scrolls, and drawn once it has been still', () => {
        const { rest, pass, rests } = harness()
        for (let y = 0; y < 600; y += 40) {
            rest.scrolled(0, y)
            pass(16)
            expect(rest.held).toBe(true)
        }
        expect(rests()).toBe(0)
        pass(REST_MS)
        expect(rest.held).toBe(false)
        expect(rests()).toBe(1)
    })

    it('is held while a finger is down, however still, and drawn after it lifts', () => {
        const { rest, pass, rests } = harness()
        rest.touched(1)
        pass(5000)
        expect(rest.held).toBe(true)
        expect(rests()).toBe(0)
        rest.touched(0)
        pass(REST_MS)
        expect(rest.held).toBe(false)
        expect(rests()).toBe(1)
    })

    it('waits for the glide after a flick, not only for the finger', () => {
        const { rest, pass, rests } = harness()
        rest.touched(1)
        rest.scrolled(0, 100)
        rest.touched(0)
        for (let y = 140; y < 2000; y += 40) {
            pass(16)
            rest.scrolled(0, y)
        }
        expect(rests()).toBe(0)
        pass(REST_MS)
        expect(rests()).toBe(1)
    })

    it('does not wait out the crawl a glide ends in', () => {
        const { rest, pass, rests } = harness()
        rest.scrolled(0, 0)
        pass(16)
        rest.scrolled(0, 40)
        // Half a pixel a frame for two seconds: the page looks still.
        for (let step = 1; step <= 120; step++) {
            pass(16)
            rest.scrolled(0, 40 + step * 0.5)
            if (rests() > 0) break
        }
        expect(rests()).toBe(1)
    })

    it('is not drawn at the end of a wait that a finger came down in', () => {
        const { rest, pass, rests } = harness()
        rest.scrolled(0, 100)
        pass(REST_MS - 10)
        rest.touched(2)
        pass(1000)
        expect(rests()).toBe(0)
        rest.touched(1)
        pass(1000)
        expect(rests()).toBe(0)
        rest.touched(0)
        pass(REST_MS)
        expect(rests()).toBe(1)
    })

    it('stops when the reader closes', () => {
        const { rest, pass, rests } = harness()
        rest.scrolled(0, 100)
        rest.stop()
        pass(1000)
        expect(rests()).toBe(0)
    })
})
