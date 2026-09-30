/**
 * No-break spaces in indentation (ADR 0109): each row is a text, whether the check flags it, and
 * the text its fix writes.
 */

import { describe, expect, it } from 'vitest'

import { checkedText } from './finding'
import { noBreakSpaceIndent } from './no-break-space-indent'

const find = (text: string) => noBreakSpaceIndent.find(checkedText(text))

describe('no-break spaces in indentation', () => {
    it.each([
        ['a bullet indented with no-break spaces', '\u{a0}\u{a0}- item', '  - item', [0]],
        ['no-break spaces after plain ones', '- a\n  \u{a0}\u{a0}- b', '- a\n    - b', [1]],
        ['an ideographic space, as an input method types one', '\u{3000}- a', ' - a', [0]],
        ['a prose line', '\u{a0}\u{a0}text', '  text', [0]],
        ['every such line, its ending kept', '\u{a0}- a\r\n\u{a0}- b\r\n- c', ' - a\r\n - b\r\n- c', [0, 1]],
    ])('flags %s and writes spaces', (_name, text, fixed, lines) => {
        expect(find(text)).toMatchObject({ fixed, lines })
    })

    it.each([
        ['a no-break space inside the text', '- 10\u{a0}km'],
        ['a byte order mark, which is not a space', '\u{feff}- a'],
        ['plain indentation', '- a\n  - b\n\t- c'],
        ['frontmatter', '---\ntitle:\u{a0}x\n\u{a0}\u{a0}key: v\n---\n- a'],
        ["a code line's own indentation, past the fence column", '- ```\n  \u{a0}\u{a0}code\n  ```'],
    ])('leaves %s', (_name, text) => {
        expect(find(text)).toBeNull()
    })

    it("fixes a code block's structural indentation up to the fence column and keeps the code's own", () => {
        const text = '\u{a0}\u{a0}- ```\n\u{a0}\u{a0}\u{a0}\u{a0}\u{a0}\u{a0}x\n\u{a0}\u{a0}\u{a0}\u{a0}```'
        expect(find(text)).toMatchObject({ fixed: '  - ```\n    \u{a0}\u{a0}x\n    ```', lines: [0, 1, 2] })
    })

    it('says which kind of space it found', () => {
        expect(find('\u{a0}- a')?.reason).toBe('no-break spaces in indentation')
        expect(find('\u{202f}- a')?.reason).toBe('other space characters in indentation')
        expect(find('\u{a0}- a\n\u{2003}- b')?.reason).toBe('no-break spaces and other space characters in indentation')
    })
})
