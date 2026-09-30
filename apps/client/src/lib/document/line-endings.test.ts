import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { lineFeedChanges, lineFeedsOnly } from './line-endings'
import type { TextChange } from './types'

/** Apply changes made against one text, from the last to the first, as a shared-text writer does. */
function applyBackToFront(text: string, changes: readonly TextChange[]): string {
    let out = text
    for (const change of [...changes].reverse()) out = out.slice(0, change.from) + change.insert + out.slice(change.to)
    return out
}

describe('lineFeedsOnly (ADR 0112)', () => {
    it('writes a Windows line ending as a line feed', () => {
        expect(lineFeedsOnly('- one\r\n- two\r\n- three')).toBe('- one\n- two\n- three')
    })

    it('writes a lone carriage return (old Mac) as a line feed', () => {
        expect(lineFeedsOnly('a\rb')).toBe('a\nb')
    })

    it('keeps an empty line between a lone carriage return and a Windows ending', () => {
        expect(lineFeedsOnly('a\r\r\nb')).toBe('a\n\nb')
    })

    it('returns the same string when there is nothing to change', () => {
        const text = '- one\n- two'
        expect(lineFeedsOnly(text)).toBe(text)
        expect(lineFeedsOnly('')).toBe('')
    })
})

describe('lineFeedChanges (ADR 0112)', () => {
    it('deletes a carriage return before a line feed', () => {
        expect(lineFeedChanges('a\r\nb')).toEqual([{ from: 1, to: 2, insert: '' }])
    })

    it('replaces a lone carriage return with a line feed', () => {
        expect(lineFeedChanges('a\rb')).toEqual([{ from: 1, to: 2, insert: '\n' }])
    })

    it('lists nothing for a text with no carriage return', () => {
        expect(lineFeedChanges('a\nb')).toEqual([])
    })

    it('applied from the last to the first, gives what lineFeedsOnly gives', () => {
        fc.assert(
            fc.property(fc.array(fc.constantFrom('a', ' ', '\r', '\n', '\r\n'), { maxLength: 40 }), (parts) => {
                const text = parts.join('')
                expect(applyBackToFront(text, lineFeedChanges(text))).toBe(lineFeedsOnly(text))
                expect(lineFeedsOnly(text)).not.toContain('\r')
            }),
        )
    })
})
