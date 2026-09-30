import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    MANAGED_CONNECTION_KEY,
    SYNC_CONNECTIONS_CHANGED_EVENT,
    SYNC_CONNECTIONS_STORAGE_KEY,
    connectionKey,
    defaultServerForNewGraph,
    readLastNewGraphServer,
    readStoredSyncConnections,
    relayUrlFrom,
    rememberNewGraphServer,
    removeStoredSyncConnection,
    serverHost,
    storeSyncConnection,
} from './sync-connections'

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

beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage())
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('relayUrlFrom', () => {
    it('derives the ws relay URL from an http base', () => {
        expect(relayUrlFrom('http://localhost:5173')).toBe('ws://localhost:5173/sync')
        expect(relayUrlFrom('https://app.etherpk.example/')).toBe('wss://app.etherpk.example/sync')
    })
})

describe('serverHost', () => {
    it('names a server by its host, port included', () => {
        expect(serverHost('https://sync.etherpk.com')).toBe('sync.etherpk.com')
        expect(serverHost('http://localhost:5173')).toBe('localhost:5173')
        expect(serverHost('not a url')).toBe('not a url')
    })
})

describe('connectionKey', () => {
    it('names Managed Sync by a fixed key and a custom server by its normalised origin', () => {
        expect(connectionKey({ kind: 'managed' })).toBe(MANAGED_CONNECTION_KEY)
        expect(connectionKey({ kind: 'custom', serverBaseUrl: 'https://Sync.Example.com:443/base/', token: 'epk_pat_x' }))
            .toBe('https://sync.example.com')
    })
})

describe('stored Sync Connections', () => {
    it('holds nothing on a new device', () => {
        expect(readStoredSyncConnections()).toEqual({ connections: [] })
    })

    it('keeps several connections, one per server, in the order they were added', () => {
        storeSyncConnection({ kind: 'managed' }, MANAGED_ORIGIN)
        storeSyncConnection({ kind: 'custom', serverBaseUrl: 'https://team.example.org', token: 'epk_pat_a' }, MANAGED_ORIGIN)

        expect(readStoredSyncConnections()).toEqual({
            connections: [
                { kind: 'managed' },
                { kind: 'custom', serverBaseUrl: 'https://team.example.org', token: 'epk_pat_a' },
            ],
        })
    })

    it('replaces a saved server of the same origin in place rather than keeping two', () => {
        storeSyncConnection({ kind: 'custom', serverBaseUrl: 'https://team.example.org', token: 'epk_pat_old' }, MANAGED_ORIGIN)
        storeSyncConnection({ kind: 'managed' }, MANAGED_ORIGIN)
        storeSyncConnection({ kind: 'custom', serverBaseUrl: 'https://team.example.org/', token: 'epk_pat_new' }, MANAGED_ORIGIN)

        expect(readStoredSyncConnections().connections).toEqual([
            { kind: 'custom', serverBaseUrl: 'https://team.example.org/', token: 'epk_pat_new' },
            { kind: 'managed' },
        ])
    })

    it('treats a custom connection to the Managed Sync origin as the same server as Managed Sync', () => {
        storeSyncConnection({ kind: 'managed' }, MANAGED_ORIGIN)
        storeSyncConnection({ kind: 'custom', serverBaseUrl: MANAGED_ORIGIN, token: 'epk_pat_x' }, MANAGED_ORIGIN)

        expect(readStoredSyncConnections()).toEqual({
            connections: [{ kind: 'custom', serverBaseUrl: MANAGED_ORIGIN, token: 'epk_pat_x' }],
        })
    })

    it('removes one connection and keeps the rest', () => {
        storeSyncConnection({ kind: 'managed' }, MANAGED_ORIGIN)
        storeSyncConnection({ kind: 'custom', serverBaseUrl: 'https://team.example.org', token: 'epk_pat_a' }, MANAGED_ORIGIN)

        removeStoredSyncConnection('https://team.example.org')
        expect(readStoredSyncConnections()).toEqual({ connections: [{ kind: 'managed' }] })
        removeStoredSyncConnection(MANAGED_CONNECTION_KEY)
        expect(readStoredSyncConnections()).toEqual({ connections: [] })
    })

    it('drops entries it cannot read rather than failing the whole list', () => {
        localStorage.setItem(SYNC_CONNECTIONS_STORAGE_KEY, JSON.stringify({
            connections: [
                { kind: 'custom', serverBaseUrl: 'javascript:alert(1)', token: 'epk_pat_x' },
                { kind: 'custom', serverBaseUrl: 'https://ok.example', token: 'epk_pat_ok' },
                { kind: 'custom', serverBaseUrl: 'https://no-token.example' },
                { kind: 'mystery' },
            ],
        }))

        expect(readStoredSyncConnections()).toEqual({
            connections: [{ kind: 'custom', serverBaseUrl: 'https://ok.example', token: 'epk_pat_ok' }],
        })
        localStorage.setItem(SYNC_CONNECTIONS_STORAGE_KEY, '{bad')
        expect(readStoredSyncConnections()).toEqual({ connections: [] })
    })

    it('stores no bearer credential for Managed Sync', () => {
        storeSyncConnection({ kind: 'managed' }, MANAGED_ORIGIN)
        expect(localStorage.getItem(SYNC_CONNECTIONS_STORAGE_KEY)).not.toContain('token')
    })

    it('notifies the app shell in this tab whenever the connections change', () => {
        const dispatchEvent = vi.fn()
        vi.stubGlobal('window', { dispatchEvent })

        storeSyncConnection({ kind: 'managed' }, MANAGED_ORIGIN)
        removeStoredSyncConnection(MANAGED_CONNECTION_KEY)

        expect(dispatchEvent).toHaveBeenCalledTimes(2)
        for (const call of dispatchEvent.mock.calls) {
            expect(call[0]).toEqual(expect.objectContaining({ type: SYNC_CONNECTIONS_CHANGED_EVENT }))
        }
    })
})

