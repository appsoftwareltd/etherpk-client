import { describe, expect, it } from 'vitest'

import { codeRanges, isInCode } from './code-ranges'

/** True when the first `[[…]]` occurrence in `src` falls inside a code range. */
function linkSuppressed(src: string, needle = '[[x]]'): boolean {
    const i = src.indexOf(needle)
    expect(i).toBeGreaterThanOrEqual(0)
    return isInCode(codeRanges(src), i, i + needle.length)
}

describe('codeRanges / isInCode', () => {
    it('does not suppress a link in plain prose', () => {
        expect(linkSuppressed('A [[x]] link in prose')).toBe(false)
    })

    it('suppresses a link inside an inline code span', () => {
        expect(linkSuppressed('text `[[x]]` more')).toBe(true)
    })

    it('suppresses a link inside a backtick fenced block', () => {
        expect(linkSuppressed(['```', '[[x]]', '```'].join('\n'))).toBe(true)
    })

    it('suppresses a link inside a tilde fenced block', () => {
        expect(linkSuppressed(['~~~', '[[x]]', '~~~'].join('\n'))).toBe(true)
    })

    it('suppresses a link inside an unclosed fence (to EOF)', () => {
        expect(linkSuppressed(['```', '[[x]]'].join('\n'))).toBe(true)
    })

    it('suppresses a link inside a bullet-owned fenced block', () => {
        expect(linkSuppressed(['- ```', '  [[x]]', '  ```'].join('\n'))).toBe(true)
    })

    it('suppresses a link in indented code but not the prose link beside it', () => {
        const src = ['prose [[x]] here', '', '    [[y]] indented-code'].join('\n')
        const ranges = codeRanges(src)
        const x = src.indexOf('[[x]]')
        const y = src.indexOf('[[y]]')
        expect(isInCode(ranges, x, x + 5)).toBe(false)
        expect(isInCode(ranges, y, y + 5)).toBe(true)
    })
})
