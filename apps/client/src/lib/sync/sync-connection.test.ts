import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DevicePasscodeLockedError, devicePasscode } from './device-passcode'
import { SYNC_CONNECTIONS_STORAGE_KEY, tokenSecretId, type StoredSyncConnections } from './sync-connections'
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

// Argon2id is slow on purpose: these tests check what the Device Passcode seals, not how it is
// stretched, so the device's one passcode stretches with a hash here.
vi.mock('./device-passcode', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./device-passcode')>()
    const { sha256, utf8 } = await import('$lib/crypto')
    return {
        ...actual,
        devicePasscode: actual.createDevicePasscode({
            storage: () => localStorage,
            channel: () => null,
            stretch: async (passcode, kdf) => sha256(utf8(`${passcode}|${kdf.salt}`)),
        }),
    }
})

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
const TEAM = 'https://team.example.org'

/** The access token a resolved connection presents, asked for as a request asks for it. */
function tokenOf(connection: { token: string | (() => Promise<string>) }): Promise<string> {
    return typeof connection.token === 'string' ? Promise.resolve(connection.token) : connection.token()
}

/** The custom servers' tokens as this device stores them. */
function storedTokens(): string[] {
    const stored = JSON.parse(localStorage.getItem(SYNC_CONNECTIONS_STORAGE_KEY) ?? '{"connections":[]}') as StoredSyncConnections
    return stored.connections.flatMap((connection) => (connection.kind === 'custom' ? [connection.token] : []))
}

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

    it('resolves a custom server to its own address, origin and access token', async () => {
        await saveCustomSyncConnection('https://Team.example.org/', 'epk_pat_a', MANAGED_URL)

        const custom = syncConnectionFor('https://team.example.org', MANAGED_URL)!
        expect(custom).toMatchObject({
            kind: 'custom',
            origin: 'https://team.example.org',
            serverBaseUrl: 'https://Team.example.org/',
            credential: 'epk_pat_a',
        })
        await expect(tokenOf(custom)).resolves.toBe('epk_pat_a')
        expect(resolveSyncConnection({ kind: 'managed' }, MANAGED_URL)?.credential).toBeNull()
    })

    it('lists every held connection, leaving out Managed Sync where this deployment offers none', async () => {
        saveManagedSyncConnection(MANAGED_URL)
        await saveCustomSyncConnection('https://team.example.org', 'epk_pat_a', MANAGED_URL)

        expect(listSyncConnections(MANAGED_URL).map((c) => c.origin)).toEqual([MANAGED_ORIGIN, 'https://team.example.org'])
        expect(listSyncConnections(null).map((c) => c.origin)).toEqual(['https://team.example.org'])
    })

    it('finds the connection for a graph’s server by origin', async () => {
        saveManagedSyncConnection(MANAGED_URL)
        await saveCustomSyncConnection('https://team.example.org/', 'epk_pat_a', MANAGED_URL)

        expect(syncConnectionFor('https://team.example.org', MANAGED_URL)?.kind).toBe('custom')
        expect(syncConnectionFor(`${MANAGED_ORIGIN}/`, MANAGED_URL)?.kind).toBe('managed')
        expect(syncConnectionFor('https://elsewhere.example', MANAGED_URL)).toBeNull()
        expect(syncConnectionFor('not a url', MANAGED_URL)).toBeNull()
    })

    it('stands Managed Sync for the device where one account must, else the first server added', async () => {
        await saveCustomSyncConnection('https://team.example.org', 'epk_pat_a', MANAGED_URL)
        expect(primarySyncConnection(MANAGED_URL)?.origin).toBe('https://team.example.org')

        saveManagedSyncConnection(MANAGED_URL)
        expect(primarySyncConnection(MANAGED_URL)?.origin).toBe(MANAGED_ORIGIN)
        // A deployment that stops offering Managed Sync falls back to what it can still reach.
        expect(primarySyncConnection(null)?.origin).toBe('https://team.example.org')
        expect(managedSyncServerOrigin(MANAGED_URL)).toBe(MANAGED_ORIGIN)
        expect(managedSyncServerOrigin(null)).toBeNull()
    })

    it('keeps a custom server when Managed Sync is connected, and the other way round', async () => {
        await saveCustomSyncConnection('https://team.example.org', 'epk_pat_a', MANAGED_URL)
        saveManagedSyncConnection(MANAGED_URL)

        expect(syncConnectionFor('https://team.example.org', MANAGED_URL)).toMatchObject({ credential: 'epk_pat_a' })
        expect(syncConnectionFor(MANAGED_ORIGIN, MANAGED_URL)?.kind).toBe('managed')
    })

    it('forgets one connection by origin and keeps the rest', async () => {
        saveManagedSyncConnection(MANAGED_URL)
        await saveCustomSyncConnection('https://team.example.org', 'epk_pat_a', MANAGED_URL)

        forgetSyncConnection('https://team.example.org', MANAGED_URL)
        expect(listSyncConnections(MANAGED_URL).map((c) => c.origin)).toEqual([MANAGED_ORIGIN])

        forgetSyncConnection(MANAGED_ORIGIN, MANAGED_URL)
        expect(listSyncConnections(MANAGED_URL)).toEqual([])
    })
})

