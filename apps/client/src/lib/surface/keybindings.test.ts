import { describe, expect, it } from 'vitest'

import { createCommandRegistry } from './command-registry'
import { attachKeybindings, eventMatches, formatChord, type KeyEventLike, suppressBrowserChords } from './keybindings'

const ev = (partial: Partial<KeyEventLike> & { key: string }): KeyEventLike => ({
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
})

describe('eventMatches', () => {
    it('matches a bare Alt chord', () => {
        expect(eventMatches('Alt+J', ev({ key: 'j', altKey: true }))).toBe(true)
        expect(eventMatches('Alt+J', ev({ key: 'j' }))).toBe(false)
        expect(eventMatches('Alt+J', ev({ key: 'k', altKey: true }))).toBe(false)
    })

    it('treats Mod as Ctrl or Meta', () => {
        expect(eventMatches('Mod+K', ev({ key: 'k', ctrlKey: true }))).toBe(true)
        expect(eventMatches('Mod+K', ev({ key: 'k', metaKey: true }))).toBe(true)
        expect(eventMatches('Mod+K', ev({ key: 'k' }))).toBe(false)
    })

    it('respects Shift exactly', () => {
        expect(eventMatches('Mod+Shift+K', ev({ key: 'k', ctrlKey: true, shiftKey: true }))).toBe(true)
        expect(eventMatches('Mod+Shift+K', ev({ key: 'k', ctrlKey: true }))).toBe(false)
    })

    it('does not fire a bare chord when an unexpected modifier is held', () => {
        expect(eventMatches('Alt+J', ev({ key: 'j', altKey: true, metaKey: true }))).toBe(false)
    })
})

describe('attachKeybindings', () => {
    function fakeTarget() {
        let handler: ((e: KeyboardEvent) => void) | undefined
        return {
            addEventListener: (_: string, h: (e: KeyboardEvent) => void) => (handler = h),
            removeEventListener: () => (handler = undefined),
            fire: (e: KeyEventLike) => handler?.({ ...e, preventDefault() {} } as unknown as KeyboardEvent),
            isAttached: () => handler !== undefined,
        }
    }

    it('dispatches a matching chord to the registry', async () => {
        const reg = createCommandRegistry()
        let opened = false
        reg.register('document.openTodayJournal', () => (opened = true))
        const target = fakeTarget()
        attachKeybindings(reg, [{ key: 'Alt+J', command: 'document.openTodayJournal' }], target as unknown as Window)
        target.fire(ev({ key: 'j', altKey: true }))
        await Promise.resolve()
        expect(opened).toBe(true)
    })

    it('skips a binding whose command is not registered, and detaches cleanly', () => {
        const reg = createCommandRegistry()
        const target = fakeTarget()
        const detach = attachKeybindings(reg, [{ key: 'Alt+B', command: 'layout.missing' }], target as unknown as Window)
        target.fire(ev({ key: 'b', altKey: true })) // no throw
        detach()
        expect(target.isAttached()).toBe(false)
    })
})

describe('suppressBrowserChords', () => {
    function fakeTarget() {
        let handler: ((e: KeyboardEvent) => void) | undefined
        return {
            addEventListener: (_: string, h: (e: KeyboardEvent) => void) => (handler = h),
            removeEventListener: () => (handler = undefined),
            fire: (e: KeyEventLike) => {
                let prevented = false
                handler?.({ ...e, preventDefault: () => (prevented = true) } as unknown as KeyboardEvent)
                return prevented
            },
            isAttached: () => handler !== undefined,
        }
    }

    it('prevents the default for a listed chord on either Mod key, and nothing else', () => {
        const target = fakeTarget()
        const detach = suppressBrowserChords(['Mod+S'], target as unknown as Window)
        expect(target.fire(ev({ key: 's', ctrlKey: true }))).toBe(true)
        expect(target.fire(ev({ key: 's', metaKey: true }))).toBe(true)
        expect(target.fire(ev({ key: 's' }))).toBe(false)
        expect(target.fire(ev({ key: 's', altKey: true }))).toBe(false)
        expect(target.fire(ev({ key: 'k', ctrlKey: true }))).toBe(false)
        detach()
        expect(target.isAttached()).toBe(false)
    })
})

describe('formatChord', () => {
    it('renders Mod as ⌘ on Apple keyboards and Ctrl elsewhere', () => {
        expect(formatChord('Mod+K', true)).toEqual(['⌘', 'K'])
        expect(formatChord('Mod+K', false)).toEqual(['Ctrl', 'K'])
    })

    it('orders modifiers the way a keyboard reads them and names special keys', () => {
        expect(formatChord('Shift+Alt+ArrowUp', false)).toEqual(['Alt', 'Shift', '↑'])
        expect(formatChord('Mod+Shift+Enter', true)).toEqual(['⌘', '⇧', 'Enter'])
        expect(formatChord('Escape', false)).toEqual(['Esc'])
    })

    it('keeps a punctuation key as typed', () => {
        expect(formatChord('Mod+/', false)).toEqual(['Ctrl', '/'])
        expect(formatChord('Mod+.', true)).toEqual(['⌘', '.'])
    })
})
