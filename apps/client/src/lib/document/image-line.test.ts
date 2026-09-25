import { describe, expect, it } from 'vitest'

import { imageLineKind, isBulletImageLine, isImageLine, parseImageLine } from './image-line'

describe('image lines', () => {
    it('recognises a standalone image with surrounding whitespace', () => {
        expect(parseImageLine('  ![plot|300](../assets/plot.png)  ')).toEqual({
            kind: 'standalone',
            alt: 'plot|300',
            url: '../assets/plot.png',
            imageStart: 2,
        })
    })

    it('recognises a bullet or task image and reports where the image starts', () => {
        expect(parseImageLine('- ![a](x.png)')).toEqual({ kind: 'bullet', alt: 'a', url: 'x.png', imageStart: 2 })
        expect(parseImageLine('  - [x] ![a](x.png)')).toMatchObject({ kind: 'bullet', imageStart: 8 })
        expect(isBulletImageLine('- ![a](x.png)')).toBe(true)
        expect(isBulletImageLine('![a](x.png)')).toBe(false)
    })

    it('rejects anything that is not exactly one image', () => {
        for (const text of ['text ![a](x.png)', '![a](x.png) text', '[a](x.pdf)', '- ![a](x.png) more', '![a](x y.png)', '', '![doc](../assets/notes.docx)', '- ![doc](../assets/q.pdf)']) {
            expect(imageLineKind(text)).toBeNull()
            expect(isImageLine(text)).toBe(false)
        }
    })

    it('takes a whole target with parentheses, as an imported attachment has', () => {
        // Every link reader used to stop at the first `)`, so the image rendered over half its
        // own target and the controls landed mid-text (2026-09-10).
        const target = '../assets/Estimate_320_from_B_Sprake_ltd_(1)_1706517395516_0.png'
        expect(parseImageLine(`![shot](${target})`)).toMatchObject({ kind: 'standalone', url: target })
        expect(parseImageLine(`- ![shot](${target})`)).toMatchObject({ kind: 'bullet', url: target })
    })

})
