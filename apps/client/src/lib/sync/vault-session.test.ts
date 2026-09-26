import { beforeEach, describe, expect, it } from 'vitest'
import { deriveVaultWrapKey, encryptVault, generateIdentityKeyPair, generateRecoveryCode, RecoveryCodeError, toBase64Url } from '$lib/crypto'
import { clearActiveSyncAccount, setActiveSyncAccount } from './account-scope'
import { NoVaultError } from './recovery-unlock'
import type { SyncApi } from './sync-api'
import { getVaultWrapKey, isVaultUnlocked, lockVault, setVaultWrapKey, unlockWithRecoveryCode } from './vault-session'

/** An account whose vault is wrapped by a fresh Recovery Code, behind a fake Sync API. */
async function account() {
    const code = generateRecoveryCode()
    const identity = generateIdentityKeyPair()
    const encrypted = await encryptVault(
        { identityPrivateKey: identity.privateKey, identityPublicKey: identity.publicKey, keyrings: [] },
        await deriveVaultWrapKey(code),
    )
    const api = { getVault: async () => ({ vault: toBase64Url(encrypted.envelope), version: 1 }) } as unknown as Pick<SyncApi, 'getVault'>
    return { code, vaultKey: encrypted.vaultKey, api }
}

const accountA = { serverOrigin: 'https://sync.example.com', principalId: 'principal-a' }
const accountB = { serverOrigin: 'https://sync.example.com', principalId: 'principal-b' }

function memoryStorage(): Storage {
    const store = new Map<string, string>()
    return {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => void store.set(key, value),
        removeItem: (key) => void store.delete(key),
        clear: () => store.clear(),
        key: (index) => [...store.keys()][index] ?? null,
        get length() { return store.size },
    }
}

beforeEach(() => {
    globalThis.localStorage = memoryStorage()
    globalThis.sessionStorage = memoryStorage()
    clearActiveSyncAccount()
})

describe('vault-session', () => {
    it('starts locked, unlocks from a Recovery Code that opens the vault, and caches the vault key under the active account', async () => {
        setActiveSyncAccount(accountA)
        expect(isVaultUnlocked()).toBe(false)
        const { code, vaultKey, api } = await account()
        const unlocked = await unlockWithRecoveryCode(api, code)
        expect(isVaultUnlocked()).toBe(true)
        // The vault key, as Device Approval caches: it survives a Recovery Code regeneration.
        expect(Buffer.from(getVaultWrapKey()!).equals(Buffer.from(vaultKey))).toBe(true)
        expect(Buffer.from(unlocked).equals(Buffer.from(vaultKey))).toBe(true)
        expect([...Array(localStorage.length)].map((_, index) => localStorage.key(index)))
            .toContain('etherpk:vault-wrap-key:https%3A%2F%2Fsync.example.com:principal-a')
    })

    it('refuses a wrong or retired Recovery Code as wrong, and caches nothing', async () => {
        // Any well-formed code derives a key, so only opening the vault tells a right code from
        // a wrong one.
        setActiveSyncAccount(accountA)
        const { api } = await account()
        await expect(unlockWithRecoveryCode(api, generateRecoveryCode())).rejects.toBeInstanceOf(RecoveryCodeError)
        await expect(unlockWithRecoveryCode(api, 'EPK1-AAAAA-BBBBB-CCCCC-DDDDD-EEEEEE')).rejects.toBeInstanceOf(RecoveryCodeError)
        expect(isVaultUnlocked()).toBe(false)
    })

    it('caches nothing when the vault cannot be read to check the code against', async () => {
        setActiveSyncAccount(accountA)
        const { code } = await account()
        const offline = { getVault: async () => { throw new TypeError('Failed to fetch') } } as unknown as Pick<SyncApi, 'getVault'>
        await expect(unlockWithRecoveryCode(offline, code)).rejects.toThrow('Failed to fetch')
        const empty = { getVault: async () => null } as unknown as Pick<SyncApi, 'getVault'>
        await expect(unlockWithRecoveryCode(empty, code)).rejects.toBeInstanceOf(NoVaultError)
        expect(isVaultUnlocked()).toBe(false)
    })

    it('does not expose one account vault key after switching accounts', async () => {
        setActiveSyncAccount(accountA)
        const wrapKeyA = await deriveVaultWrapKey(generateRecoveryCode())
        setVaultWrapKey(wrapKeyA)

        setActiveSyncAccount(accountB)
        expect(getVaultWrapKey()).toBeNull()
        const wrapKeyB = await deriveVaultWrapKey(generateRecoveryCode())
        setVaultWrapKey(wrapKeyB)
        expect(Buffer.from(getVaultWrapKey()!).equals(Buffer.from(wrapKeyB))).toBe(true)

        setActiveSyncAccount(accountA)
        expect(Buffer.from(getVaultWrapKey()!).equals(Buffer.from(wrapKeyA))).toBe(true)
    })

    it('locks only the active account and refuses to cache a key without one', async () => {
        setActiveSyncAccount(accountA)
        setVaultWrapKey(await deriveVaultWrapKey(generateRecoveryCode()))
        lockVault()
        expect(getVaultWrapKey()).toBeNull()

        clearActiveSyncAccount()
        expect(() => setVaultWrapKey(new Uint8Array(32))).toThrow('Authenticate with the Sync Server before unlocking keys')
    })

    it('removes the unsafe legacy unscoped key instead of assigning it to an account', () => {
        localStorage.setItem('etherpk:vault-wrap-key', toBase64Url(new Uint8Array(32).fill(1)))
        sessionStorage.setItem('etherpk:vault-wrap-key', toBase64Url(new Uint8Array(32).fill(2)))
        setActiveSyncAccount(accountA)

        expect(getVaultWrapKey()).toBeNull()
        expect(localStorage.getItem('etherpk:vault-wrap-key')).toBeNull()
        expect(sessionStorage.getItem('etherpk:vault-wrap-key')).toBeNull()
    })
})
