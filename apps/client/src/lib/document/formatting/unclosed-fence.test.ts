/**
 * Unclosed code blocks (ADR 0109): reported, never fixed, because where the block was meant to end
 * cannot be known. A fence counts as the editor pairs it (ADR 0020): backticks only, a closer at its
 * opener's column and of its length.
 */

import { describe, expect, it } from 'vitest'

import { checkedText } from './finding'
import { unclosedFence } from './unclosed-fence'

const find = (text: string) => unclosedFence.find(checkedText(text))

describe('unclosed code blocks', () => {
    it.each([
        ['an opener with a language', '- a\n  ```js\n  x', [1], 'Line 2 opens a code block that is never closed.'],
        ["a bullet's opener", '- ```\n  x', [0], 'Line 1 opens a code block that is never closed.'],
        ['a bare fence', 'text\n```\nx', [1], 'Line 2 has a code fence with no matching fence.'],
        ['a closer whose opener has gone', '- a\n  x\n  ```', [2], 'Line 3 has a code fence with no matching fence.'],
    ])('reports %s', (_name, text, lines, reason) => {
        expect(find(text)).toEqual({ lines, reason, fixed: null })
    })

    it('reports every such fence, in order', () => {
        expect(find('```js\nx\n\n- ```\n  y')).toEqual({
            lines: [0, 3],
            reason: 'Line 1 opens a code block that is never closed. Line 4 opens a code block that is never closed.',
            fixed: null,
        })
    })

    it.each([
        ['a complete block', '```\nx\n```'],
        ["a bullet's complete block", '- ```\n  x\n  ```'],
        ['a three-backtick block inside a four-backtick one', '````\n```\ninner\n```\n````'],
        ['a fence inside frontmatter', '---\nx: 1\n```\n---\n- a'],
        ['tildes, which are text to EtherPK', '~~~\nx'],
    ])('leaves %s', (_name, text) => {
        expect(find(text)).toBeNull()
    })
})
