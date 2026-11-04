import { describe, expect, it } from 'vitest'

import { contentMargins, cropFromSamples, pageFitsCrop, type PageImage } from './crop-margins'

/** A white page image with black rectangles painted on it, RGBA, as a canvas gives one back. */
function page(width: number, height: number, ink: Array<[x0: number, x1: number, y0: number, y1: number]>): PageImage {
    const data = new Uint8ClampedArray(width * height * 4).fill(255)
    for (const [x0, x1, y0, y1] of ink) {
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const at = (y * width + x) * 4
                data[at] = data[at + 1] = data[at + 2] = 0
            }
        }
    }
    return { width, height, data }
}

describe('contentMargins', () => {
    it('measures the white either side of the content as fractions of the width', () => {
        expect(contentMargins(page(100, 100, [[20, 90, 10, 90]]))).toEqual({ left: 0.2, right: 0.1 })
    })

    it('answers null for a blank page, which says nothing about the margins', () => {
        expect(contentMargins(page(100, 100, []))).toBeNull()
    })

    it('reads past a speck on a scan, which is not content', () => {
        const scan = page(100, 200, [[2, 3, 50, 51], [30, 70, 20, 180]])
        expect(contentMargins(scan)).toEqual({ left: 0.3, right: 0.3 })
    })

    it('reads a transparent pixel as paper', () => {
        const image = page(10, 10, [])
        image.data.fill(0)
        expect(contentMargins(image)).toBeNull()
    })
})

describe('cropFromSamples', () => {
    it('keeps the narrowest margin of each side, so no sampled page is clipped', () => {
        const crop = cropFromSamples([
            { page: 3, margins: { left: 0.2, right: 0.25 } },
            { page: 5, margins: { left: 0.15, right: 0.3 } },
        ])
        expect(crop.odd).toEqual({ left: 0.135, right: 0.235 })
    })

    it('holds odd and even pages apart, as a printed book alternates its margins', () => {
        const crop = cropFromSamples([
            { page: 3, margins: { left: 0.25, right: 0.1 } },
            { page: 4, margins: { left: 0.1, right: 0.25 } },
        ])
        expect(crop.odd.left).toBeGreaterThan(crop.odd.right)
        expect(crop.even.right).toBeGreaterThan(crop.even.left)
    })

    it('uses the other side of the spread when one has no sample', () => {
        const crop = cropFromSamples([{ page: 3, margins: { left: 0.2, right: 0.2 } }])
        expect(crop.even).toEqual(crop.odd)
    })

    it('crops nothing with no samples at all', () => {
        expect(cropFromSamples([])).toEqual({ odd: { left: 0, right: 0 }, even: { left: 0, right: 0 } })
    })

    it('never crops a side past the limit, whatever a page reports', () => {
        const crop = cropFromSamples([{ page: 1, margins: { left: 0.9, right: 0.8 } }])
        expect(crop.odd.left + crop.odd.right).toBeLessThanOrEqual(0.6)
    })
})

describe('pageFitsCrop', () => {
    const crop = { left: 0.1, right: 0.1 }

    it('accepts a page whose content sits inside the crop', () => {
        expect(pageFitsCrop({ left: 0.1, right: 0.2 }, crop)).toBe(true)
    })

    it('refuses a page with content the crop would cut off', () => {
        expect(pageFitsCrop({ left: 0.02, right: 0.2 }, crop)).toBe(false)
    })

    it('accepts a blank page', () => {
        expect(pageFitsCrop(null, crop)).toBe(true)
    })
})
