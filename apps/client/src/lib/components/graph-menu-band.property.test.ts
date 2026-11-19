import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { bandCornerClass } from './graph-menu-band'

/** A fixed seed, so a run is the same here and in CI. `MENU_FUZZ_RUNS` and `MENU_FUZZ_SEED` change them. */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.MENU_FUZZ_SEED
    return { numRuns: Number(process.env.MENU_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261118 : Number(seed) }
}

/** Which of a row's edges its class rounds. */
function rounded(cls: string): { top: boolean; bottom: boolean } {
    return { top: cls === 'rounded-lg' || cls === 'rounded-t-lg', bottom: cls === 'rounded-lg' || cls === 'rounded-b-lg' }
}

describe('a Graphs menu group is one block, whatever its length', () => {
    it('rounds the top of the first row and the bottom of the last, and no edge two rows share', () => {
        fc.assert(
            fc.property(fc.integer({ min: 1, max: 60 }), (count) => {
                const rows = Array.from({ length: count }, (_, index) => rounded(bandCornerClass(index, count)))
                expect(rows[0].top).toBe(true)
                expect(rows[count - 1].bottom).toBe(true)
                for (let index = 0; index < count - 1; index++) {
                    // A rounded corner on a shared edge is what made a row look like a separate pill.
                    expect(rows[index].bottom).toBe(false)
                    expect(rows[index + 1].top).toBe(false)
                }
            }),
            fuzz(200),
        )
    })
})
