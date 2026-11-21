import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
    CONTENT_WIDTH_HIGHEST,
    CONTENT_WIDTH_LOWEST,
    DEFAULT_CONTENT_WIDTH,
    maxContentWidthOf,
    sanitizeGraphSettings,
} from './graph-settings'

/**
 * Graph Settings arrive from a hand-edited file or another client's synced meta map. Whatever is
 * stored as the document width: what is kept reads back the same after a write (sanitising twice
 * changes nothing), and the width the editor is given is always a real width within bounds, or
 * none at all, so no stored value can squeeze a pane's text to nothing or push it off the page.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.SETTINGS_FUZZ_SEED
    return { numRuns: Number(process.env.SETTINGS_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261120 : Number(seed) }
}

/** Anything a file or a peer could hold: widths near and past each bound, fractions, other types. */
const storedWidth = fc.oneof(
    fc.integer({ min: -10, max: CONTENT_WIDTH_HIGHEST + 10 }),
    fc.constantFrom(0, CONTENT_WIDTH_LOWEST - 1, CONTENT_WIDTH_LOWEST, CONTENT_WIDTH_HIGHEST, CONTENT_WIDTH_HIGHEST + 1),
    fc.double(),
    fc.string(),
    fc.constant(null),
    fc.boolean(),
)

describe('Graph Settings: the document width', () => {
    it('sanitising is idempotent, so a stored width survives write and read', () => {
        fc.assert(
            fc.property(storedWidth, (maxContentWidth) => {
                const once = sanitizeGraphSettings({ maxContentWidth })
                expect(sanitizeGraphSettings(JSON.parse(JSON.stringify(once)))).toEqual(once)
            }),
            fuzz(500),
        )
    })

    it('the editor is given no limit, or a whole width within bounds', () => {
        fc.assert(
            fc.property(storedWidth, (maxContentWidth) => {
                const width = maxContentWidthOf(sanitizeGraphSettings({ maxContentWidth }))
                if (width === null) return
                expect(Number.isInteger(width)).toBe(true)
                expect(width).toBeGreaterThanOrEqual(CONTENT_WIDTH_LOWEST)
                expect(width).toBeLessThanOrEqual(CONTENT_WIDTH_HIGHEST)
            }),
            fuzz(500),
        )
    })

    it('a value that is not a width reads as the default, never as no limit', () => {
        fc.assert(
            fc.property(storedWidth, (maxContentWidth) => {
                const settings = sanitizeGraphSettings({ maxContentWidth })
                // Kept, it is the value as stored (`===`, so a -0 kept as 0 counts as the same).
                if (settings.maxContentWidth !== undefined) expect(settings.maxContentWidth === maxContentWidth).toBe(true)
                else expect(maxContentWidthOf(settings)).toBe(DEFAULT_CONTENT_WIDTH)
            }),
            fuzz(500),
        )
    })
})
