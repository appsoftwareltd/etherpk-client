import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveVaultWrapKey, encryptVault, generateIdentityKeyPair, generateRecoveryCode, RecoveryCodeError, toBase64Url } from '$lib/crypto'
import { clearSyncAccount, setSyncAccount } from './account-scope'
import { NoVaultError } from './recovery-unlock'
import type { SyncApi } from './sync-api'
import { DevicePasscodeLockedError, devicePasscode } from './device-passcode'
import {
    VaultLockedError,
    getVaultWrapKey,
    isVaultUnlocked,
    lockEveryVault,
    lockVault,
    requireVaultWrapKey,
    setVaultWrapKey,
    unlockWithRecoveryCode,
} from './vault-session'

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

const MANAGED = 'https://sync.example.com'
const TEAM = 'https://team.example.org'
const accountA = { serverOrigin: MANAGED, principalId: 'principal-a' }
const accountB = { serverOrigin: MANAGED, principalId: 'principal-b' }
const teamAccount = { serverOrigin: TEAM, principalId: 'principal-team' }

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
    // The device's passcode lives in memory as well as in storage: start every test with none.
    devicePasscode.forgotten()
})

describe('vault-session with a Device Passcode (ADR 0129)', () => {
    it('stores the cached key sealed, and reads it back in a tab that has been unlocked', async () => {
        setSyncAccount(accountA)
        const key = new Uint8Array(32).fill(7)
        setVaultWrapKey(MANAGED, key)

        await devicePasscode.set('1234')

        const stored = localStorage.getItem('etherpk:vault-wrap-key:https%3A%2F%2Fsync.example.com:principal-a')!
        expect(stored).toMatch(/^pc1:/)
        expect(stored).not.toContain(toBase64Url(key))
        expect(getVaultWrapKey(MANAGED)).toEqual(key)

        devicePasscode.lock()
        expect(getVaultWrapKey(MANAGED)).toBeNull()
        expect(isVaultUnlocked(MANAGED)).toBe(false)
        await devicePasscode.unlock('1234')
        expect(getVaultWrapKey(MANAGED)).toEqual(key)
    }, 30_000)

    it('stores a key cached while unlocked sealed, and locking a vault drops it from memory too', async () => {
        setSyncAccount(accountA)
        await devicePasscode.set('1234')
        const key = new Uint8Array(32).fill(9)

        setVaultWrapKey(MANAGED, key)

        expect(getVaultWrapKey(MANAGED)).toEqual(key)
        await vi.waitFor(() =>
            expect(localStorage.getItem('etherpk:vault-wrap-key:https%3A%2F%2Fsync.example.com:principal-a')).toMatch(/^pc1:/),
        )
        lockVault(MANAGED)
        expect(getVaultWrapKey(MANAGED)).toBeNull()
    }, 30_000)

    it('says a key held sealed is locked with the passcode, and a key never held is locked on this device', async () => {
        setSyncAccount(accountA)
        const lockedError = () => {
            try {
                requireVaultWrapKey(MANAGED)
            } catch (error) {
                return error
            }
            return null
        }
        expect((lockedError() as Error).name).toBe('VaultLockedError')

        const key = new Uint8Array(32).fill(5)
        setVaultWrapKey(MANAGED, key)
        await devicePasscode.set('1234')
        devicePasscode.lock()

        expect(lockedError()).toBeInstanceOf(DevicePasscodeLockedError)
        expect(lockedError()).toBeInstanceOf(VaultLockedError)
        await devicePasscode.unlock('1234')
        expect(requireVaultWrapKey(MANAGED)).toEqual(key)
    }, 30_000)
})

