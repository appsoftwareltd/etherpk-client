import { describe, expect, it } from 'vitest'

import { wikilinkSegmentsInSource } from './source'

describe('wikilinkSegmentsInSource', () => {
    it('parses links across lines with absolute offsets, suppressing code', () => {
        const src = [
            'first [[Alpha]] line', // 0: prose link
            '`[[Inline]]` and [[Beta]]', // 1: Inline suppressed, Beta survives
            '```', // 2: fence open
            '[[Fenced]]', // 3: suppressed
            '```', // 4: fence close
            'last [[Gamma]]', // 5: prose link
        ].join('\n')

        const segs = wikilinkSegmentsInSource(src)
        const concepts = [...new Set(segs.map((s) => s.wikilink.concept))]
        expect(concepts).toEqual(['Alpha', 'Beta', 'Gamma'])

        const alpha = segs.find((s) => s.wikilink.concept === 'Alpha')!
        expect(src.slice(alpha.start, alpha.end)).toBe('[[Alpha]]')
        const gamma = segs.find((s) => s.wikilink.concept === 'Gamma')!
        expect(src.slice(gamma.start, gamma.end)).toBe('[[Gamma]]')
    })

    it('returns nested segments in absolute order', () => {
        const src = 'x [[[[Physics]] Quantum Mechanics]] y'
        const segs = wikilinkSegmentsInSource(src)
        expect(segs.map((s) => s.wikilink.concept)).toEqual([
            '[[Physics]] Quantum Mechanics',
            'Physics',
            '[[Physics]] Quantum Mechanics',
        ])
        // The inner segment's slice is the scope link.
        expect(src.slice(segs[1].start, segs[1].end)).toBe('[[Physics]]')
    })

    it('is empty for a document with no links', () => {
        expect(wikilinkSegmentsInSource('# Title\n\nplain text')).toEqual([])
    })
})
