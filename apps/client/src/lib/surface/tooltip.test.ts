import { describe, expect, it } from 'vitest'

import { BRIEF_MS, HOVER_DELAY_MS, placeTooltip, TOOLTIP_GAP, TooltipController, type TooltipClock, WARM_MS } from './tooltip'

/**
 * The tooltip's rules, apart from the DOM: when one shows, for how long, and what puts it away.
 * The DOM side (TooltipHost.svelte) only turns pointer, focus and key events into these calls,
 * and `tests-client/tooltips.test.ts` drives it in a browser.
 */

/** A clock the test moves by hand. */
function fakeClock() {
    let time = 0
    let next = 0
    const timers = new Map<number, { at: number; fn: () => void }>()
    const clock: TooltipClock = {
        now: () => time,
        set: (fn, ms) => {
            const id = ++next
            timers.set(id, { at: time + ms, fn })
            return id
        },
        clear: (handle) => void timers.delete(handle as number),
    }
    function advance(ms: number) {
        const until = time + ms
        for (;;) {
            const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
            if (!due) break
            timers.delete(due[0])
            time = due[1].at
            due[1].fn()
        }
        time = until
    }
    return { clock, advance, pending: () => timers.size }
}

function setup() {
    const { clock, advance, pending } = fakeClock()
    const log: string[] = []
    const tips = new TooltipController<string>(
        { show: (target, mode) => log.push(`show ${target} ${mode}`), hide: () => log.push('hide') },
        clock,
    )
    return { tips, advance, pending, log }
}

