import { EditorSelection } from '@codemirror/state'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { editorFixture } from '../testing/editor-state-fixture'
import { imageEmbedAugmentation } from './image-embed'
import { pictureKeepsEvent, pictureKey } from './image-keyboard'
import { imagePressSpec, selectedImageHoldsKeyboard, selectedImageLine } from './image-select'

const key = (name: string, held: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat', boolean>> = {}) => ({
    key: name,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...held,
})

describe('a key pressed at a clicked picture', () => {
    for (const [what, pressed, does] of [
        ['Enter is Edit as text', key('Enter'), 'edit'],
        ['Escape goes back to the text', key('Escape'), 'leave'],
        ['Tab goes to the actions', key('Tab'), 'actions'],
        ['Shift+Tab goes back to the text', key('Tab', { shiftKey: true }), 'leave'],
        ['undo', key('z', { ctrlKey: true }), 'pass'],
        ['undo on a Mac', key('z', { metaKey: true }), 'pass'],
        ['redo', key('Z', { ctrlKey: true, shiftKey: true }), 'pass'],
        ['redo on Windows', key('y', { ctrlKey: true }), 'pass'],
        ['a function key', key('F5'), 'pass'],
        ['a modifier going down', key('Shift', { shiftKey: true }), 'pass'],
        ['a character', key('x'), 'nothing'],
        ['Space', key(' '), 'nothing'],
        ['Delete', key('Delete'), 'nothing'],
        ['Backspace', key('Backspace'), 'nothing'],
        ['an arrow', key('ArrowDown'), 'nothing'],
        ['an input method starting', key('Process'), 'nothing'],
        ['an app shortcut', key('p', { ctrlKey: true, shiftKey: true }), 'shortcut'],
        ['an app shortcut with Alt', key('j', { altKey: true }), 'shortcut'],
        ['a formatting shortcut', key('b', { ctrlKey: true }), 'shortcut'],
        ['Ctrl+Alt+Z, which is not undo', key('z', { ctrlKey: true, altKey: true }), 'shortcut'],
        ['Enter held down', key('Enter', { repeat: true }), 'nothing'],
        ['Tab held down', key('Tab', { repeat: true }), 'nothing'],
    ] as const) {
        it(`${what}: ${does}`, () => expect(pictureKey(pressed)).toBe(does))
    }

    it('does what it does anywhere for undo, a function key and a modifier alone, and a bare key never reaches the text', () => {
        const anyKey = fc.record({
            key: fc.oneof(fc.string({ minLength: 1, maxLength: 1 }), fc.constantFrom('Enter', 'Escape', 'Tab', 'Delete', 'Backspace', 'ArrowDown', 'F5', 'F12', 'Home', 'Z', 'y', 'Shift', 'Process', 'Dead')),
            ctrlKey: fc.boolean(),
            metaKey: fc.boolean(),
            altKey: fc.boolean(),
            shiftKey: fc.boolean(),
            repeat: fc.boolean(),
        })
        fc.assert(
            fc.property(anyKey, (pressed) => {
                const undo = (pressed.ctrlKey || pressed.metaKey) && !pressed.altKey && ['z', 'y'].includes(pressed.key.toLowerCase())
                const idle = /^F\d|^Shift$/.test(pressed.key) && pressed.key.length > 1
                expect(pictureKey(pressed) === 'pass').toBe(undo || idle)
                const bare = !pressed.ctrlKey && !pressed.metaKey && !pressed.altKey
                if (bare && !idle) expect(['edit', 'leave', 'actions', 'nothing']).toContain(pictureKey(pressed))
            }),
            { seed: 20261124, numRuns: Number(process.env.EDITOR_FUZZ_RUNS ?? 500) },
        )
    })
})

describe("the events of a picture's action buttons the editor never sees", () => {
    const event = (type: string, more: object = {}) => ({ type, target: null, ...more }) as unknown as Event

    it('are their keys and their clipboard, undo and redo aside', () => {
        for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'copy', 'cut', 'paste']) expect(pictureKeepsEvent(event(type, key('x'))), type).toBe(true)
        expect(pictureKeepsEvent(event('keydown', key('z', { ctrlKey: true })))).toBe(false)
        for (const type of ['mousedown', 'pointerdown', 'contextmenu', 'dragstart']) expect(pictureKeepsEvent(event(type)), type).toBe(false)
    })
})

describe('a clicked picture', () => {
    const extensions = [imageEmbedAugmentation({ resolveAsset: () => Promise.resolve(null) })]
    const pressed = (doc: string) => {
        const editor = editorFixture(doc, { caret: '¦', extensions })
        editor.dispatch(editor.state.update(imagePressSpec(editor.state, editor.state.doc.line(1).from)))
        return editor
    }

    it('is put away by the pointer placing the caret where it already was', () => {
        const editor = pressed('![Beds](../assets/beds.png)\n\nwater the beans¦')
        expect(selectedImageLine(editor.state)).toBe(1)
        editor.dispatch(editor.state.update({ selection: EditorSelection.cursor(editor.head()), userEvent: 'select.pointer' }))
        expect(selectedImageLine(editor.state)).toBeNull()
    })

    it('keeps the keyboard through a selection set to what it was by anything else', () => {
        const editor = pressed('![Beds](../assets/beds.png)\n\nwater the beans¦')
        editor.dispatch(editor.state.update({ selection: EditorSelection.cursor(editor.head()) }))
        expect(selectedImageHoldsKeyboard(editor.state)).toBe(true)
    })
})
