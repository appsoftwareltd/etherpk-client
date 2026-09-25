import { describe, expect, it } from 'vitest'

import { DARK_INK, LIGHT_INK, inkFor, relativeLuminance } from './contrast-ink'

describe('relativeLuminance', () => {
    it('spans 0 (black) to 1 (white)', () => {
        expect(relativeLuminance('#000000')).toBe(0)
        expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6)
    })

    it('is the WCAG value, not a perceived-brightness estimate', () => {
        // The lightest grey that still passes AA against white (4.54:1 needs L = 0.1811).
        expect(relativeLuminance('#767676')).toBeCloseTo(0.1811, 3)
        // A saturated blue is brighter to the formula than its red and green components
        // suggest, and darker than a green of the same hex would be.
        expect(relativeLuminance('#1e90ff')).toBeCloseTo(0.2744, 3)
    })

    it('reads a hex colour whatever its case', () => {
        expect(relativeLuminance('#7DD3FC')).toBe(relativeLuminance('#7dd3fc'))
    })
})

describe('inkFor', () => {
    it('puts dark ink on every ready-made pastel', () => {
        // The eight PRESENCE_PALETTE swatches the settings dialog offers. A perceived-brightness
        // threshold (the agent-kanban precedent, 200 on the YIQ scale) would have given six of
        // these white text at under 2:1.
        for (const pastel of ['#7dd3fc', '#fcd34d', '#6ee7b7', '#fca5a5', '#c4b5fd', '#f9a8d4', '#fdba74', '#bef264']) {
            expect(inkFor(pastel), pastel).toBe(DARK_INK)
        }
    })

    it('puts light ink on a dark pick', () => {
        expect(inkFor('#1e3a8a')).toBe(LIGHT_INK)
        expect(inkFor('#000000')).toBe(LIGHT_INK)
    })

    it('switches where black and white contrast equally against the background', () => {
        // The crossover is a luminance of ~0.179: (L + 0.05) / 0.05 = 1.05 / (L + 0.05).
        expect(inkFor('#767676')).toBe(DARK_INK) // L 0.1811: black wins 4.62:1 to 4.54:1
        expect(inkFor('#747474')).toBe(LIGHT_INK) // L 0.1746: white wins 4.67:1 to 4.49:1
    })

    it('keeps dodger blue readable with dark ink, where white would fall short of AA', () => {
        expect(inkFor('#1e90ff')).toBe(DARK_INK)
    })
})
