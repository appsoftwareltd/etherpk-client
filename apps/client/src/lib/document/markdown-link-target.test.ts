import { describe, expect, it } from 'vitest'

import { LINK_TARGET, linkTargetPattern, markdownLinks } from './markdown-link-target'

/**
 * The grammar nine link readers share. What is pinned here is the case that broke all nine at
 * once: a file name with parentheses, which every imported attachment eventually has.
 */
const link = new RegExp(String.raw`(!?)\[([^\]]*)\]\((${LINK_TARGET})\)`, 'g')

function targets(text: string): string[] {
    return [...text.matchAll(link)].map((match) => match[3])
}

describe('markdownLinks', () => {
    it('yields each link once, with its span, its kind and its parts', () => {
        const text = 'see ![shot](../assets/a_(1).png) and [doc](../assets/b.pdf) after'
        expect([...markdownLinks(text)]).toEqual([
            {
                bang: '!',
                label: 'shot',
                target: '../assets/a_(1).png',
                whole: '![shot](../assets/a_(1).png)',
                from: 4,
                to: 4 + '![shot](../assets/a_(1).png)'.length,
            },
            {
                bang: '',
                label: 'doc',
                target: '../assets/b.pdf',
                whole: '[doc](../assets/b.pdf)',
                from: text.indexOf('[doc]'),
                to: text.indexOf('[doc]') + '[doc](../assets/b.pdf)'.length,
            },
        ])
    })

    it('is empty for text holding none', () => {
        expect([...markdownLinks('just prose (with brackets)')]).toEqual([])
    })
})

describe('linkTargetPattern', () => {
    it('takes a whole file name with balanced parentheses', () => {
        const name = 'Estimate_320_from_B_Sprake_Building_Contractor_ltd_(1)_1706517395516_0.pdf'
        expect(targets(`![label](../assets/${name})`)).toEqual([`../assets/${name}`])
    })

    it('still stops at the closing parenthesis of the link itself', () => {
        expect(targets('[a](../assets/x.png) and [b](../assets/y.png)')).toEqual([
            '../assets/x.png',
            '../assets/y.png',
        ])
        expect(targets('see [a](../assets/x.png), then prose (in brackets) after')).toEqual(['../assets/x.png'])
    })

    it('handles a second level of nesting, and refuses an unbalanced one', () => {
        expect(targets('[a](../assets/one_(two_(three))_four.pdf)')).toEqual([
            '../assets/one_(two_(three))_four.pdf',
        ])
        // No closing parenthesis for the link: nothing to match rather than a truncated target.
        expect(targets('[a](../assets/broken_(1.pdf')).toEqual([])
    })

    it('takes no whitespace, as an unbracketed CommonMark destination cannot', () => {
        expect(targets('[a](../assets/two words.png)')).toEqual([])
    })

    it('lets a caller exclude what its own context forbids', () => {
        const attribute = new RegExp(String.raw`src="(${linkTargetPattern(String.raw`"'<>\]`)})"`)
        expect(attribute.exec('<img src="../assets/report_(1).png">')?.[1]).toBe('../assets/report_(1).png')
    })
})

describe('link label scanning cost', () => {
    it('scans a document of unclosed brackets in linear time', () => {
        // A label that could run on to the next `]` made every `[` scan to the end of the text:
        // 400k brackets took over a minute and froze every editor with the document open.
        for (const text of ['['.repeat(400_000), `${'['.repeat(79)}\n`.repeat(5_000)]) {
            const started = performance.now()
            expect([...markdownLinks(text)]).toEqual([])
            expect(performance.now() - started).toBeLessThan(500)
        }
    })

    it('reads a label holding one balanced pair of brackets, as CommonMark does', () => {
        expect([...markdownLinks('[a [b] c](https://example.com)')].map((l) => l.label)).toEqual(['a [b] c'])
    })
})
