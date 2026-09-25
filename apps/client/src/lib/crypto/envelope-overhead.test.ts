import { describe, expect, it } from 'vitest'
import {
    SYMMETRIC_ENVELOPE_OVERHEAD_BYTES,
    assetChunkCiphertextLength,
} from '@appsoftwareltd/etherpk-shared'
import { contextAad, sealSymmetric } from './envelope'
import { randomBytes } from './bytes'

/**
 * The Sync Server signs `Content-Length` into every presigned asset chunk PUT, derived from
 * SYMMETRIC_ENVELOPE_OVERHEAD_BYTES. If the envelope format ever changes
 * without that constant changing with it, every asset upload starts failing as an opaque 403
 * from object storage, which is a miserable thing to diagnose. This is the pin.
 */
describe('symmetric envelope overhead', () => {
    const key = randomBytes(32)
    const aad = contextAad('asset', 'id:test', 'chunk:0')

    it.each([0, 1, 1024, 65_536])('adds exactly the declared overhead to %i plaintext bytes', async (length) => {
        const sealed = await sealSymmetric({ key, epochId: 0, plaintext: randomBytes(length), aad })
        expect(sealed.length - length).toBe(SYMMETRIC_ENVELOPE_OVERHEAD_BYTES)
    })

    it('matches the length the server signs for a chunk', async () => {
        const size = 1024
        const sealed = await sealSymmetric({ key, epochId: 0, plaintext: randomBytes(size), aad })
        expect(sealed.length).toBe(assetChunkCiphertextLength(size, 0))
    })
})
