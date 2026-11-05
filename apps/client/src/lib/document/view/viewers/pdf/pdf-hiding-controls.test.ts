import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CONTROLS_SHOWN_MS, HidingControls, type ControlsNeeds } from './pdf-hiding-controls'

const READING: ControlsNeeds = { on: true, opened: false, busy: false }

function harness(needs: ControlsNeeds = READING, typing = () => false) {
    let hidden = false
    const controls = new HidingControls((now) => (hidden = now), typing)
    controls.update(needs)
    return { controls, hidden: () => hidden }
}

describe('the controls that hide while a PDF is read', () => {
    beforeEach(() => void vi.useFakeTimers())
    afterEach(() => void vi.useRealTimers())

    it('hides them a while after they start, and not before', () => {
        const { hidden } = harness()
        vi.advanceTimersByTime(CONTROLS_SHOWN_MS - 1)
        expect(hidden()).toBe(false)
        vi.advanceTimersByTime(1)
        expect(hidden()).toBe(true)
    })

    it('never hides them while it is off, and turning it off brings them back', () => {
        const { controls, hidden } = harness({ ...READING, on: false })
        expect(controls.on).toBe(false)
        vi.advanceTimersByTime(CONTROLS_SHOWN_MS * 2)
        expect(hidden()).toBe(false)

        controls.update(READING)
        vi.advanceTimersByTime(CONTROLS_SHOWN_MS)
        expect(hidden()).toBe(true)
        controls.update({ ...READING, on: false })
        expect(hidden()).toBe(false)
    })

    it('toggles them, hiding at once and bringing them back for the full time', () => {
        const { controls, hidden } = harness()
        expect(controls.toggle()).toBe(false)
        expect(hidden()).toBe(true)

        vi.advanceTimersByTime(CONTROLS_SHOWN_MS * 2)
        expect(controls.toggle()).toBe(true)
        expect(hidden()).toBe(false)
        vi.advanceTimersByTime(CONTROLS_SHOWN_MS - 1)
        expect(hidden()).toBe(false)
        vi.advanceTimersByTime(1)
        expect(hidden()).toBe(true)
    })

    it('starts the time again on a press while they are up, and a press while they are hidden leaves them hidden', () => {
        const { controls, hidden } = harness()
        vi.advanceTimersByTime(CONTROLS_SHOWN_MS - 1)
        controls.pressed()
        vi.advanceTimersByTime(CONTROLS_SHOWN_MS - 1)
        expect(hidden()).toBe(false)
        vi.advanceTimersByTime(1)
        expect(hidden()).toBe(true)

        controls.pressed()
        expect(hidden()).toBe(true)
    })

    it('brings them back for something opened, keeps them while it is open, and starts the time when it closes', () => {
        const { controls, hidden } = harness()
        vi.advanceTimersByTime(CONTROLS_SHOWN_MS)
        controls.update({ ...READING, opened: true })
        expect(hidden()).toBe(false)
        vi.advanceTimersByTime(CONTROLS_SHOWN_MS * 3)
        expect(hidden()).toBe(false)
        // A tap on the page does not hide what something open needs.
        expect(controls.toggle()).toBe(true)
        expect(hidden()).toBe(false)

        controls.update(READING)
        vi.advanceTimersByTime(CONTROLS_SHOWN_MS - 1)
        expect(hidden()).toBe(false)
        vi.advanceTimersByTime(1)
        expect(hidden()).toBe(true)
    })

    it('keeps them up while something is in hand, without bringing them back', () => {
        const up = harness()
        up.controls.update({ ...READING, busy: true })
        vi.advanceTimersByTime(CONTROLS_SHOWN_MS * 3)
        expect(up.hidden()).toBe(false)
        up.controls.update(READING)
        vi.advanceTimersByTime(CONTROLS_SHOWN_MS)
        expect(up.hidden()).toBe(true)

        up.controls.update({ ...READING, busy: true })
        expect(up.hidden()).toBe(true)
    })

    it('waits again while a person is typing in a field, and goes once they have stopped', () => {
        let typing = true
        const { hidden } = harness(READING, () => typing)
        vi.advanceTimersByTime(CONTROLS_SHOWN_MS * 3)
        expect(hidden()).toBe(false)
        typing = false
        vi.advanceTimersByTime(CONTROLS_SHOWN_MS)
        expect(hidden()).toBe(true)
    })

    it('brings them back at a key press', () => {
        const { controls, hidden } = harness()
        vi.advanceTimersByTime(CONTROLS_SHOWN_MS)
        controls.show()
        expect(hidden()).toBe(false)
        vi.advanceTimersByTime(CONTROLS_SHOWN_MS)
        expect(hidden()).toBe(true)
    })

    it('stops its clock when the tab goes', () => {
        const { controls, hidden } = harness()
        controls.destroy()
        vi.advanceTimersByTime(CONTROLS_SHOWN_MS)
        expect(hidden()).toBe(false)
    })
})
