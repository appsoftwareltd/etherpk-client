import { describe, expect, it } from 'vitest'

import { pictureKeepsEvent } from './image-keyboard'

const key = (name: string, held: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat', boolean>> = {}) => ({
    key: name,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...held,
})

describe("the events of a picture's action buttons the editor never sees", () => {
    const event = (type: string, more: object = {}) => ({ type, target: null, ...more }) as unknown as Event

    it('are their keys and their clipboard, undo and redo aside', () => {
        for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'copy', 'cut', 'paste']) expect(pictureKeepsEvent(event(type, key('x'))), type).toBe(true)
        expect(pictureKeepsEvent(event('keydown', key('z', { ctrlKey: true })))).toBe(false)
        for (const type of ['mousedown', 'pointerdown', 'contextmenu', 'dragstart']) expect(pictureKeepsEvent(event(type)), type).toBe(false)
    })
})
