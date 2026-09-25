import { describe, expect, it } from 'vitest'

import { allAssetReferences, assetReferenceCut, findAssetReference } from './asset-reference'

const REF = '../assets/q3-report.a1b2c3d4.pdf'
const IMG = '../assets/chart.a1b2c3d4.png'

/** The cut for the first reference to `ref` in `line`, as the command computes it. */
const cut = (line: string, ref: string, occurrence = 0) => {
    const span = findAssetReference(line, ref, occurrence)
    return span && assetReferenceCut(line, span)
}
/** What the line reads as once the cut is applied (`null` when the whole line goes). */
const after = (line: string, ref: string, occurrence = 0) => {
    const c = cut(line, ref, occurrence)
    if (!c) return undefined
    return c.wholeLine ? null : line.slice(0, c.from) + line.slice(c.to)
}

describe('findAssetReference', () => {
    it('finds an image reference, leading bang included', () => {
        expect(findAssetReference(`![chart](${IMG})`, IMG)).toEqual({ from: 0, to: `![chart](${IMG})`.length })
    })

    it('finds a link reference mid-sentence', () => {
        const line = `see [the report](${REF}) for detail`
        expect(findAssetReference(line, REF)).toEqual({ from: 4, to: 4 + `[the report](${REF})`.length })
    })

    it('picks the occurrence asked for when a line holds the same asset twice', () => {
        const line = `[a](${REF}) then [b](${REF})`

        expect(findAssetReference(line, REF, 0)?.from).toBe(0)
        expect(findAssetReference(line, REF, 1)?.from).toBe(line.indexOf('[b]'))
    })

    it('ignores a different asset and a wikilink', () => {
        expect(findAssetReference(`![other](${IMG})`, REF)).toBeNull()
        expect(findAssetReference('[[Some Concept]]', REF)).toBeNull()
    })
})

describe('assetReferenceCut', () => {
    it('takes the whole line for a standalone image', () => {
        expect(cut(`![chart](${IMG})`, IMG)?.wholeLine).toBe(true)
    })

    it('takes the whole line for a bullet whose only content is the asset', () => {
        expect(cut(`- ![chart](${IMG})`, IMG)?.wholeLine).toBe(true)
        expect(cut(`    - [q3 report](${REF})`, REF)?.wholeLine).toBe(true)
    })

    it('takes the whole line for a task whose only content is the asset', () => {
        expect(cut(`- [ ] ![chart](${IMG})`, IMG)?.wholeLine).toBe(true)
        expect(cut(`  - [x] [q3](${REF})`, REF)?.wholeLine).toBe(true)
    })

    it('takes only the span from a bullet that also holds words', () => {
        expect(after(`- see [q3](${REF}) for detail`, REF)).toBe('- see  for detail')
    })

    it('takes only the span from prose, closing the sentence up around it', () => {
        expect(after(`Read [q3](${REF}) before Friday.`, REF)).toBe('Read  before Friday.')
    })

    it('takes only the span when a second reference would be left stranded', () => {
        expect(after(`[a](${REF}) [b](${IMG})`, REF)).toBe(` [b](${IMG})`)
    })

    it('takes the whole line for an image indented as a continuation line', () => {
        expect(cut(`      ![chart](${IMG})`, IMG)?.wholeLine).toBe(true)
    })

    it('removes the occurrence that was clicked, not the first one', () => {
        const line = `[a](${REF}) then [b](${REF})`
        expect(after(line, REF, 1)).toBe(`[a](${REF}) then `)
    })
})

describe('allAssetReferences', () => {
    it('enumerates every occurrence in document order', () => {
        const line = `[a](${REF}) then [b](${REF})`

        expect(allAssetReferences(line, REF).map((s) => s.from)).toEqual([0, line.indexOf('[b]')])
    })

    it('is empty when the line holds none', () => {
        expect(allAssetReferences('just prose', REF)).toEqual([])
    })

    it('matches a reference whose file name holds parentheses', () => {
        const ref = '../assets/Estimate_320_from_B_Sprake_ltd_(1)_1706517395516_0.pdf'
        const line = `see ![doc](${ref}) here`
        expect(allAssetReferences(line, ref)).toEqual([{ from: 4, to: 4 + `![doc](${ref})`.length }])
    })

})
