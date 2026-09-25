import { beforeEach, describe, expect, it } from 'vitest'
import {
    clearActiveSyncAccount,
    readActiveSyncAccount,
    setActiveSyncAccount,
} from './account-scope'

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
})

describe('active Sync account', () => {
    it('stores only the normalised Server origin and service-local Principal id', () => {
        setActiveSyncAccount({
            serverOrigin: 'https://sync.example.com/',
            principalId: '019c9e42-0b89-7000-8000-000000000001',
        })

        expect(readActiveSyncAccount()).toEqual({
            serverOrigin: 'https://sync.example.com',
            principalId: '019c9e42-0b89-7000-8000-000000000001',
        })
        expect(localStorage.getItem('etherpk:active-sync-account')).not.toContain('email')
    })

    it('clears identity state on explicit sign-out', () => {
        setActiveSyncAccount({ serverOrigin: 'https://sync.example.com', principalId: 'principal-a' })
        clearActiveSyncAccount()
        expect(readActiveSyncAccount()).toBeNull()
    })

    it('rejects corrupt and non-HTTP stored state', () => {
        localStorage.setItem('etherpk:active-sync-account', '{bad')
        expect(readActiveSyncAccount()).toBeNull()
        localStorage.setItem('etherpk:active-sync-account', JSON.stringify({
            serverOrigin: 'javascript:alert(1)',
            principalId: 'principal-a',
        }))
        expect(readActiveSyncAccount()).toBeNull()
    })
})
