import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { holdKeyboardOn, keyboardHeldOn, KeyboardHold, LIFT_GRACE_MS, releaseKeyboardOn } from './keyboard-hold'

/** A port with a clock of its own: what was set on the editor, in order, and `run(ms)` to let time pass. */
function port() {
    const sets: boolean[] = []
    let now = 0
    let timers: { at: number; run: () => void }[] = []
    return {
        sets,
        setManual: (on: boolean) => void sets.push(on),
        after(ms: number, run: () => void) {
            const timer = { at: now + ms, run }
            timers.push(timer)
            return () => void (timers = timers.filter((each) => each !== timer))
        },
        /** Let `ms` pass, running each timer that comes due, in order. */
        run(ms: number) {
            now += ms
            for (;;) {
                const due = timers.filter((each) => each.at <= now).sort((a, b) => a.at - b.at)[0]
                if (!due) return
                timers = timers.filter((each) => each !== due)
                due.run()
            }
        },
    }
}

describe('the keyboard is held through a tap that places no caret', () => {
    it('is held from the touch until the task after the tap', () => {
        const p = port()
        const hold = new KeyboardHold(p)
        hold.press()
        expect(p.sets).toEqual([true])
        hold.lift()
        hold.tapped()
        // The browser decides about the keyboard in the task that delivers the click.
        expect(hold.holding).toBe(true)
        p.run(0)
        expect(p.sets).toEqual([true, false])
        expect(hold.holding).toBe(false)
    })

    it('is let go a moment after a touch that made no tap', () => {
        const p = port()
        const hold = new KeyboardHold(p)
        hold.press()
        hold.lift()
        p.run(LIFT_GRACE_MS - 1)
        expect(hold.holding).toBe(true)
        p.run(1)
        expect(p.sets).toEqual([true, false])
    })

    it('is kept through a second touch that starts before the first is let go', () => {
        const p = port()
        const hold = new KeyboardHold(p)
        hold.press()
        hold.lift()
        hold.press()
        p.run(LIFT_GRACE_MS)
        // The first touch's timer must not let go of the second.
        expect(p.sets).toEqual([true])
        hold.lift()
        hold.tapped()
        p.run(0)
        expect(p.sets).toEqual([true, false])
    })

    it('is let go at once when asked, and a timer left over does nothing', () => {
        const p = port()
        const hold = new KeyboardHold(p)
        hold.press()
        hold.lift()
        hold.release()
        expect(p.sets).toEqual([true, false])
        p.run(LIFT_GRACE_MS)
        expect(p.sets).toEqual([true, false])
    })

    it('does nothing for a lift or a tap with nothing held', () => {
        const p = port()
        const hold = new KeyboardHold(p)
        hold.lift()
        hold.tapped()
        hold.release()
        p.run(LIFT_GRACE_MS)
        expect(p.sets).toEqual([])
    })
})

/** An editor's content, as far as a hold needs one. */
function editor(attributes: Record<string, string> = {}) {
    const held = new Map(Object.entries(attributes))
    return {
        policy: () => held.get('virtualkeyboardpolicy') ?? null,
        hasAttribute: (name: string) => held.has(name),
        setAttribute: (name: string, value: string) => void held.set(name, value),
        removeAttribute: (name: string) => void held.delete(name),
    }
}

/** A document that counts who listens to it, and delivers an event to them. */
function page() {
    const listeners = new Map<string, Set<() => void>>()
    return {
        addEventListener: (type: string, listener: () => void) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(listener),
        removeEventListener: (type: string, listener: () => void) => void listeners.get(type)?.delete(listener),
        listening: () => [...listeners.values()].reduce((count, each) => count + each.size, 0),
        deliver: (type: string) => [...(listeners.get(type) ?? [])].forEach((listener) => listener()),
    }
}

describe('a hold on the page: the policy on the editors, and the document listened to', () => {
    beforeEach(() => void vi.useFakeTimers())
    afterEach(() => void vi.useRealTimers())

    it('puts the policy on through a tap and leaves nothing behind after it', () => {
        const doc = page()
        const content = editor()
        holdKeyboardOn(doc, [content])
        expect(content.policy()).toBe('manual')
        doc.deliver('pointerup')
        doc.deliver('click')
        expect(content.policy()).toBe('manual')
        vi.advanceTimersByTime(0)
        expect(content.policy()).toBeNull()
        expect(doc.listening()).toBe(0)
        expect(keyboardHeldOn(doc)).toBeNull()
    })

    it('leaves nothing behind after a press that made no tap', () => {
        const doc = page()
        const content = editor()
        holdKeyboardOn(doc, [content])
        doc.deliver('pointercancel')
        vi.advanceTimersByTime(LIFT_GRACE_MS)
        expect(content.policy()).toBeNull()
        expect(doc.listening()).toBe(0)
    })

    it('holds the focused editor and the touched one, each once', () => {
        const doc = page()
        const cell = editor()
        const content = editor()
        holdKeyboardOn(doc, [cell, content])
        expect([cell.policy(), content.policy()]).toEqual(['manual', 'manual'])
        expect(keyboardHeldOn(doc)).toBe(2)
        releaseKeyboardOn(doc)
        expect([cell.policy(), content.policy()]).toEqual([null, null])
    })

    it('keeps the hold of a press through a second touch in another editor that starts before it is let go', () => {
        const doc = page()
        const first = editor()
        const second = editor()
        holdKeyboardOn(doc, [first])
        doc.deliver('pointerup')
        holdKeyboardOn(doc, [first, second])
        // The first press's moment has passed: its timer must not take the policy off under the second finger.
        vi.advanceTimersByTime(LIFT_GRACE_MS)
        expect([first.policy(), second.policy()]).toEqual(['manual', 'manual'])
        doc.deliver('pointerup')
        doc.deliver('click')
        vi.advanceTimersByTime(0)
        expect([first.policy(), second.policy()]).toEqual([null, null])
        expect(doc.listening()).toBe(0)
    })

    it('is let go by a touch elsewhere, whichever editor was held', () => {
        const doc = page()
        const content = editor()
        holdKeyboardOn(doc, [content])
        doc.deliver('pointerup')
        releaseKeyboardOn(doc)
        expect(content.policy()).toBeNull()
        expect(doc.listening()).toBe(0)
        vi.advanceTimersByTime(LIFT_GRACE_MS)
        expect(content.policy()).toBeNull()
    })

    it('is let go when its editor goes away, and not when another does', () => {
        const doc = page()
        const content = editor()
        const other = editor()
        holdKeyboardOn(doc, [content])
        releaseKeyboardOn(doc, other)
        expect(content.policy()).toBe('manual')
        releaseKeyboardOn(doc, content)
        expect(content.policy()).toBeNull()
        expect(doc.listening()).toBe(0)
    })

    it('leaves a policy the page set itself where it is', () => {
        const doc = page()
        const content = editor({ virtualkeyboardpolicy: 'manual' })
        holdKeyboardOn(doc, [content])
        releaseKeyboardOn(doc)
        expect(content.policy()).toBe('manual')
    })
})
