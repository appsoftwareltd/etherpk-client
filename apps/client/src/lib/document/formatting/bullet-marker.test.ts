/**
 * Bullets written with `*` or `+` (ADR 0109): each row is a text, whether the check flags it, and
 * the text its fix writes. Only `-` bullets are outliner blocks, so a `*` item gets no dot, no
 * children and no keys.
 */

import { describe, expect, it } from 'vitest'

import { bulletMarker } from './bullet-marker'
import { checkedText } from './finding'

const find = (text: string) => bulletMarker.find(checkedText(text))

describe('bullets written with * or +', () => {
    it.each([
        ['a * list', '* a\n* b', '- a\n- b', [0, 1]],
        ['a + list', '+ a', '- a', [0]],
        ['a nested * item under a - bullet', '- a\n  * b', '- a\n  - b', [1]],
        ['a * task, which becomes a task', '* [ ] task', '- [ ] task', [0]],
        ['a quoted * item', '> * quoted', '> - quoted', [0]],
        ['an empty * item', '* a\n*\n* c', '- a\n-\n- c', [0, 1, 2]],
        ['items on Windows lines, endings kept', 'x\r\n\r\n* a\r\n* b', 'x\r\n\r\n- a\r\n- b', [2, 3]],
    ])('flags %s and writes -', (_name, text, fixed, lines) => {
        expect(find(text)).toMatchObject({ fixed, lines })
    })

    it.each([
        ['a thematic break', '* * *'],
        ['emphasis', '*emphasis* at the start'],
        ['a numbered list', '1. one\n2. two'],
        ['- bullets', '- a\n  - b'],
        ['a fenced code block', '```\n* a\n```'],
        ["a bullet's fenced code block", '- ```\n  * a\n  ```'],
        ['an indented code block', 'para\n\n    * a'],
        ['frontmatter', '---\nnote:\n  * a\n---\n- b'],
    ])('leaves %s', (_name, text) => {
        expect(find(text)).toBeNull()
    })

    it("leaves lines the editor reads as code even where the markdown parser doesn't", () => {
        // A backtick in the info string makes this no fence to CommonMark, so the parser reads `* x`
        // as a list item; the editor pairs the two fences, and its reading wins (ADR 0109).
        expect(find('```a`b\n* x\n```')).toBeNull()
    })

    it('says which markers it found', () => {
        expect(find('* a')?.reason).toBe('bullets written with *')
        expect(find('+ a')?.reason).toBe('bullets written with +')
        expect(find('* a\n\n+ b')?.reason).toBe('bullets written with * and +')
    })
})
