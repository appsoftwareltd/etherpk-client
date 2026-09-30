import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    configuredSyncServerUrl,
    defaultCustomSyncUrl,
    isManagedSyncConfigured,
} from './sync-deployment'
import {
    forgetSyncConnection,
    listSyncConnections,
    resolveSyncConnection,
    saveCustomSyncConnection,
    managedSyncServerOrigin,
    primarySyncConnection,
    saveManagedSyncConnection,
    syncConnectionFor,
} from './sync-connection'

describe('deployment Sync presets', () => {
    it('disables Managed Sync when its public URL is blank', () => {
        expect(isManagedSyncConfigured({ PUBLIC_MANAGED_SYNC_URL: '' })).toBe(false)
        expect(isManagedSyncConfigured({})).toBe(false)
    })

    it('enables Managed Sync only when its public URL is present', () => {
        expect(isManagedSyncConfigured({
            PUBLIC_MANAGED_SYNC_URL: 'https://sync.example.com',
        })).toBe(true)
    })

    it('provides an optional standalone custom Server default', () => {
        expect(defaultCustomSyncUrl({
            PUBLIC_CUSTOM_SYNC_URL: ' https://standalone-sync.example.com/ ',
        })).toBe('https://standalone-sync.example.com')
        expect(defaultCustomSyncUrl({})).toBe('')
    })

    it('uses the managed Server for navigation when the managed preset is enabled', () => {
        expect(configuredSyncServerUrl({
            PUBLIC_MANAGED_SYNC_URL: ' https://sync.example.com/ ',
            PUBLIC_CUSTOM_SYNC_URL: 'https://private.example.com',
        })).toBe('https://sync.example.com')
    })

    it('uses the custom Server for navigation in a standalone deployment', () => {
        expect(configuredSyncServerUrl({
            PUBLIC_MANAGED_SYNC_URL: '',
            PUBLIC_CUSTOM_SYNC_URL: ' https://sync.example.org/ ',
        })).toBe('https://sync.example.org')
        expect(configuredSyncServerUrl({})).toBeNull()
    })
})

const MANAGED_URL = 'https://sync.etherpk.example/'
const MANAGED_ORIGIN = 'https://sync.etherpk.example'

function memoryStorage(): Storage {
    const store = new Map<string, string>()
    return {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => void store.set(key, String(value)),
        removeItem: (key) => void store.delete(key),
        clear: () => store.clear(),
        key: (index) => [...store.keys()][index] ?? null,
        get length() {
            return store.size
        },
    }
}

describe('the device’s Sync Connections, resolved against the deployment', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', memoryStorage())
    })
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('resolves Managed Sync to the deployment’s server and a token source, never a stored credential', () => {
        const managed = resolveSyncConnection({ kind: 'managed' }, MANAGED_URL)
        expect(managed).toMatchObject({ kind: 'managed', origin: MANAGED_ORIGIN, serverBaseUrl: MANAGED_ORIGIN })
        expect(typeof managed!.token).toBe('function')
        expect(resolveSyncConnection({ kind: 'managed' }, null)).toBeNull()
    })

    it('resolves a custom server to its own address, origin and access token', () => {
        expect(resolveSyncConnection({ kind: 'custom', serverBaseUrl: 'https://Team.example.org/', token: 'epk_pat_a' }, MANAGED_URL))
            .toEqual({ kind: 'custom', origin: 'https://team.example.org', serverBaseUrl: 'https://Team.example.org/', token: 'epk_pat_a' })
    })

    it('lists every held connection, leaving out Managed Sync where this deployment offers none', () => {
        saveManagedSyncConnection(MANAGED_URL)
        saveCustomSyncConnection('https://team.example.org', 'epk_pat_a', MANAGED_URL)

        expect(listSyncConnections(MANAGED_URL).map((c) => c.origin)).toEqual([MANAGED_ORIGIN, 'https://team.example.org'])
        expect(listSyncConnections(null).map((c) => c.origin)).toEqual(['https://team.example.org'])
    })

    it('finds the connection for a graph’s server by origin', () => {
        saveManagedSyncConnection(MANAGED_URL)
        saveCustomSyncConnection('https://team.example.org/', 'epk_pat_a', MANAGED_URL)

        expect(syncConnectionFor('https://team.example.org', MANAGED_URL)?.kind).toBe('custom')
        expect(syncConnectionFor(`${MANAGED_ORIGIN}/`, MANAGED_URL)?.kind).toBe('managed')
        expect(syncConnectionFor('https://elsewhere.example', MANAGED_URL)).toBeNull()
        expect(syncConnectionFor('not a url', MANAGED_URL)).toBeNull()
    })

    it('stands Managed Sync for the device where one account must, else the first server added', () => {
        saveCustomSyncConnection('https://team.example.org', 'epk_pat_a', MANAGED_URL)
        expect(primarySyncConnection(MANAGED_URL)?.origin).toBe('https://team.example.org')

        saveManagedSyncConnection(MANAGED_URL)
        expect(primarySyncConnection(MANAGED_URL)?.origin).toBe(MANAGED_ORIGIN)
        // A deployment that stops offering Managed Sync falls back to what it can still reach.
        expect(primarySyncConnection(null)?.origin).toBe('https://team.example.org')
        expect(managedSyncServerOrigin(MANAGED_URL)).toBe(MANAGED_ORIGIN)
        expect(managedSyncServerOrigin(null)).toBeNull()
    })

    it('keeps a custom server when Managed Sync is connected, and the other way round', () => {
        saveCustomSyncConnection('https://team.example.org', 'epk_pat_a', MANAGED_URL)
        saveManagedSyncConnection(MANAGED_URL)

        expect(syncConnectionFor('https://team.example.org', MANAGED_URL)).toMatchObject({ token: 'epk_pat_a' })
        expect(syncConnectionFor(MANAGED_ORIGIN, MANAGED_URL)?.kind).toBe('managed')
    })

    it('forgets one connection by origin and keeps the rest', () => {
        saveManagedSyncConnection(MANAGED_URL)
        saveCustomSyncConnection('https://team.example.org', 'epk_pat_a', MANAGED_URL)

        forgetSyncConnection('https://team.example.org', MANAGED_URL)
        expect(listSyncConnections(MANAGED_URL).map((c) => c.origin)).toEqual([MANAGED_ORIGIN])

        forgetSyncConnection(MANAGED_ORIGIN, MANAGED_URL)
        expect(listSyncConnections(MANAGED_URL)).toEqual([])
    })
})
