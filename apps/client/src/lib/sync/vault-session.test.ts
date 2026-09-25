import { beforeEach, describe, expect, it } from 'vitest'
import { deriveVaultWrapKey, generateRecoveryCode, toBase64Url } from '$lib/crypto'
import { clearActiveSyncAccount, setActiveSyncAccount } from './account-scope'
import { getVaultWrapKey, isVaultUnlocked, lockVault, setVaultWrapKey, unlockWithRecoveryCode } from './vault-session'

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
    it('starts locked, unlocks from a Recovery Code, and persists under the active account', async () => {
        setActiveSyncAccount(accountA)
        expect(isVaultUnlocked()).toBe(false)
        const code = generateRecoveryCode()
        const wrapKey = await unlockWithRecoveryCode(code)
        expect(isVaultUnlocked()).toBe(true)
        expect(Buffer.from(getVaultWrapKey()!).equals(Buffer.from(await deriveVaultWrapKey(code)))).toBe(true)
        expect(Buffer.from(getVaultWrapKey()!).equals(Buffer.from(wrapKey))).toBe(true)
        expect([...Array(localStorage.length)].map((_, index) => localStorage.key(index)))
            .toContain('etherpk:vault-wrap-key:https%3A%2F%2Fsync.example.com:principal-a')
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
