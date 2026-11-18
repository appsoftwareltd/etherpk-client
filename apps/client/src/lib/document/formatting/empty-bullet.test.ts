/**
 * Empty bullets written as a lone `-` (ADR 0109): each row is a text, whether the check flags it,
 * and the text its fix writes. Markdown reads a lone `-` as an empty list item, but the editor only
 * takes `- ` with its space as a bullet, so it shows the `-` as text. Logseq writes an empty block
 * this way.
 */

import { describe, expect, it } from 'vitest'

import { emptyBullet } from './empty-bullet'
import { checkedText } from './finding'

const find = (text: string) => emptyBullet.find(checkedText(text))

describe('empty bullets written as a lone -', () => {
    it.each([
        ['one at the top level', '- a\n-\n- b', '- a\n- \n- b', [1]],
        ['nested ones, as Logseq writes an empty block', '- a\n  - b\n  -\n- c\n  -', '- a\n  - b\n  - \n- c\n  - ', [2, 4]],
        ['one alone on the page', '-', '- ', [0]],
        // To CommonMark this underlines `b` as a heading; nobody writes a heading inside a bullet that way.
        ['the first, empty child of a bullet', '- a\n  - b\n    -', '- a\n  - b\n    - ', [2]],
        ['one in a quote', '> - a\n> -', '> - a\n> - ', [1]],
        ['one on a Windows line, its ending kept', '- a\r\n-\r\n', '- a\r\n- \r\n', [1]],
    ])('flags %s and adds the space', (_name, text, fixed, lines) => {
        expect(find(text)).toMatchObject({ fixed, lines })
    })

    it.each([
        ['an empty bullet with its space', '- a\n- \n- b'],
        ['a thematic break', '- a\n\n---\n'],
        ['a setext heading underline', 'Heading\n-'],
        ['a fenced code block', '```\n-\n```'],
        ["a bullet's fenced code block", '- ```\n  -\n  ```'],
        ['frontmatter', '---\nnote: |\n  -\n---\n- b'],
        ['a * item, which the bullet-marker check fixes', '*'],
    ])('leaves %s', (_name, text) => {
        expect(find(text)).toBeNull()
    })

    it('says how many it found', () => {
        expect(find('-')?.reason).toBe('an empty bullet with no space after the -')
        expect(find('-\n-')?.reason).toBe('2 empty bullets with no space after the -')
    })
})
