import { describe, expect, it } from 'vitest'
import { generateIdentityKeyPair, generateSigningKeyPair, openVault, toBase64Url, type KeyVault } from '$lib/crypto'
import { pinState, publishedIdentity, savePin, withPin } from './pins'
import { createFakeSyncServer, newVault, seedAccount } from './testing/fake-sync-server'

const FRIEND = 'friend-1'
const NOW = () => new Date('2026-10-05T09:00:00.000Z')

function someIdentity() {
    return { publicKey: generateIdentityKeyPair().publicKey, signingPublicKey: generateSigningKeyPair().publicKey }
}

describe('pinState', () => {
    it('reads unpinned for somebody never pinned', () => {
        expect(pinState(newVault(), FRIEND, someIdentity())).toEqual({ kind: 'unpinned' })
    })

    it('reads verified or unverified when the server presents the pinned keys', () => {
        const identity = someIdentity()
        const verified = withPin(newVault(), FRIEND, identity, { email: 'friend@example.com', verified: true, now: NOW })
        const unverified = withPin(newVault(), FRIEND, identity, { email: 'friend@example.com', verified: false, now: NOW })

        expect(pinState(verified, FRIEND, identity)).toEqual({ kind: 'verified' })
        expect(pinState(unverified, FRIEND, identity)).toEqual({ kind: 'unverified' })
    })

    it('reads changed when either key differs from the pin', () => {
        const identity = someIdentity()
        const vault = withPin(newVault(), FRIEND, identity, { email: 'friend@example.com', verified: true, now: NOW })

        expect(pinState(vault, FRIEND, { ...identity, publicKey: generateIdentityKeyPair().publicKey }).kind).toBe('changed')
        expect(pinState(vault, FRIEND, { ...identity, signingPublicKey: generateSigningKeyPair().publicKey }).kind).toBe('changed')
    })
})

describe('withPin', () => {
    it('pins both keys, the address and the time', () => {
        const identity = someIdentity()

        const vault = withPin(newVault(), FRIEND, identity, { email: 'friend@example.com', verified: true, now: NOW })

        expect(vault.pins?.[FRIEND]).toEqual({
            publicKey: toBase64Url(identity.publicKey),
            signingPublicKey: toBase64Url(identity.signingPublicKey),
            email: 'friend@example.com',
            pinnedAt: '2026-10-05T09:00:00.000Z',
            verified: true,
        })
    })

    it('returns the same vault when the pin is already there, so nothing is written', () => {
        const identity = someIdentity()
        const vault = withPin(newVault(), FRIEND, identity, { email: 'friend@example.com', verified: true, now: NOW })

        expect(withPin(vault, FRIEND, identity, { email: 'friend@example.com', verified: true, now: NOW })).toBe(vault)
        // A first-use pin never undoes a comparison the user made.
        expect(withPin(vault, FRIEND, identity, { email: 'friend@example.com', verified: false, now: NOW })).toBe(vault)
    })

    it('marks a first-use pin verified once the user compares fingerprints, keeping fields it does not know', () => {
        const identity = someIdentity()
        const firstUse = withPin(newVault(), FRIEND, identity, { email: 'friend@example.com', verified: false, now: NOW })
        const withExtra: KeyVault = { ...firstUse, pins: { [FRIEND]: { ...firstUse.pins![FRIEND], futureField: 1 } as never } }

        const verified = withPin(withExtra, FRIEND, identity, { email: 'friend@example.com', verified: true, now: NOW })

        expect(verified.pins?.[FRIEND]).toMatchObject({ verified: true, futureField: 1 })
    })

    it('replaces the pin when the user trusts a new key', () => {
        const vault = withPin(newVault(), FRIEND, someIdentity(), { email: 'friend@example.com', verified: true, now: NOW })
        const next = someIdentity()

        const replaced = withPin(vault, FRIEND, next, { email: 'friend@example.com', verified: true, now: NOW })

        expect(pinState(replaced, FRIEND, next)).toEqual({ kind: 'verified' })
    })
})

describe('publishedIdentity', () => {
    it('reads the directory’s answer as keys, or null before the account has a signing key', () => {
        const identity = someIdentity()

        expect(
            publishedIdentity({ publicKey: toBase64Url(identity.publicKey), signingPublicKey: toBase64Url(identity.signingPublicKey) }),
        ).toEqual(identity)
        expect(publishedIdentity({ publicKey: toBase64Url(identity.publicKey), signingPublicKey: null })).toBeNull()
        expect(publishedIdentity(null)).toBeNull()
    })
})

describe('savePin', () => {
    it('writes the pin into the account’s vault on the server, so every device knows it', async () => {
        const server = createFakeSyncServer()
        const { api, vaultKey } = await seedAccount(server, 'account-1')
        const identity = someIdentity()

        await savePin(api, vaultKey, FRIEND, identity, { email: 'friend@example.com', verified: true })

        const stored = await openVault(server.accounts.get('account-1')!.vault!.bytes, vaultKey)
        expect(pinState(stored.vault, FRIEND, identity)).toEqual({ kind: 'verified' })
    })
})
