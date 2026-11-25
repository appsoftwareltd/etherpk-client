import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { graphHeading, headingText, KINDS, type OpenGraphKind } from './workspace-heading'

/**
 * The toolbar's heading, over any name a graph can be given.
 *
 * Fixed seed and run count, so a failure reproduces. `HEADING_FUZZ_RUNS` and `HEADING_FUZZ_SEED`
 * change them for a longer local run, or to replay a seed a failure printed.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.HEADING_FUZZ_SEED
    return { numRuns: Number(process.env.HEADING_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261125 : Number(seed) }
}

const kindArb = fc.constantFrom<OpenGraphKind>('synced', 'folder', 'demo', 'browser')
/** Names as people type them, some of them blank, padded, or the id standing in. */
const nameArb = fc.oneof(fc.string(), fc.string().map((name) => `  ${name}\t`), fc.constantFrom('', '   ', 'g1'))

describe('graphHeading, over any name', () => {
    it('always has text, and names the graph only by a name that is its own', () => {
        fc.assert(
            fc.property(kindArb, nameArb, (kind, name) => {
                const heading = graphHeading(kind, name, 'g1')
                const own = name.trim() !== '' && name.trim() !== 'g1'
                expect(heading.name).toBe(own ? name.trim() : null)
                // The heading is never blank and never the id: the name, or the kind in words.
                const text = headingText(heading)
                expect(text).toBe(own ? name.trim() : KINDS[kind].words)
                expect(text).toMatch(/\S/)
                // The icons follow the kind and never the name: only a synced graph is on a Sync Server.
                expect(heading.kind.what).toBe('graph')
                expect(heading.kind.kept === 'synced').toBe(kind === 'synced')
            }),
            fuzz(500),
        )
    })

    it('says the same of a name however it is padded', () => {
        fc.assert(
            fc.property(kindArb, fc.string(), (kind, name) => {
                expect(graphHeading(kind, `  ${name}  `, 'g1')).toEqual(graphHeading(kind, name.trim(), 'g1'))
            }),
            fuzz(300),
        )
    })
})
