import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { EnvelopeError, envelopeEpochId, openSymmetric, sealSymmetric } from './envelope'

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
 * The symmetric envelope carries every update, snapshot and vault. For any plaintext, context and
 * epoch: it opens to what was sealed, and it does not open once any byte of it, or its context, has
 * changed.
 */

const key = fc.uint8Array({ minLength: 32, maxLength: 32 })
const plaintext = fc.uint8Array({ maxLength: 200 })
const aad = fc.uint8Array({ maxLength: 40 })
const epochId = fc.integer({ min: 0, max: 0xffff_ffff })

/** The keyring as a Client holds it: the key for the epoch it was sealed under, and no other. */
function only(epoch: number, bytes: Uint8Array) {
    return (asked: number) => (asked === epoch ? bytes : undefined)
}

describe('the symmetric envelope holds for any content', () => {
    it('opens to the plaintext and epoch it was sealed with', async () => {
        await fc.assert(
            fc.asyncProperty(key, plaintext, aad, epochId, async (k, text, context, epoch) => {
                const envelope = await sealSymmetric({ key: k, epochId: epoch, plaintext: text, aad: context })
                expect(envelopeEpochId(envelope)).toBe(epoch)
                const opened = await openSymmetric({ keyForEpoch: only(epoch, k), envelope, aad: context })
                expect(opened.epochId).toBe(epoch)
                expect(Array.from(opened.plaintext)).toEqual(Array.from(text))
            }),
            fuzz(150),
        )
    })

    it('refuses an envelope with any one byte changed', async () => {
        await fc.assert(
            fc.asyncProperty(key, plaintext, aad, epochId, fc.nat(), fc.integer({ min: 1, max: 255 }), async (k, text, context, epoch, at, flip) => {
                const envelope = await sealSymmetric({ key: k, epochId: epoch, plaintext: text, aad: context })
                const changed = Uint8Array.from(envelope)
                changed[at % changed.length] ^= flip
                await expect(openSymmetric({ keyForEpoch: only(epoch, k), envelope: changed, aad: context })).rejects.toBeInstanceOf(EnvelopeError)
            }),
            fuzz(300),
        )
    })

    it('refuses an envelope opened under another context or another key', async () => {
        await fc.assert(
            fc.asyncProperty(key, key, plaintext, aad, aad, epochId, async (k, otherKey, text, context, otherContext, epoch) => {
                const envelope = await sealSymmetric({ key: k, epochId: epoch, plaintext: text, aad: context })
                const sameContext = context.length === otherContext.length && context.every((byte, i) => byte === otherContext[i])
                if (!sameContext) {
                    await expect(openSymmetric({ keyForEpoch: only(epoch, k), envelope, aad: otherContext })).rejects.toBeInstanceOf(EnvelopeError)
                }
                const sameKey = k.every((byte, i) => byte === otherKey[i])
                if (!sameKey) {
                    await expect(openSymmetric({ keyForEpoch: only(epoch, otherKey), envelope, aad: context })).rejects.toBeInstanceOf(EnvelopeError)
                }
            }),
            fuzz(150),
        )
    })

    it('seals the same content to different bytes each time', async () => {
        await fc.assert(
            fc.asyncProperty(key, plaintext, aad, epochId, async (k, text, context, epoch) => {
                const first = await sealSymmetric({ key: k, epochId: epoch, plaintext: text, aad: context })
                const second = await sealSymmetric({ key: k, epochId: epoch, plaintext: text, aad: context })
                expect(Array.from(first)).not.toEqual(Array.from(second))
            }),
            fuzz(50),
        )
    })
})
