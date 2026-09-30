/**
 * Windows line endings (ADR 0109): a document holding a carriage return is flagged, and the fix
 * writes every line ending as `\n`, frontmatter included, since line endings belong to the file.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { lineFeedsOnly } from '../line-endings'
import { checkedText } from './finding'
import { lineEndings } from './line-endings'

const find = (text: string) => lineEndings.find(checkedText(text))

describe('line endings', () => {
    it.each([
        ['Windows line endings', 'a\r\nb\r\n', 'a\nb\n', [0, 1]],
        ['old Mac line endings', 'a\rb', 'a\nb', [0]],
        ['Windows and old Mac line endings', 'a\r\nb\rc\nd', 'a\nb\nc\nd', [0, 1]],
    ])('flags %s', (reason, text, fixed, lines) => {
        expect(find(text)).toEqual({ reason, fixed, lines })
    })

    it('fixes the frontmatter too', () => {
        expect(find('---\r\ntitle: x\r\n---\r\n- a')?.fixed).toBe('---\ntitle: x\n---\n- a')
    })

    it('leaves a text with line feeds only', () => {
        expect(find('- a\n- b\n')).toBeNull()
    })

    it('writes what the editor holds (ADR 0112)', () => {
        fc.assert(
            fc.property(fc.array(fc.constantFrom('a', ' ', '\r', '\n', '\r\n'), { maxLength: 30 }), (parts) => {
                const text = parts.join('')
                expect(find(text)?.fixed ?? text).toBe(lineFeedsOnly(text))
            }),
        )
    })
})
