import { beforeEach, describe, expect, it } from 'vitest'
import {
    clearSyncAccount,
    readSyncAccount,
    readSyncAccounts,
    setSyncAccount,
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

describe('Sync accounts, one per server', () => {
    it('stores only the normalised Server origin and service-local Principal id', () => {
        setSyncAccount({
            serverOrigin: 'https://sync.example.com/',
            principalId: '019c9e42-0b89-7000-8000-000000000001',
        })

        expect(readSyncAccount('https://sync.example.com')).toEqual({
            serverOrigin: 'https://sync.example.com',
            principalId: '019c9e42-0b89-7000-8000-000000000001',
        })
        expect(localStorage.getItem('etherpk:sync-accounts')).not.toContain('email')
    })

    it('keeps the account confirmed on each server apart from the others', () => {
        setSyncAccount({ serverOrigin: 'https://sync.example.com', principalId: 'principal-managed' })
        setSyncAccount({ serverOrigin: 'https://team.example.org', principalId: 'principal-team' })

        expect(readSyncAccount('https://team.example.org/')?.principalId).toBe('principal-team')
        expect(readSyncAccounts()).toEqual([
            { serverOrigin: 'https://sync.example.com', principalId: 'principal-managed' },
            { serverOrigin: 'https://team.example.org', principalId: 'principal-team' },
        ])
    })

    it('replaces the account on a server when another signs in there', () => {
        setSyncAccount({ serverOrigin: 'https://sync.example.com', principalId: 'principal-a' })
        setSyncAccount({ serverOrigin: 'https://sync.example.com', principalId: 'principal-b' })
        expect(readSyncAccounts()).toEqual([{ serverOrigin: 'https://sync.example.com', principalId: 'principal-b' }])
    })

    it('clears one server on sign-out and leaves the others', () => {
        setSyncAccount({ serverOrigin: 'https://sync.example.com', principalId: 'principal-a' })
        setSyncAccount({ serverOrigin: 'https://team.example.org', principalId: 'principal-team' })

        clearSyncAccount('https://sync.example.com')

        expect(readSyncAccount('https://sync.example.com')).toBeNull()
        expect(readSyncAccount('https://team.example.org')?.principalId).toBe('principal-team')
    })

    it('rejects corrupt and non-HTTP stored state', () => {
        localStorage.setItem('etherpk:sync-accounts', '{bad')
        expect(readSyncAccounts()).toEqual([])
        localStorage.setItem('etherpk:sync-accounts', JSON.stringify({
            'javascript:alert(1)': 'principal-a',
            'https://ok.example': 'principal-ok',
            'https://empty.example': '',
        }))
        expect(readSyncAccounts()).toEqual([{ serverOrigin: 'https://ok.example', principalId: 'principal-ok' }])
    })

    it('answers null for a server address it cannot parse', () => {
        expect(readSyncAccount('not a url')).toBeNull()
    })
})

describe('a device that recorded one active account', () => {
    it('keeps that account as the one confirmed on its server', () => {
        localStorage.setItem('etherpk:active-sync-account', JSON.stringify({
            serverOrigin: 'https://sync.example.com',
            principalId: 'principal-a',
        }))

        expect(readSyncAccount('https://sync.example.com')?.principalId).toBe('principal-a')
        expect(localStorage.getItem('etherpk:active-sync-account')).toBeNull()
    })

    it('drops an unreadable record', () => {
        localStorage.setItem('etherpk:active-sync-account', '{bad')
        expect(readSyncAccounts()).toEqual([])
        expect(localStorage.getItem('etherpk:active-sync-account')).toBeNull()
    })
})
