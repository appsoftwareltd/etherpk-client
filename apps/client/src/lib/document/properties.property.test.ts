import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { isEmptyPropertyValue, propertiesOf } from './properties'

/**
 * The index holds a document's Properties as one row per value, so a Property Filter is a lookup
 * (ADR 0107). So for any frontmatter block: no row is an empty value or a name key (`title` and
 * `aliases` are answered from the graph's names), a presence row stands only for a mapping that
 * holds a set value, and every set value a person could type a filter for has its row.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261116 : Number(seed) }
}

const KEYS = ['status', 'tags', 'publication', 'id', 'kind', 'rating', 'title', 'Title', 'ALIASES', 'aliases', 'date']

/** A scalar as YAML parses one: text (sometimes blank), a number, a boolean, a day, or nothing. */
const scalar = fc.oneof(
    fc.constantFrom('Garden', 'water the beans', 'draft', '', '   ', 'é'),
    fc.integer({ min: -5, max: 100 }),
    fc.boolean(),
    fc.constant(null),
    fc.constantFrom(new Date('2026-09-28T00:00:00.000Z'), new Date('2026-09-28T10:30:00.000Z')),
)

const { value } = fc.letrec((tie) => ({
    value: fc.oneof({ depthSize: 'small', withCrossShrink: true }, scalar, tie('list'), tie('mapping')),
    list: fc.array(tie('value'), { maxLength: 3 }),
    mapping: fc.dictionary(fc.constantFrom(...KEYS), tie('value'), { maxKeys: 3 }),
}))

const block = fc.dictionary(fc.constantFrom(...KEYS), value, { maxKeys: 6 }) as fc.Arbitrary<Record<string, unknown>>

const isMapping = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)

/** Every set scalar under `path`, by the dot path a filter names it with (a list's items share its key). */
function setScalars(path: string, v: unknown, out: { key: string; value: unknown }[]): void {
    if (isEmptyPropertyValue(v)) return
    if (Array.isArray(v)) for (const item of v) setScalars(path, item, out)
    else if (isMapping(v)) for (const [key, child] of Object.entries(v)) setScalars(`${path}.${key}`, child, out)
    else out.push({ key: path, value: v })
}

describe('a document’s property rows', () => {
    it('hold no empty value and no name key, and a presence row only above a set value', () => {
        fc.assert(
            fc.property(block, (data) => {
                const rows = propertiesOf(data)
                rows.forEach((row, i) => {
                    expect(['title', 'aliases']).not.toContain(row.key.split('.')[0].toLowerCase())
                    if (row.value !== null) expect(row.value.trim()).not.toBe('')
                    // A mapping's presence row comes before the rows of its values, one of them set.
                    else expect(rows.slice(i + 1).some((later) => later.key.startsWith(`${row.key}.`) && later.value !== null)).toBe(true)
                })
            }),
            fuzz(1000),
        )
    })

    it('has a row for every set value, by the dot path a filter names it with', () => {
        fc.assert(
            fc.property(block, (data) => {
                const rows = propertiesOf(data)
                const expected: { key: string; value: unknown }[] = []
                for (const [key, v] of Object.entries(data)) if (!['title', 'aliases'].includes(key.toLowerCase())) setScalars(key, v, expected)
                const valueRows = rows.filter((row) => row.value !== null)
                expect(valueRows.map((row) => row.key)).toEqual(expected.map((e) => e.key))
                valueRows.forEach((row, i) => {
                    const v = expected[i].value
                    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') expect(row.value).toBe(String(v))
                })
            }),
            fuzz(1000),
        )
    })
})
