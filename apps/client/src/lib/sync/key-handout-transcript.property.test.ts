import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { keyHandoutTranscript } from '@appsoftwareltd/etherpk-shared'

import { bytesEqual } from '#lib/crypto/index.js'

/**
 * How many cases a property runs, and from which seed. The seed is fixed so a run is the same here
 * and in CI. `CRYPTO_FUZZ_RUNS` and `CRYPTO_FUZZ_SEED` change them for a longer local run, or to
 * replay a failure fast-check reported.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.CRYPTO_FUZZ_SEED
    return { numRuns: Number(process.env.CRYPTO_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261116 : Number(seed) }
}

/**
 * The owner signs a transcript for each copy of a new Graph Key epoch, and a member checks the
 * signature against it. A signature over one copy must never be good for another: two copies have
 * the same transcript only when every field is the same. That includes the case where the same
 * characters are split differently between two neighbouring fields.
 */

const fields = fc.record({
    graphId: fc.string({ maxLength: 12 }),
    epoch: fc.integer({ min: 1, max: 5000 }),
    ownerId: fc.string({ maxLength: 12 }),
    recipientId: fc.string({ maxLength: 12 }),
    sealedToPublicKey: fc.uint8Array({ maxLength: 8 }),
    sealedHash: fc.uint8Array({ maxLength: 8 }),
})

type Fields = Parameters<typeof keyHandoutTranscript>[0]

function same(a: Fields, b: Fields): boolean {
    return (
        a.graphId === b.graphId &&
        a.epoch === b.epoch &&
        a.ownerId === b.ownerId &&
        a.recipientId === b.recipientId &&
        bytesEqual(a.sealedToPublicKey, b.sealedToPublicKey) &&
        bytesEqual(a.sealedHash, b.sealedHash)
    )
}

describe('a key copy’s signed transcript names exactly one copy', () => {
    it('is the same for two copies only when every field is the same', () => {
        fc.assert(
            fc.property(fields, fields, (a, b) => {
                expect(bytesEqual(keyHandoutTranscript(a), keyHandoutTranscript(b))).toBe(same(a, b))
                expect(bytesEqual(keyHandoutTranscript(a), keyHandoutTranscript({ ...a }))).toBe(true)
            }),
            fuzz(1000),
        )
    })

    it('changes when any one field changes', () => {
        fc.assert(
            fc.property(fields, fields, fc.constantFrom<keyof Fields>('graphId', 'epoch', 'ownerId', 'recipientId', 'sealedToPublicKey', 'sealedHash'), (a, b, field) => {
                const changed = { ...a, [field]: b[field] } as Fields
                expect(bytesEqual(keyHandoutTranscript(a), keyHandoutTranscript(changed))).toBe(same(a, changed))
            }),
            fuzz(1000),
        )
    })

    it('tells apart the same characters split differently between the owner and the recipient', () => {
        fc.assert(
            fc.property(fields, fc.string({ minLength: 1, maxLength: 16 }), fc.nat(), fc.nat(), (base, text, i, j) => {
                const first = i % (text.length + 1)
                const second = j % (text.length + 1)
                fc.pre(first !== second)
                const split = (at: number) => ({ ...base, ownerId: text.slice(0, at), recipientId: text.slice(at) })
                expect(bytesEqual(keyHandoutTranscript(split(first)), keyHandoutTranscript(split(second)))).toBe(false)
            }),
            fuzz(500),
        )
    })
})