describe('a custom server’s access token under the Device Passcode (ADR 0129)', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', memoryStorage())
        // The passcode's key lives in memory as well as storage: start every test with none.
        devicePasscode.forgotten()
    })
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('stores the token sealed, and presents it while this tab is unlocked', async () => {
        await devicePasscode.set('1234')
        await saveCustomSyncConnection(TEAM, 'epk_pat_a', MANAGED_URL)

        expect(storedTokens()).toEqual([expect.stringMatching(/^pc1:/)])
        expect(localStorage.getItem(SYNC_CONNECTIONS_STORAGE_KEY)).not.toContain('epk_pat_a')
        const custom = syncConnectionFor(TEAM, MANAGED_URL)!
        await expect(tokenOf(custom)).resolves.toBe('epk_pat_a')
        expect(custom.credential).toBe('epk_pat_a')
    })

    it('seals a token saved before the passcode was set', async () => {
        await saveCustomSyncConnection(TEAM, 'epk_pat_a', MANAGED_URL)
        expect(storedTokens()).toEqual(['epk_pat_a'])

        await devicePasscode.set('1234')

        expect(storedTokens()).toEqual([expect.stringMatching(/^pc1:/)])
        await expect(tokenOf(syncConnectionFor(TEAM, MANAGED_URL)!)).resolves.toBe('epk_pat_a')
    })

    it('refuses the token while this tab is locked, as a locked vault is refused, and presents it once unlocked', async () => {
        await devicePasscode.set('1234')
        await saveCustomSyncConnection(TEAM, 'epk_pat_a', MANAGED_URL)
        devicePasscode.lock()

        const locked = syncConnectionFor(TEAM, MANAGED_URL)!
        await expect(tokenOf(locked)).rejects.toBeInstanceOf(DevicePasscodeLockedError)
        // Unknown, not changed: a tab that cannot read the token cannot say it differs.
        expect(locked.credential).toBeNull()

        await devicePasscode.unlock('1234')
        await expect(tokenOf(locked)).resolves.toBe('epk_pat_a')
    })

    it('saves no token while locked, and keeps the one it holds', async () => {
        await devicePasscode.set('1234')
        await saveCustomSyncConnection(TEAM, 'epk_pat_a', MANAGED_URL)
        devicePasscode.lock()

        await expect(saveCustomSyncConnection(TEAM, 'epk_pat_b', MANAGED_URL)).rejects.toBeInstanceOf(DevicePasscodeLockedError)

        await devicePasscode.unlock('1234')
        await expect(tokenOf(syncConnectionFor(TEAM, MANAGED_URL)!)).resolves.toBe('epk_pat_a')
    })

    it('reads the token as stored at each request, so a connection resolved before the passcode was turned off still works', async () => {
        await devicePasscode.set('1234')
        await saveCustomSyncConnection(TEAM, 'epk_pat_a', MANAGED_URL)
        const resolved = syncConnectionFor(TEAM, MANAGED_URL)!

        await devicePasscode.turnOff('1234')

        expect(storedTokens()).toEqual(['epk_pat_a'])
        await expect(tokenOf(resolved)).resolves.toBe('epk_pat_a')
    })

    it('forgetting the passcode forgets each custom server whose token it sealed, and keeps Managed Sync', async () => {
        saveManagedSyncConnection(MANAGED_URL)
        await saveCustomSyncConnection(TEAM, 'epk_pat_a', MANAGED_URL)
        await devicePasscode.set('1234')

        devicePasscode.forgotten()

        expect(listSyncConnections(MANAGED_URL).map((c) => c.origin)).toEqual([MANAGED_ORIGIN])
    })

    it('forgetting a server drops its token from memory as well as storage', async () => {
        await devicePasscode.set('1234')
        await saveCustomSyncConnection(TEAM, 'epk_pat_a', MANAGED_URL)

        forgetSyncConnection(TEAM, MANAGED_URL)

        expect(devicePasscode.reveal(tokenSecretId(TEAM), null)).toBeNull()
    })

    it('says a forgotten connection is gone when its token is asked for', async () => {
        await saveCustomSyncConnection(TEAM, 'epk_pat_a', MANAGED_URL)
        const resolved = syncConnectionFor(TEAM, MANAGED_URL)!

        forgetSyncConnection(TEAM, MANAGED_URL)

        await expect(tokenOf(resolved)).rejects.toThrow('This device no longer holds a connection to team.example.org')
    })
})