describe('the server a new synced graph is offered on', () => {
    const team = 'https://team.example.org'
    const other = 'https://other.example.org'

    it('is the one used last, while the device still holds it', () => {
        expect(defaultServerForNewGraph([MANAGED_ORIGIN, team], team, MANAGED_ORIGIN)).toBe(team)
    })

    it('is Managed Sync when the last one is gone or was never recorded', () => {
        expect(defaultServerForNewGraph([team, MANAGED_ORIGIN], other, MANAGED_ORIGIN)).toBe(MANAGED_ORIGIN)
        expect(defaultServerForNewGraph([team, MANAGED_ORIGIN], null, MANAGED_ORIGIN)).toBe(MANAGED_ORIGIN)
    })

    it('is the first server without Managed Sync, and none without servers', () => {
        expect(defaultServerForNewGraph([team, other], null, null)).toBe(team)
        expect(defaultServerForNewGraph([], team, MANAGED_ORIGIN)).toBeNull()
    })

    it('is remembered on this device', () => {
        expect(readLastNewGraphServer()).toBeNull()
        rememberNewGraphServer(team)
        expect(readLastNewGraphServer()).toBe(team)
    })
})

describe('a device set up before it could hold several connections', () => {
    it('keeps its one custom server, token and all', () => {
        localStorage.setItem('etherpk:sync-config', JSON.stringify({ mode: 'custom', serverBaseUrl: 'https://team.example.org', token: 'epk_pat_kept' }))

        expect(readStoredSyncConnections()).toEqual({
            connections: [{ kind: 'custom', serverBaseUrl: 'https://team.example.org', token: 'epk_pat_kept' }],
        })
        expect(localStorage.getItem('etherpk:sync-config')).toBeNull()
        expect(localStorage.getItem(SYNC_CONNECTIONS_STORAGE_KEY)).not.toBeNull()
    })

    it('keeps its Managed Sync connection', () => {
        localStorage.setItem('etherpk:sync-config', JSON.stringify({ mode: 'managed' }))
        expect(readStoredSyncConnections()).toEqual({ connections: [{ kind: 'managed' }] })
    })

    it('discards an unreadable old setting without inventing a connection', () => {
        localStorage.setItem('etherpk:sync-config', '{bad')
        expect(readStoredSyncConnections()).toEqual({ connections: [] })
        expect(localStorage.getItem('etherpk:sync-config')).toBeNull()
    })
})
