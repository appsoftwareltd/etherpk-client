/**
 * The [[Plain Paste]] shortcut in Node: which key presses ask for one, and how long the request
 * lasts. The paste itself, and that the browser really pastes on these keys, is covered in the
 * browser (`tests-client/plain-paste.test.ts`); the placement of the text is `paste-clamp.test.ts`.
 */

import { describe, expect, it } from 'vitest'

import { type ChordEvent, isPlainPasteChord, PlainPasteIntent } from './plain-paste'

function key(key: string, modifiers: Partial<Omit<ChordEvent, 'key'>> = {}): ChordEvent {
    return { key, keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...modifiers }
}

describe('isPlainPasteChord', () => {
    const rows: { rule: string; event: ChordEvent; apple: boolean; plain: boolean }[] = [
        { rule: 'Ctrl+Shift+V off Apple platforms', event: key('V', { ctrlKey: true, shiftKey: true }), apple: false, plain: true },
        { rule: 'Cmd+Shift+V on Apple platforms (Chrome and Firefox)', event: key('V', { metaKey: true, shiftKey: true }), apple: true, plain: true },
        // Opt changes the character the key types on a Mac keyboard, so the key code decides.
        { rule: 'Cmd+Opt+Shift+V on Apple platforms (Safari’s own)', event: { ...key('◊', { metaKey: true, shiftKey: true, altKey: true }), keyCode: 86 }, apple: true, plain: true },
        { rule: 'a layout where the V key types another letter, by its key code', event: { ...key('М', { ctrlKey: true, shiftKey: true }), keyCode: 86 }, apple: false, plain: true },
        { rule: 'not Ctrl+V, an ordinary paste', event: key('v', { ctrlKey: true }), apple: false, plain: false },
        { rule: 'not Shift+V, a capital letter', event: key('V', { shiftKey: true }), apple: false, plain: false },
        { rule: 'not Ctrl+Shift+V on Apple platforms, where it pastes nothing', event: key('V', { ctrlKey: true, shiftKey: true }), apple: true, plain: false },
        { rule: 'not Cmd+Shift+V off Apple platforms', event: key('V', { metaKey: true, shiftKey: true }), apple: false, plain: false },
        { rule: 'not Ctrl+Alt+Shift+V off Apple platforms, which no browser pastes on', event: key('V', { ctrlKey: true, shiftKey: true, altKey: true }), apple: false, plain: false },
        { rule: 'not another letter', event: key('B', { ctrlKey: true, shiftKey: true }), apple: false, plain: false },
    ]
    for (const row of rows) {
        it(`${row.plain ? 'is' : 'is not'}: ${row.rule}`, () => {
            expect(isPlainPasteChord(row.event, row.apple)).toBe(row.plain)
        })
    }
})

describe('PlainPasteIntent', () => {
    const chord = key('V', { ctrlKey: true, shiftKey: true })

    it('the paste after the shortcut is plain, and only that paste', () => {
        const intent = new PlainPasteIntent(false)
        intent.keydown(chord)
        expect(intent.take()).toBe(true)
        expect(intent.take()).toBe(false)
    })

    it('a paste with no shortcut before it is ordinary', () => {
        expect(new PlainPasteIntent(false).take()).toBe(false)
    })

    it('holding the modifiers and pressing V again asks again', () => {
        const intent = new PlainPasteIntent(false)
        intent.keydown(chord)
        intent.take()
        intent.keydown(chord)
        expect(intent.take()).toBe(true)
    })

    it('another key after the shortcut withdraws it', () => {
        const intent = new PlainPasteIntent(false)
        intent.keydown(chord)
        intent.keydown(key('v', { ctrlKey: true }))
        expect(intent.take()).toBe(false)
    })

    it('letting go of Shift or the Mod key withdraws it, so a paste from a menu later is ordinary', () => {
        for (const [apple, released] of [
            [false, 'Shift'],
            [false, 'Control'],
            [true, 'Meta'],
        ] as const) {
            const intent = new PlainPasteIntent(apple)
            intent.keydown(apple ? key('V', { metaKey: true, shiftKey: true }) : chord)
            intent.keyup({ key: released })
            expect(intent.take()).toBe(false)
        }
    })

    it('letting go of V keeps it, since the browser may paste after the key comes up', () => {
        const intent = new PlainPasteIntent(false)
        intent.keydown(chord)
        intent.keyup({ key: 'V' })
        expect(intent.take()).toBe(true)
    })

    it('the editor losing focus withdraws it', () => {
        const intent = new PlainPasteIntent(false)
        intent.keydown(chord)
        intent.blur()
        expect(intent.take()).toBe(false)
    })
})
