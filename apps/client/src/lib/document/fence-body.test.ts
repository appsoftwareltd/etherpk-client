import { describe, expect, it } from 'vitest'

import { appendFenceLine, applyFenceBodyEdit, removeFenceLine, replaceFenceLine, safeFenceLine } from './fence-body'

// What an interactive fence's widget asks the editor to do to its text, line by line: a Map
// Block adds, moves, renames and removes its places this way (ADR 0118). A change names the text
// it expects on its line, so a widget acting on an old reading never lands on another edit.

describe('changing a fence body', () => {
    const body = ['Seal Bay @ 50.7486, -1.0789', 'Walk @ 50, -1 > 51, -1', '', '']

    it('adds a line after the last line that holds anything', () => {
        expect(appendFenceLine(body, 'Pub @ 1, 2')).toEqual({ kind: 'insert', line: 2, text: 'Pub @ 1, 2' })
        expect(appendFenceLine([], 'Pub @ 1, 2')).toEqual({ kind: 'insert', line: 0, text: 'Pub @ 1, 2' })
        expect(applyFenceBodyEdit(body, appendFenceLine(body, 'Pub @ 1, 2'))).toEqual([body[0], body[1], 'Pub @ 1, 2', '', ''])
    })

    it('replaces or removes a line only while it still says what was last read there', () => {
        const rename = replaceFenceLine(0, body[0], 'Seal Bay Campsite @ 50.74860, -1.07890')
        expect(applyFenceBodyEdit(body, rename)?.[0]).toBe('Seal Bay Campsite @ 50.74860, -1.07890')
        expect(applyFenceBodyEdit(['Something else', ...body.slice(1)], rename)).toBeNull()

        const removal = removeFenceLine(1, body[1])
        expect(applyFenceBodyEdit(body, removal)).toEqual([body[0], '', ''])
        expect(applyFenceBodyEdit(body.slice(0, 1), removal)).toBeNull()
    })

    it('refuses an insert past the end of the body', () => {
        expect(applyFenceBodyEdit(body, { kind: 'insert', line: 9, text: 'x' })).toBeNull()
    })
})

describe('a line that may sit in a fence', () => {
    it('is one line', () => {
        expect(safeFenceLine('Seal\nBay\r\nCampsite')).toBe('Seal Bay Campsite')
    })

    it('is never a line the fence analysis reads as a fence, which would close or split the block', () => {
        // A closer, an opener with an info word (which takes over from an unclosed one), a longer
        // run, an indented run and a bullet's fence: each ends the block or starts another.
        expect(safeFenceLine('```')).toBe("'''")
        expect(safeFenceLine('``` Pub')).toBe("''' Pub")
        expect(safeFenceLine('```js')).toBe("'''js")
        expect(safeFenceLine('```map')).toBe("'''map")
        expect(safeFenceLine('````')).toBe("''''")
        expect(safeFenceLine('  ```')).toBe("  '''")
        expect(safeFenceLine('- ```')).toBe("- '''")
    })

    it('keeps backticks anywhere the analysis does not read a fence', () => {
        expect(safeFenceLine('Pub ``` @ 1, 2')).toBe('Pub ``` @ 1, 2')
        expect(safeFenceLine('```Pub @ 50.1, -1.2')).toBe('```Pub @ 50.1, -1.2')
        expect(safeFenceLine('~~~')).toBe('~~~')
    })
})
