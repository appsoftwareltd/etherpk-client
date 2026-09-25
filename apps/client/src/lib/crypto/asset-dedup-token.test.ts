import { describe, expect, it } from 'vitest'

import { assetDedupToken, deriveAssetDedupSecret } from './asset-dedup-token'
import { bumpEpoch, createGraphKeyring, type GraphKeyring } from './keyring'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function keyringWith(graphId: string, firstKey: Uint8Array): GraphKeyring {
    return { graphId, epochs: [{ epochId: 1, key: firstKey }] }
}

describe('asset dedup token (ADR 0053)', () => {
    it('is deterministic: the same graph secret and content hash always give the same token', async () => {
        const keyring = keyringWith('g1', new Uint8Array(32).fill(7))
        const secret = await deriveAssetDedupSecret(keyring)
        expect(await assetDedupToken(secret, HASH_A)).toBe(await assetDedupToken(secret, HASH_A))
    })

    it('is 64 lowercase hex characters - the shape the Sync Server validates', async () => {
        const secret = await deriveAssetDedupSecret(createGraphKeyring('g1'))
        expect(await assetDedupToken(secret, HASH_A)).toMatch(/^[0-9a-f]{64}$/)
    })

    it('differs per content hash', async () => {
        const secret = await deriveAssetDedupSecret(createGraphKeyring('g1'))
        expect(await assetDedupToken(secret, HASH_A)).not.toBe(await assetDedupToken(secret, HASH_B))
    })

    it('differs per graph for the same content, so the server cannot compare across graphs', async () => {
        const a = await deriveAssetDedupSecret(createGraphKeyring('g1'))
        const b = await deriveAssetDedupSecret(createGraphKeyring('g2'))
        expect(await assetDedupToken(a, HASH_A)).not.toBe(await assetDedupToken(b, HASH_A))
    })

    it('is stable across epoch bumps: derived from the first epoch key, which is never pruned', async () => {
        const keyring = createGraphKeyring('g1')
        const before = await deriveAssetDedupSecret(keyring)
        const after = await deriveAssetDedupSecret(bumpEpoch(bumpEpoch(keyring)))
        expect(after).toEqual(before)
    })

    it('never equals the plaintext hash or the raw key - a blinded value, not a disclosure', async () => {
        const key = new Uint8Array(32).fill(1)
        const secret = await deriveAssetDedupSecret(keyringWith('g1', key))
        const token = await assetDedupToken(secret, HASH_A)
        expect(token).not.toBe(HASH_A)
        expect(secret).not.toEqual(key)
    })
})