describe('vault-session', () => {
    it("starts locked, unlocks from a Recovery Code that opens the vault, and caches the vault key under that server's account", async () => {
        setSyncAccount(accountA)
        expect(isVaultUnlocked(MANAGED)).toBe(false)
        const { code, vaultKey, api } = await account()
        const unlocked = await unlockWithRecoveryCode(api, code, MANAGED)
        expect(isVaultUnlocked(MANAGED)).toBe(true)
        // The vault key, as Device Approval caches: it survives a Recovery Code regeneration.
        expect(Buffer.from(getVaultWrapKey(MANAGED)!).equals(Buffer.from(vaultKey))).toBe(true)
        expect(Buffer.from(unlocked).equals(Buffer.from(vaultKey))).toBe(true)
        expect([...Array(localStorage.length)].map((_, index) => localStorage.key(index)))
            .toContain('etherpk:vault-wrap-key:https%3A%2F%2Fsync.example.com:principal-a')
    })

    it('refuses a wrong or retired Recovery Code as wrong, and caches nothing', async () => {
        // Any well-formed code derives a key, so only opening the vault tells a right code from
        // a wrong one.
        setSyncAccount(accountA)
        const { api } = await account()
        await expect(unlockWithRecoveryCode(api, generateRecoveryCode(), MANAGED)).rejects.toBeInstanceOf(RecoveryCodeError)
        await expect(unlockWithRecoveryCode(api, 'EPK1-AAAAA-BBBBB-CCCCC-DDDDD-EEEEEE', MANAGED)).rejects.toBeInstanceOf(RecoveryCodeError)
        expect(isVaultUnlocked(MANAGED)).toBe(false)
    })

    it('caches nothing when the vault cannot be read to check the code against', async () => {
        setSyncAccount(accountA)
        const { code } = await account()
        const offline = { getVault: async () => { throw new TypeError('Failed to fetch') } } as unknown as Pick<SyncApi, 'getVault'>
        await expect(unlockWithRecoveryCode(offline, code, MANAGED)).rejects.toThrow('Failed to fetch')
        const empty = { getVault: async () => null } as unknown as Pick<SyncApi, 'getVault'>
        await expect(unlockWithRecoveryCode(empty, code, MANAGED)).rejects.toBeInstanceOf(NoVaultError)
        expect(isVaultUnlocked(MANAGED)).toBe(false)
    })

    it('does not expose one account vault key after another account signs in on the same server', async () => {
        setSyncAccount(accountA)
        const wrapKeyA = await deriveVaultWrapKey(generateRecoveryCode())
        setVaultWrapKey(MANAGED, wrapKeyA)

        setSyncAccount(accountB)
        expect(getVaultWrapKey(MANAGED)).toBeNull()
        const wrapKeyB = await deriveVaultWrapKey(generateRecoveryCode())
        setVaultWrapKey(MANAGED, wrapKeyB)
        expect(Buffer.from(getVaultWrapKey(MANAGED)!).equals(Buffer.from(wrapKeyB))).toBe(true)

        setSyncAccount(accountA)
        expect(Buffer.from(getVaultWrapKey(MANAGED)!).equals(Buffer.from(wrapKeyA))).toBe(true)
    })

    it("holds each server's keys apart, unlocked at the same time", () => {
        setSyncAccount(accountA)
        setSyncAccount(teamAccount)
        setVaultWrapKey(MANAGED, new Uint8Array(32).fill(1))
        setVaultWrapKey(TEAM, new Uint8Array(32).fill(2))

        expect(getVaultWrapKey(MANAGED)![0]).toBe(1)
        expect(getVaultWrapKey(TEAM)![0]).toBe(2)

        lockVault(TEAM)
        expect(getVaultWrapKey(TEAM)).toBeNull()
        expect(getVaultWrapKey(MANAGED)![0]).toBe(1)
    })

    it('locks only the named server and refuses to cache a key for a server with no confirmed account', async () => {
        setSyncAccount(accountA)
        setVaultWrapKey(MANAGED, await deriveVaultWrapKey(generateRecoveryCode()))
        lockVault(MANAGED)
        expect(getVaultWrapKey(MANAGED)).toBeNull()

        clearSyncAccount(MANAGED)
        expect(() => setVaultWrapKey(MANAGED, new Uint8Array(32))).toThrow('Authenticate with the Sync Server before unlocking keys')
        expect(() => setVaultWrapKey(TEAM, new Uint8Array(32))).toThrow('Authenticate with the Sync Server before unlocking keys')
    })

    it('removes the unsafe legacy unscoped key instead of assigning it to an account', () => {
        localStorage.setItem('etherpk:vault-wrap-key', toBase64Url(new Uint8Array(32).fill(1)))
        sessionStorage.setItem('etherpk:vault-wrap-key', toBase64Url(new Uint8Array(32).fill(2)))
        setSyncAccount(accountA)

        expect(getVaultWrapKey(MANAGED)).toBeNull()
        expect(localStorage.getItem('etherpk:vault-wrap-key')).toBeNull()
        expect(sessionStorage.getItem('etherpk:vault-wrap-key')).toBeNull()
    })

    // Clearing a shared machine leaves no account's keys behind, on any server.
    it('locks every account whose keys this browser holds, and nothing else', () => {
        setSyncAccount(accountA)
        setVaultWrapKey(MANAGED, new Uint8Array(32).fill(1))
        setSyncAccount(teamAccount)
        setVaultWrapKey(TEAM, new Uint8Array(32).fill(3))
        setSyncAccount(accountB)
        setVaultWrapKey(MANAGED, new Uint8Array(32).fill(2))
        localStorage.setItem('etherpk-recents:graph-1', 'kept')

        lockEveryVault()

        expect(getVaultWrapKey(MANAGED)).toBeNull()
        expect(getVaultWrapKey(TEAM)).toBeNull()
        setSyncAccount(accountA)
        expect(getVaultWrapKey(MANAGED)).toBeNull()
        expect(localStorage.getItem('etherpk-recents:graph-1')).toBe('kept')
    })
})
