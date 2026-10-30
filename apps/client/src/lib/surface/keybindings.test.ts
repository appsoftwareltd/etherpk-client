import { describe, expect, it } from 'vitest'

import { createCommandRegistry } from './command-registry'
import {
    ariaKeyShortcut,
    attachKeybindings,
    chordsFor,
    createKeybindingTable,
    eventMatches,
    formatChord,
    formatChordHint,
    type Keybinding,
    type KeyEventLike,
    sameChord,
    suppressBrowserChords,
} from './keybindings'

describe('the keybinding table extensions add to', () => {
    it('adds a chord to the live list the window listens with, and takes it out again', () => {
        const table = createKeybindingTable([{ key: 'Alt+J', command: 'document.openTodayJournal' }])
        const remove = table.add({ key: 'Alt+M', command: 'graph-view.reveal' })
        expect(table.bindings.map((binding) => binding.key)).toEqual(['Alt+J', 'Alt+M'])
        remove()
        expect(table.bindings.map((binding) => binding.key)).toEqual(['Alt+J'])
    })

    it('refuses a chord already bound, however it is spelt', () => {
        const table = createKeybindingTable([{ key: 'Alt+Shift+P', command: 'publish.run' }])
        expect(() => table.add({ key: 'shift+alt+p', command: 'kanban.publish' })).toThrow('shift+alt+p is bound already, to publish.run.')
    })

    it('tells a subscriber when a chord is added or taken out, and stops once it unsubscribes', () => {
        const table = createKeybindingTable([{ key: 'Alt+J', command: 'document.openTodayJournal' }])
        let heard = 0
        const unsubscribe = table.subscribe(() => heard++)
        const remove = table.add({ key: 'Alt+M', command: 'maps.openWhole' })
        remove()
        // Taking a binding out twice changes nothing the second time, so nobody is told.
        remove()
        expect(heard).toBe(2)
        unsubscribe()
        table.add({ key: 'Alt+B', command: 'kanban.openWhole' })
        expect(heard).toBe(2)
    })

    it('tells chords apart by their modifiers', () => {
        expect(sameChord('Mod+K', 'mod+k')).toBe(true)
        expect(sameChord('Mod+K', 'Ctrl+K')).toBe(false)
        expect(sameChord('Alt+M', 'Alt+Shift+M')).toBe(false)
    })
})

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

    // On a Mac, Option changes the character a key types: Cmd+Option+F reports "ƒ". With Mod held
    // nothing is being typed, so the key's place on the keyboard decides.
    it('matches a Mod and Alt chord by the key pressed, whatever character Option makes of it', () => {
        expect(eventMatches('Mod+Alt+F', ev({ key: 'ƒ', code: 'KeyF', metaKey: true, altKey: true }))).toBe(true)
        expect(eventMatches('Mod+Alt+F', ev({ key: '∂', code: 'KeyD', metaKey: true, altKey: true }))).toBe(false)
        expect(eventMatches('Alt+J', ev({ key: '∆', code: 'KeyJ', altKey: true }))).toBe(false)
    })

    // Ctrl+Option+K on a Mac reports "˚". AltGr on a Windows layout reports Ctrl and Alt too, and
    // there it types a character (AltGr+K is "ķ" on a Latvian layout), so AltGr keeps typing.
    it('matches a Ctrl and Alt chord by the key pressed, unless AltGr is typing a character', () => {
        expect(eventMatches('Ctrl+Alt+K', ev({ key: '˚', code: 'KeyK', ctrlKey: true, altKey: true }))).toBe(true)
        expect(eventMatches('Ctrl+Alt+K', ev({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true }))).toBe(true)
        expect(eventMatches('Ctrl+Alt+K', ev({ key: 'ķ', code: 'KeyK', ctrlKey: true, altKey: true, altGraph: true }))).toBe(false)
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

    /** Fire one key at a fresh target with the bindings, and say whether its default was prevented. */
    function press(bindings: Keybinding[], event: KeyEventLike, apple = false) {
        const reg = createCommandRegistry()
        const ran: string[] = []
        for (const binding of bindings) if (!reg.has(binding.command)) reg.register(binding.command, () => ran.push(binding.command))
        let handler: ((e: KeyboardEvent) => void) | undefined
        const target = { addEventListener: (_: string, h: (e: KeyboardEvent) => void) => (handler = h), removeEventListener: () => {} }
        attachKeybindings(reg, bindings, target as unknown as Window, apple)
        let prevented = false
        handler?.({ ...event, preventDefault: () => (prevented = true) } as unknown as KeyboardEvent)
        return { prevented, ran }
    }

    it('binds a chord only on the platform it names', async () => {
        const bindings: Keybinding[] = [{ key: 'Ctrl+H', command: 'document.findReplace', platform: 'other' }]
        expect(press(bindings, ev({ key: 'h', ctrlKey: true }), false).prevented).toBe(true)
        // On a Mac, Ctrl+H deletes backwards in a text field, so it stays the browser's there.
        expect(press(bindings, ev({ key: 'h', ctrlKey: true }), true).prevented).toBe(false)
    })

    it("leaves the key to the browser while a binding's condition does not hold", () => {
        let open = false
        const bindings: Keybinding[] = [{ key: 'Mod+F', command: 'document.find', when: () => open }]
        expect(press(bindings, ev({ key: 'f', ctrlKey: true })).prevented).toBe(false)
        open = true
        expect(press(bindings, ev({ key: 'f', ctrlKey: true })).prevented).toBe(true)
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

describe('chordsFor', () => {
    it("lists only the platform's chords when told which platform", () => {
        const bindings: Keybinding[] = [
            { key: 'Ctrl+H', command: 'document.findReplace', platform: 'other' },
            { key: 'Mod+Alt+F', command: 'document.findReplace', platform: 'apple' },
        ]
        expect(chordsFor(bindings, 'document.findReplace', true)).toEqual(['Mod+Alt+F'])
        expect(chordsFor(bindings, 'document.findReplace', false)).toEqual(['Ctrl+H'])
        expect(chordsFor(bindings, 'document.findReplace')).toEqual(['Ctrl+H', 'Mod+Alt+F'])
    })

    it('lists every chord bound to a Command, in the order the table holds them', () => {
        const bindings = [
            { key: 'Mod+K', command: 'search.open' },
            { key: 'Alt+J', command: 'document.openTodayJournal' },
            { key: 'Alt+F', command: 'search.open' },
        ]
        expect(chordsFor(bindings, 'search.open')).toEqual(['Mod+K', 'Alt+F'])
        expect(chordsFor(bindings, 'maps.openWhole')).toEqual([])
    })
})

describe('formatChordHint', () => {
    it('spaces the keys around a plus on Windows and Linux', () => {
        expect(formatChordHint('Mod+K', false)).toBe('Ctrl + K')
        expect(formatChordHint('Alt+Shift+P', false)).toBe('Alt + Shift + P')
    })

    it('runs the symbols together on Apple keyboards, as a Mac menu writes them', () => {
        expect(formatChordHint('Mod+K', true)).toBe('⌘K')
        expect(formatChordHint('Alt+J', true)).toBe('⌥J')
    })
})

describe('ariaKeyShortcut', () => {
    it('names each key as aria-keyshortcuts expects, Mod as Meta on Apple keyboards and Control elsewhere', () => {
        expect(ariaKeyShortcut('Mod+K', false)).toBe('Control+K')
        expect(ariaKeyShortcut('Mod+K', true)).toBe('Meta+K')
        expect(ariaKeyShortcut('Alt+Shift+P', false)).toBe('Alt+Shift+P')
        expect(ariaKeyShortcut('Ctrl+Enter', true)).toBe('Control+Enter')
    })
})
