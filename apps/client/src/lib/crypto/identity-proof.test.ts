import { describe, expect, it } from 'vitest'
import { identityPossessionProof } from './identity-proof'

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const fromHex = (text: string) => new Uint8Array(Buffer.from(text, 'hex'))
const utf8 = (text: string) => new TextEncoder().encode(text)

// The vector the Sync Server's identity-proof.test.ts checks from its side: the proof key it
// derives for the account, and the proof it accepts. Both sides computing the same bytes is what
// keeps the Client and the server in step.
const VECTOR = {
    identityPrivateKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
    proofPublicKey: fromHex('f66429fce02cbd09dae91f1bcd7e96ed35d028474640f8c26809e88f5be14412'),
    transcript: utf8('etherpk identity-proof test vector'),
    proof: '55b4dbe1b6dab20f425def2a3eef0b11621fa38a01316f1b80f42e5a4530f633',
}

describe('identityPossessionProof (ADR 0126)', () => {
    it('is the proof the Sync Server computes for the same keys and transcript', async () => {
        const proof = await identityPossessionProof(VECTOR.identityPrivateKey, VECTOR.proofPublicKey, VECTOR.transcript)

        expect(hex(proof)).toBe(VECTOR.proof)
    })

    it('differs for another write and for another identity key', async () => {
        const otherWrite = await identityPossessionProof(VECTOR.identityPrivateKey, VECTOR.proofPublicKey, utf8('another write'))
        const otherKey = await identityPossessionProof(new Uint8Array(32).fill(7), VECTOR.proofPublicKey, VECTOR.transcript)

        expect(hex(otherWrite)).not.toBe(VECTOR.proof)
        expect(hex(otherKey)).not.toBe(VECTOR.proof)
    })

    it('refuses a proof key anyone could compute the proof for', async () => {
        // The all-zero point has low order: the shared secret would be all zeros whatever the key.
        await expect(identityPossessionProof(VECTOR.identityPrivateKey, new Uint8Array(32), VECTOR.transcript)).rejects.toThrow(
            'the Sync Server offered a key that cannot be used',
        )
    })
})
