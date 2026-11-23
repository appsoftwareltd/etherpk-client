import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { headingTrail, headingsOf } from './outline'

/** The headings a line is under, against what "under" means, for any run of headings and prose. */
const SEED = Number(process.env.PLAIN_FUZZ_SEED ?? 20261123)
const RUNS = Number(process.env.PLAIN_FUZZ_RUNS ?? 300)

const line = fc.oneof(fc.integer({ min: 1, max: 6 }).map((level) => `${'#'.repeat(level)} Bed`), fc.constantFrom('', 'Water the beans.', '- [ ] peas'))

describe('the trail of headings to a line, at random', () => {
    it('goes down a level at each step, and is exactly the headings no later one above the line has closed', () => {
        fc.assert(
            fc.property(fc.array(line, { minLength: 1, maxLength: 40 }), fc.nat(60), (lines, at) => {
                const headings = headingsOf(lines.join('\n'))
                const trail = headingTrail(headings, at)
                for (let i = 1; i < trail.length; i++) expect(trail[i].level).toBeGreaterThan(trail[i - 1].level)
                const above = headings.filter((heading) => heading.line <= at)
                const open = above.filter((heading) => !above.some((later) => later.line > heading.line && later.level <= heading.level))
                expect(trail).toEqual(open)
            }),
            { seed: SEED, numRuns: RUNS },
        )
    })
})