describe('TooltipController', () => {
    it('shows a hovered control after the delay, and hides it when the pointer leaves', () => {
        const { tips, advance, log } = setup()
        tips.enter('zoom', 'mouse')
        advance(HOVER_DELAY_MS - 1)
        expect(tips.current).toBeNull()
        advance(1)
        expect(tips.current).toEqual({ target: 'zoom', mode: 'hover' })
        tips.leave('zoom')
        expect(tips.current).toBeNull()
        expect(log).toEqual(['show zoom hover', 'hide'])
    })

    it('shows nothing when the pointer leaves before the delay', () => {
        const { tips, advance, log, pending } = setup()
        tips.enter('zoom', 'mouse')
        advance(HOVER_DELAY_MS / 2)
        tips.leave('zoom')
        advance(HOVER_DELAY_MS * 4)
        expect(log).toEqual([])
        expect(pending()).toBe(0)
    })

    it('moves straight to the next control along a toolbar', () => {
        const { tips, advance, log } = setup()
        tips.enter('undo', 'mouse')
        advance(HOVER_DELAY_MS)
        tips.leave('undo')
        advance(WARM_MS - 1)
        tips.enter('redo', 'mouse')
        expect(tips.current).toEqual({ target: 'redo', mode: 'hover' })
        expect(log).toEqual(['show undo hover', 'hide', 'show redo hover'])
    })

    it('waits the whole delay again once the warm spell has passed', () => {
        const { tips, advance } = setup()
        tips.enter('undo', 'mouse')
        advance(HOVER_DELAY_MS)
        tips.leave('undo')
        advance(WARM_MS)
        tips.enter('redo', 'mouse')
        expect(tips.current).toBeNull()
        advance(HOVER_DELAY_MS)
        expect(tips.current?.target).toBe('redo')
    })

    it('treats a pen held over the screen as a hover', () => {
        const { tips, advance } = setup()
        tips.enter('erase', 'pen')
        advance(HOVER_DELAY_MS)
        expect(tips.current).toEqual({ target: 'erase', mode: 'hover' })
    })

    it('takes no notice of a finger passing over, which is not a hover', () => {
        const { tips, advance, log } = setup()
        tips.enter('indent', 'touch')
        advance(HOVER_DELAY_MS * 2)
        expect(log).toEqual([])
    })

    it('puts the tooltip away on a mouse click, and does not bring it back while the pointer stays', () => {
        const { tips, advance, log } = setup()
        tips.enter('save', 'mouse')
        advance(HOVER_DELAY_MS)
        tips.press('mouse')
        tips.tap('save', 'mouse')
        advance(HOVER_DELAY_MS * 4)
        expect(log).toEqual(['show save hover', 'hide'])
    })

    it('cancels a hover still waiting when the control is pressed', () => {
        const { tips, advance, log } = setup()
        tips.enter('save', 'mouse')
        tips.press('mouse')
        advance(HOVER_DELAY_MS * 2)
        expect(log).toEqual([])
    })

    it('shows a tapped control at once, for a moment, then puts it away', () => {
        const { tips, advance, log } = setup()
        tips.press('touch')
        tips.tap('indent', 'touch')
        expect(tips.current).toEqual({ target: 'indent', mode: 'brief' })
        // The finger lifting fires a leave on a touch screen: the tooltip stays for its moment.
        tips.leave('indent')
        advance(BRIEF_MS - 1)
        expect(tips.current?.target).toBe('indent')
        advance(1)
        expect(tips.current).toBeNull()
        expect(log).toEqual(['show indent brief', 'hide'])
    })

    it('shows a tap with a pen as a touch does', () => {
        const { tips } = setup()
        tips.press('pen')
        tips.tap('erase', 'pen')
        expect(tips.current).toEqual({ target: 'erase', mode: 'brief' })
    })

    it('starts a second tap its own full moment', () => {
        const { tips, advance, log } = setup()
        tips.press('touch')
        tips.tap('indent', 'touch')
        advance(BRIEF_MS - 100)
        tips.press('touch')
        tips.tap('outdent', 'touch')
        advance(BRIEF_MS - 1)
        expect(tips.current?.target).toBe('outdent')
        advance(1)
        expect(tips.current).toBeNull()
        expect(log).toEqual(['show indent brief', 'hide', 'show outdent brief', 'hide'])
    })

    it('shows a control reached by keyboard at once, and hides it when the focus moves on', () => {
        const { tips, log } = setup()
        tips.focus('settings')
        expect(tips.current).toEqual({ target: 'settings', mode: 'focus' })
        tips.blur('other')
        expect(tips.current?.target).toBe('settings')
        tips.blur('settings')
        expect(tips.current).toBeNull()
        expect(log).toEqual(['show settings focus', 'hide'])
    })

    it('keeps a focused control\'s tooltip while the mouse passes over it', () => {
        const { tips } = setup()
        tips.focus('settings')
        tips.leave('settings')
        expect(tips.current?.target).toBe('settings')
    })

    it('puts any tooltip away on dismiss, and cancels what was waiting', () => {
        const { tips, advance, log, pending } = setup()
        tips.press('touch')
        tips.tap('indent', 'touch')
        tips.dismiss()
        tips.enter('zoom', 'mouse')
        tips.dismiss()
        advance(BRIEF_MS * 2)
        expect(log).toEqual(['show indent brief', 'hide'])
        expect(pending()).toBe(0)
    })

    it('does not hide twice', () => {
        const { tips, log } = setup()
        tips.dismiss()
        tips.leave('zoom')
        tips.blur('zoom')
        expect(log).toEqual([])
    })
})

describe('placeTooltip', () => {
    const area = { left: 0, top: 0, width: 400, height: 800 }
    const size = { width: 80, height: 28 }

    it('centres the tooltip below a control in a toolbar at the top', () => {
        const anchor = { left: 100, top: 10, right: 132, bottom: 42 }
        expect(placeTooltip(anchor, size, area, 'below')).toEqual({ x: 76, y: 42 + TOOLTIP_GAP, side: 'below' })
    })

    it('puts it above a control in a bar at the foot of the screen', () => {
        const anchor = { left: 100, top: 750, right: 144, bottom: 794 }
        expect(placeTooltip(anchor, size, area, 'below')).toMatchObject({ y: 750 - TOOLTIP_GAP - 28, side: 'above' })
    })

    it('goes above for a finger when there is room, where the finger does not hide it', () => {
        const anchor = { left: 100, top: 300, right: 144, bottom: 344 }
        expect(placeTooltip(anchor, size, area, 'above').side).toBe('above')
    })

    it('keeps a tooltip for a control at the edge of the screen on screen', () => {
        const anchor = { left: 370, top: 10, right: 400, bottom: 40 }
        expect(placeTooltip(anchor, size, area, 'below').x).toBe(400 - 8 - 80)
    })
})
