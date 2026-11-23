import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { ViewInstance } from '#lib/layout/index.js'

import { staleJournalDrafts } from './open-on-today'

/** `DOCUMENT_FUZZ_SEED=<n>` and `DOCUMENT_FUZZ_RUNS=<n>` replay or lengthen a run. */
function params(runs: number) {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261123 : Number(seed) }
}

const day = fc.date({ min: new Date('2020-01-01'), max: new Date('2035-12-31'), noInvalidDate: true }).map((date) => date.toISOString().slice(0, 10))
const name = fc.oneof(day, fc.constantFrom('Garden', 'Kitchen', '2026-13-40', '20260310', '2026-03-09 Garden', 'today'))
const tab = fc.record({ kind: fc.constantFrom('document', 'document', 'asset', 'version-history'), target: name, pinned: fc.boolean() })

describe('opening on today', () => {
    it('lets go only of unpinned documents of earlier days with no entry, and of every one of them', () => {
        fc.assert(
            fc.property(fc.array(tab, { maxLength: 12 }), day, fc.array(day, { maxLength: 6 }), (tabs, today, extra) => {
                const entries = new Set([...extra, ...tabs.filter((_, index) => index % 3 === 0).map((held) => held.target)])
                const views: ViewInstance[] = tabs.map((held, index) => ({ panelId: `${index}`, view: { kind: held.kind, target: held.target }, ...(held.pinned ? { pinned: true } : {}) }))
                const gone = new Set(staleJournalDrafts(views, { today, hasEntry: (of) => entries.has(of) }))
                for (const [index, held] of tabs.entries()) {
                    const time = /^\d{4}-\d{2}-\d{2}$/.test(held.target) ? Date.parse(held.target) : NaN
                    const past = time < Date.parse(today)
                    expect(gone.has(`${index}`)).toBe(held.kind === 'document' && !held.pinned && past && !entries.has(held.target))
                }
            }),
            params(500),
        )
    })
})
