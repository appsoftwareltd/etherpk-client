import { describe, expect, it, vi } from 'vitest'
import {
    SYNC_CONFIG_CHANGED_EVENT,
    clearSyncConfig,
    readSyncConfig,
    relayUrlFrom,
    writeSyncConfig,
} from './sync-config'

describe('sync-config', () => {
    it('derives the ws relay URL from an http base', () => {
        expect(relayUrlFrom('http://localhost:5173')).toBe('ws://localhost:5173/sync')
        expect(relayUrlFrom('https://app.etherpk.example/')).toBe('wss://app.etherpk.example/sync')
    })
})

describe('managed and custom Sync configuration', () => {
    it('stores a managed preset without a server URL or bearer credential', () => {
        const storage = new Map<string, string>()
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
        })

        writeSyncConfig({ mode: 'managed' })

        expect(readSyncConfig()).toEqual({ mode: 'managed' })
        expect([...storage.values()][0]).not.toContain('token')
        vi.unstubAllGlobals()
    })

    it('keeps custom server PAT configuration explicit', () => {
        const storage = new Map<string, string>()
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
        })

        writeSyncConfig({ mode: 'custom', serverBaseUrl: 'https://sync.example', token: 'epk_pat_custom' })

        expect(readSyncConfig()).toEqual({
            mode: 'custom',
            serverBaseUrl: 'https://sync.example',
            token: 'epk_pat_custom',
        })
        vi.unstubAllGlobals()
    })

    it('notifies the app shell when configuration changes or is cleared', () => {
        const storage = new Map<string, string>()
        const dispatchEvent = vi.fn()
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
        })
        vi.stubGlobal('window', { dispatchEvent })

        writeSyncConfig({ mode: 'managed' })
        clearSyncConfig()

        expect(dispatchEvent).toHaveBeenCalledTimes(2)
        expect(dispatchEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
            type: SYNC_CONFIG_CHANGED_EVENT,
        }))
        expect(dispatchEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
            type: SYNC_CONFIG_CHANGED_EVENT,
        }))
        expect(readSyncConfig()).toBeNull()
        vi.unstubAllGlobals()
    })
})
