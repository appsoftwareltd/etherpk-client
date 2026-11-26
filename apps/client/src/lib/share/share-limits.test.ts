import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { MAX_SHARED_BYTES, MAX_SHARED_FILES, leftOutMessage, withinShareLimits } from './share-limits'

const sizes = (...all: number[]) => all.map((size) => ({ size }))

describe('how much one share may carry', () => {
    it('keeps an ordinary share whole', () => {
        expect(withinShareLimits(sizes(1, 2, 3))).toEqual({ kept: sizes(1, 2, 3), leftOut: 0 })
        expect(withinShareLimits([])).toEqual({ kept: [], leftOut: 0 })
    })

    it('leaves out the files past the number, and one that does not fit, and keeps a smaller one after it', () => {
        expect(withinShareLimits(sizes(...Array<number>(MAX_SHARED_FILES + 3).fill(1))).leftOut).toBe(3)
        expect(withinShareLimits(sizes(MAX_SHARED_BYTES + 1, 5))).toEqual({ kept: sizes(5), leftOut: 1 })
        expect(withinShareLimits(sizes(MAX_SHARED_BYTES)).leftOut).toBe(0)
    })

    it('never keeps more than it may, in number or in bytes, and loses count of none', () => {
        fc.assert(
            fc.property(fc.array(fc.oneof(fc.nat(1000), fc.nat(MAX_SHARED_BYTES * 2)).map((size) => ({ size })), { maxLength: 60 }), (files) => {
                const { kept, leftOut } = withinShareLimits(files)
                expect(kept.length).toBeLessThanOrEqual(MAX_SHARED_FILES)
                expect(kept.reduce((sum, file) => sum + file.size, 0)).toBeLessThanOrEqual(MAX_SHARED_BYTES)
                expect(kept.length + leftOut).toBe(files.length)
                expect(files.filter((file) => kept.includes(file))).toEqual(kept)
            }),
            { seed: 20261125, numRuns: 300 },
        )
    })

    it('says how many, and the limits as they are', () => {
        expect(leftOutMessage(1)).toBe('1 file was left out of this share. A share can hold up to 20 files and 100 MB in total. Share the missing files in smaller groups, or add a larger file to a note in EtherPK.')
        expect(leftOutMessage(2)).toContain('2 files were left out')
    })
})
