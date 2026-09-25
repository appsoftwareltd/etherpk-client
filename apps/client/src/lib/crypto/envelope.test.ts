import { describe, expect, it } from 'vitest'
import { randomBytes, utf8 } from './bytes'
import { EnvelopeError, contextAad, envelopeEpochId, openSymmetric, sealSymmetric } from './envelope'

const key = randomBytes(32)
const aad = contextAad('update', 'graph:g1', 'doc:d1')

describe('symmetric envelope', () => {
    it('round-trips and carries its epoch id', async () => {
        const envelope = await sealSymmetric({ key, epochId: 7, plaintext: utf8('hi'), aad })
        expect(envelopeEpochId(envelope)).toBe(7)
        const { plaintext, epochId } = await openSymmetric({ keyForEpoch: () => key, envelope, aad })
        expect(new TextDecoder().decode(plaintext)).toBe('hi')
        expect(epochId).toBe(7)
    })
    it('two seals of the same plaintext differ (fresh nonce)', async () => {
        const a = await sealSymmetric({ key, epochId: 1, plaintext: utf8('x'), aad })
        const b = await sealSymmetric({ key, epochId: 1, plaintext: utf8('x'), aad })
        expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false)
    })
    it('rejects a wrong key, wrong AAD, tampered byte, and unknown epoch', async () => {
        const envelope = await sealSymmetric({ key, epochId: 1, plaintext: utf8('hi'), aad })
        await expect(openSymmetric({ keyForEpoch: () => randomBytes(32), envelope, aad })).rejects.toThrow(EnvelopeError)
        await expect(openSymmetric({ keyForEpoch: () => key, envelope, aad: contextAad('other') })).rejects.toThrow(EnvelopeError)
        const tampered = Uint8Array.from(envelope)
        tampered[tampered.length - 1] ^= 1
        await expect(openSymmetric({ keyForEpoch: () => key, envelope: tampered, aad })).rejects.toThrow(EnvelopeError)
        await expect(openSymmetric({ keyForEpoch: () => undefined, envelope, aad })).rejects.toThrow(/no key for epoch/)
    })
    it('rejects unknown version and truncated envelopes', async () => {
        const envelope = await sealSymmetric({ key, epochId: 1, plaintext: utf8('hi'), aad })
        const badVersion = Uint8Array.from(envelope)
        badVersion[0] = 9
        expect(() => envelopeEpochId(badVersion)).toThrow(EnvelopeError)
        expect(() => envelopeEpochId(envelope.subarray(0, 4))).toThrow(EnvelopeError)
    })
})
