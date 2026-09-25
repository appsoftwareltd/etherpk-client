import { describe, expect, it } from 'vitest'

import { referencedAssetNames } from './mirror-assets'

describe('referencedAssetNames', () => {
    it('finds an asset however a document points at it', () => {
        const text = [
            '![diagram](../assets/diagram.11111111-1111-4111-8111-111111111111.png)',
            '[Q3 report](../assets/q3-report.22222222-2222-4222-8222-222222222222.pdf)',
            '<img src="../assets/inline.33333333-3333-4333-8333-333333333333.webp">',
            'bare assets/plain.44444444-4444-4444-8444-444444444444.gif here',
        ].join('\n')
        expect(referencedAssetNames(text)).toEqual([
            'diagram.11111111-1111-4111-8111-111111111111.png',
            'q3-report.22222222-2222-4222-8222-222222222222.pdf',
            'inline.33333333-3333-4333-8333-333333333333.webp',
            'plain.44444444-4444-4444-8444-444444444444.gif',
        ])
    })

    it('reads the name as it is on disk: no query, no fragment, no percent-encoding', () => {
        expect(referencedAssetNames('![a](../assets/my%20file.png?v=2#top)')).toEqual(['my file.png'])
        // A malformed escape is a name, not a throw.
        expect(referencedAssetNames('![a](../assets/100%.png)')).toEqual(['100%.png'])
    })

    it('names each asset once however often it appears', () => {
        expect(referencedAssetNames('![a](../assets/x.png) and ![b](../assets/x.png)')).toEqual(['x.png'])
    })

    it('ignores anything that is not a file directly under assets/', () => {
        expect(referencedAssetNames('![a](../assets/)')).toEqual([])
        expect(referencedAssetNames('![a](../assets/nested/x.png)')).toEqual([])
        expect(referencedAssetNames('no assets at all')).toEqual([])
    })

describe('referencedAssetNames with parentheses', () => {
    it('reads the whole name, not the stub before its first bracket', () => {
        // The stub was reported as a link to an attachment the graph does not hold, which is how
        // a real graph came to list attachments it plainly had (2026-09-10).
        const name = 'Estimate_320_from_B_Sprake_Building_Contractor_ltd_(1)_1706517395516_0.pdf'
        expect(referencedAssetNames(`![doc](../assets/${name})`)).toEqual([name])
        expect(referencedAssetNames(`<img src="../assets/${name}">`)).toEqual([name])
    })

    it('still stops where the markdown does', () => {
        expect(referencedAssetNames('[a](../assets/x.png) then (prose in brackets)')).toEqual(['x.png'])
    })
})

})
