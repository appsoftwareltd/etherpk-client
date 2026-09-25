import { describe, expect, it } from 'vitest'
import { deviceApprovalSas } from './device-sas'
import { generateIdentityKeyPair } from './identity'

describe('device approval SAS', () => {
    it('is deterministic for a key and formatted for human comparison', async () => {
        const { publicKey } = generateIdentityKeyPair()
        const a = await deviceApprovalSas(publicKey)
        expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/) // Crockford: no I, L, O, U
        expect(await deviceApprovalSas(publicKey)).toBe(a)
    })

    it('differs between keys (a substituted key shows a different code)', async () => {
        const a = await deviceApprovalSas(generateIdentityKeyPair().publicKey)
        const b = await deviceApprovalSas(generateIdentityKeyPair().publicKey)
        expect(a).not.toBe(b)
    })
})
