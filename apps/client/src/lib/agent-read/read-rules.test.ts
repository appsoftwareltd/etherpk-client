import { describe, expect, it } from 'vitest'

import { textWindow } from './read-rules'

describe('textWindow', () => {
    it('gives a text within the cap whole, from line 0, with nothing to read after it', () => {
        expect(textWindow('- water the beans\n- feed the hens', 0, 100)).toEqual({
            text: '- water the beans\n- feed the hens',
            truncated: false,
            offset: 0,
            startLine: 0,
        })
    })

    it('cuts a long text after its last whole line, and says where the rest starts', () => {
        const text = '- one\n- two\n- three'
        // 8 units reach into "- two": the window ends after "- one\n".
        expect(textWindow(text, 0, 8)).toEqual({ text: '- one\n', truncated: true, offset: 0, startLine: 0, nextOffset: 6 })
        expect(textWindow(text, 6, 8)).toEqual({ text: '- two\n', truncated: true, offset: 6, startLine: 1, nextOffset: 12 })
        expect(textWindow(text, 12, 8)).toEqual({ text: '- three', truncated: false, offset: 12, startLine: 2 })
    })

    it('cuts a line longer than the cap at the cap, so the next window still moves on', () => {
        expect(textWindow('abcdefghij\n- x', 0, 4)).toEqual({ text: 'abcd', truncated: true, offset: 0, startLine: 0, nextOffset: 4 })
        expect(textWindow('abcdefghij\n- x', 4, 4)).toEqual({ text: 'efgh', truncated: true, offset: 4, startLine: 0, nextOffset: 8 })
    })

    it('never splits a character written as two UTF-16 units', () => {
        // "🌱" is a surrogate pair: a cap of 3 would end between its halves.
        const window = textWindow('ab🌱cd', 0, 3)
        expect(window).toMatchObject({ text: 'ab', nextOffset: 2 })
        expect(textWindow('ab🌱cd', 2, 3)).toMatchObject({ text: '🌱c', nextOffset: 5 })
    })

    it('answers an offset at the end with nothing, and refuses one past it', () => {
        expect(textWindow('- a', 3, 10)).toEqual({ text: '', truncated: false, offset: 3, startLine: 0 })
        expect(() => textWindow('- a', 4, 10)).toThrow(RangeError)
        expect(() => textWindow('- a', -1, 10)).toThrow(RangeError)
        expect(() => textWindow('- a', 1.5, 10)).toThrow(RangeError)
    })
})
