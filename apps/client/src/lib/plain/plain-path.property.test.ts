import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { normalisePath, relativeLink, resolveLink } from './plain-path'

/**
 * A link written from one file to another must lead back to that file, whatever the two paths
 * hold: spaces, brackets, `#`, `?`, `%` and letters of any script. Path completion writes the link
 * and a click resolves it, so the two must agree.
 *
 * Fixed seed and run count. `PLAIN_FUZZ_RUNS` and `PLAIN_FUZZ_SEED` change them.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.PLAIN_FUZZ_SEED
    return { numRuns: Number(process.env.PLAIN_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261121 : Number(seed) }
}

/** A file or folder name: no slash, not a dot segment, already composed (NFC). */
const segment = fc
    .string({ unit: fc.constantFrom('a', 'B', 'z', '0', '9', ' ', '.', '-', '_', '(', ')', '[', ']', '#', '?', '%', '&', '+', 'é', '園', '芸'), minLength: 1, maxLength: 8 })
    .filter((s) => s !== '.' && s !== '..')
    .map((s) => s.normalize('NFC'))

const filePath = fc.array(segment, { minLength: 1, maxLength: 5 }).map((parts) => parts.join('/'))

describe('links between files of a Plain Folder', () => {
    it('a link written from one file to another resolves to that file', () => {
        fc.assert(
            fc.property(filePath, filePath, (from, to) => {
                expect(resolveLink(from, relativeLink(from, to))).toEqual({ kind: 'file', path: to, fragment: null })
            }),
            fuzz(1000),
        )
    })

    it('a normalised path is already normal, and never leaves the folder', () => {
        fc.assert(
            fc.property(fc.array(fc.oneof(segment, fc.constantFrom('.', '..', '')), { maxLength: 8 }), (parts) => {
                const once = normalisePath(parts.join('/'))
                if (once === null) return
                expect(normalisePath(once)).toBe(once)
                expect(once.split('/')).not.toContain('..')
            }),
            fuzz(1000),
        )
    })
})
