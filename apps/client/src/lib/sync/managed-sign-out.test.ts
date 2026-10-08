import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readSyncAccount, setSyncAccount } from './account-scope'
import { devicePasscode } from './device-passcode'
import { isVaultUnlocked, setVaultWrapKey } from './vault-session'

const MANAGED = 'https://sync.example.com'
const TEAM = 'https://team.example.org'

const signals = vi.hoisted(() => ({ announce: vi.fn() }))
vi.mock('./account-signal', () => ({ announceAccountSignal: signals.announce }))
vi.mock('$lib/auth/managed-token', () => ({ clearManagedAccessToken: vi.fn() }))
// This device holds Managed Sync beside a custom server (ADR 0111).
vi.mock('./sync-connection', () => ({
    listSyncConnections: () => [
        { kind: 'managed', origin: 'https://sync.example.com' },
        { kind: 'custom', origin: 'https://team.example.org' },
    ],
}))

const { endManagedSessionInThisBrowser } = await import('./managed-sign-out')

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
    devicePasscode.forgotten()
    signals.announce.mockClear()
})

describe("this browser's part of Sign out of EtherPK", () => {
    // Signing out of EtherPK ends the managed account alone. A custom server's account is its own,
    // so its keys stay unlocked and its account record stays.
    it("locks Managed Sync's keys and forgets its account, and leaves a custom server's", () => {
        setSyncAccount({ serverOrigin: MANAGED, principalId: 'principal-managed' })
        setSyncAccount({ serverOrigin: TEAM, principalId: 'principal-team' })
        setVaultWrapKey(MANAGED, new Uint8Array(32).fill(1))
        setVaultWrapKey(TEAM, new Uint8Array(32).fill(2))

        endManagedSessionInThisBrowser()

        // Locked before the account was forgotten: the stored key is gone, not merely unreadable.
        expect(localStorage.getItem('etherpk:vault-wrap-key:https%3A%2F%2Fsync.example.com:principal-managed')).toBeNull()
        expect(readSyncAccount(MANAGED)).toBeNull()
        expect(isVaultUnlocked(TEAM)).toBe(true)
        expect(readSyncAccount(TEAM)).toEqual({ serverOrigin: TEAM, principalId: 'principal-team' })
        expect(signals.announce).toHaveBeenCalledWith({ type: 'ended', reason: 'signed-out', serverOrigin: MANAGED })
    })
})
