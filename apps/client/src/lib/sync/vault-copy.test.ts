import { beforeEach, describe, expect, it } from 'vitest'
import { EnvelopeError, deriveVaultWrapKey, generateRecoveryCode, toBase64Url, type ProtectionRecord } from '$lib/crypto'
import { ManagedTokenError } from '$lib/auth/managed-token'
import { setSyncAccount } from './account-scope'
import { devicePasscode } from './device-passcode'
import { ensureGraphKeys, vaultProtectionAccess } from './keys'
import { SyncApiError, type SyncApi } from './sync-api'
import { createFakeSyncServer, seedAccount } from './testing/fake-sync-server'
import { fallingBackToVaultCopy, keepingVaultCopy, openGraphKeys } from './vault-copy'
import { forgetVaultCopy, readVaultCopy } from './vault-session'

const ORIGIN = 'https://sync.example.com'
const ACCOUNT = 'account-1'

function memoryStorage(): Storage {
    const store = new Map<string, string>()
    return {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => void store.set(key, value),
        removeItem: (key) => void store.delete(key),
        clear: () => store.clear(),
        key: (index) => [...store.keys()][index] ?? null,
        get length() {
            return store.size
        },
    }
}

beforeEach(() => {
    globalThis.localStorage = memoryStorage()
    globalThis.sessionStorage = memoryStorage()
    devicePasscode.forgotten()
    setSyncAccount({ serverOrigin: ORIGIN, principalId: ACCOUNT })
})

/** One account on an in-memory Sync Server, seen through the API this device makes for it. */
async function seeded(graphIds: string[] = ['g1']) {
    const server = createFakeSyncServer()
    const wrapKey = await deriveVaultWrapKey(generateRecoveryCode())
    const seed = await seedAccount(server, ACCOUNT, { graphIds, wrapKey })
    const api = keepingVaultCopy(server.apiFor(ACCOUNT), ORIGIN)
    const stored = () => server.accounts.get(ACCOUNT)!.vault!
    // The API this device makes, which keeps the copy, in place of the seed's plain one.
    return { ...seed, server, api, stored }
}

/** A Sync API whose every call fails with `error`, as one does with no network or a server down. */
function failing(error: unknown): SyncApi {
    const fail = async () => {
        throw error
    }
    return { getVault: fail, putKeys: fail, me: fail } as unknown as SyncApi
}

describe('keepingVaultCopy', () => {
    it('keeps the vault each time the server sends it', async () => {
        const { api, stored } = await seeded()
        await api.getVault()
        expect(readVaultCopy(ORIGIN)).toEqual({ vault: toBase64Url(stored().bytes), version: stored().version, principalId: ACCOUNT })
    })

    it('keeps the vault this device writes, at the version the server gave it', async () => {
        const { api, wrapKey, stored } = await seeded(['g1'])
        await ensureGraphKeys(api, 'g2', async () => wrapKey, { newGraph: true })
        const copy = readVaultCopy(ORIGIN)!
        expect(copy.version).toBe(stored().version)
        expect(copy.vault).toBe(toBase64Url(stored().bytes))
    })

    it('forgets the copy when the account has no vault', async () => {
        const { api } = await seeded()
        await api.getVault()
        const empty = keepingVaultCopy(createFakeSyncServer().apiFor(ACCOUNT), ORIGIN)
        expect(await empty.getVault()).toBeNull()
        expect(readVaultCopy(ORIGIN)).toBeNull()
    })

    it('leaves the copy as it was when the server cannot be reached or refuses', async () => {
        const { api } = await seeded()
        await api.getVault()
        const kept = readVaultCopy(ORIGIN)
        await expect(keepingVaultCopy(failing(new TypeError('Failed to fetch')), ORIGIN).getVault()).rejects.toThrow('Failed to fetch')
        await expect(keepingVaultCopy(failing(new SyncApiError('Forbidden', 403)), ORIGIN).getVault()).rejects.toThrow('Forbidden')
        expect(readVaultCopy(ORIGIN)).toEqual(kept)
    })
})

describe('fallingBackToVaultCopy', () => {
    it('reads the server while it answers, and the copy once it cannot be reached', async () => {
        const { api, stored } = await seeded()
        await api.getVault()
        const copy = readVaultCopy(ORIGIN)

        expect((await fallingBackToVaultCopy(api, ORIGIN).getVault())?.version).toBe(stored().version)
        expect(await fallingBackToVaultCopy(failing(new TypeError('Failed to fetch')), ORIGIN).getVault()).toEqual(copy)
    })

    it('passes a refusal on, and the network error when no copy is held', async () => {
        const { api } = await seeded()
        await api.getVault()
        const refused = new SyncApiError('Forbidden', 403)
        await expect(fallingBackToVaultCopy(failing(refused), ORIGIN).getVault()).rejects.toBe(refused)

        forgetVaultCopy(ORIGIN)
        const offline = new TypeError('Failed to fetch')
        await expect(fallingBackToVaultCopy(failing(offline), ORIGIN).getVault()).rejects.toBe(offline)
    })

    it('reads a protection record from the copy, so a protected document unlocks offline', async () => {
        const { api, wrapKey } = await seeded(['g1'])
        const record = { v: 1, fingerprint: 'fp-1', wrapped: 'wrapped-key' } as unknown as ProtectionRecord
        await vaultProtectionAccess(api, async () => wrapKey).writeProtection('g1', record)

        const offline = fallingBackToVaultCopy(failing(new TypeError('Failed to fetch')), ORIGIN)
        expect((await vaultProtectionAccess(offline, async () => wrapKey).readProtection())?.g1).toEqual(record)
    })
})

describe('openGraphKeys', () => {
    it('opens from the server when it answers, and says so', async () => {
        const { api, wrapKey } = await seeded(['g1'])
        const opened = await openGraphKeys(api, 'g1', ORIGIN, async () => wrapKey)
        expect(opened.fromCopy).toBe(false)
        expect(opened.keyring.graphId).toBe('g1')
    })

    it('opens from the copy with the same Graph Key when the server cannot be reached', async () => {
        const { api, wrapKey, vaultKey } = await seeded(['g1'])
        const online = await openGraphKeys(api, 'g1', ORIGIN, async () => wrapKey)

        const offline = await openGraphKeys(failing(new TypeError('Failed to fetch')), 'g1', ORIGIN, async () => wrapKey)

        expect(offline.fromCopy).toBe(true)
        expect(offline.keyring.epochs.map((epoch) => epoch.key)).toEqual(online.keyring.epochs.map((epoch) => epoch.key))
        expect(offline.deviceKey).toEqual(vaultKey)
        await expect(offline.commit()).resolves.toBeUndefined()
    })

    it('opens from the copy when the server has not answered by the deadline', async () => {
        const { api, wrapKey } = await seeded(['g1'])
        await api.getVault()
        const silent = { ...api, getVault: () => new Promise<never>(() => {}) } as SyncApi

        const opened = await openGraphKeys(silent, 'g1', ORIGIN, async () => wrapKey, { deadlineMs: 20 })

        expect(opened.fromCopy).toBe(true)
    })

    it('waits for a slow server when no copy is held, as the open always has', async () => {
        const { server, wrapKey } = await seeded(['g1'])
        const direct = server.apiFor(ACCOUNT)
        const slow = { ...direct, getVault: () => new Promise((resolve) => setTimeout(() => resolve(direct.getVault()), 60)) } as SyncApi

        const opened = await openGraphKeys(slow, 'g1', ORIGIN, async () => wrapKey, { deadlineMs: 20 })

        expect(opened.fromCopy).toBe(false)
    })

    it('opens from the copy when the server fails, or the sign-in service is busy', async () => {
        const { api, wrapKey } = await seeded(['g1'])
        await api.getVault()
        for (const error of [new SyncApiError('Bad gateway', 502), new SyncApiError('Unavailable', 503), new ManagedTokenError('Busy', 503)]) {
            const opened = await openGraphKeys(failing(error), 'g1', ORIGIN, async () => wrapKey)
            expect(opened.fromCopy).toBe(true)
        }
    })

    it('fails as it always has when the server refuses, whatever copy is held', async () => {
        const { api, wrapKey } = await seeded(['g1'])
        await api.getVault()
        for (const error of [new SyncApiError('Unauthorized', 401), new SyncApiError('Forbidden', 403), new SyncApiError('Not found', 404), new ManagedTokenError('Signed out', 401)]) {
            await expect(openGraphKeys(failing(error), 'g1', ORIGIN, async () => wrapKey)).rejects.toBe(error)
        }
    })

    it('fails with the network error when no copy is held', async () => {
        const { api, wrapKey } = await seeded(['g1'])
        await api.getVault()
        forgetVaultCopy(ORIGIN)
        const error = new TypeError('Failed to fetch')
        await expect(openGraphKeys(failing(error), 'g1', ORIGIN, async () => wrapKey)).rejects.toBe(error)
    })

    it('fails with the network error when the copy holds no key for the graph', async () => {
        const { api, wrapKey } = await seeded(['g1'])
        await api.getVault()
        const error = new TypeError('Failed to fetch')
        // Joined on another device since this one last read the vault: only the server has its key.
        await expect(openGraphKeys(failing(error), 'g9', ORIGIN, async () => wrapKey)).rejects.toBe(error)
    })

    it('fails as online does when the key held here does not open the copy', async () => {
        const { api } = await seeded(['g1'])
        await api.getVault()
        const stale = await deriveVaultWrapKey(generateRecoveryCode())
        await expect(openGraphKeys(failing(new TypeError('Failed to fetch')), 'g1', ORIGIN, async () => stale)).rejects.toBeInstanceOf(EnvelopeError)
    })

    it("never reads another account's copy", async () => {
        const { api, wrapKey } = await seeded(['g1'])
        await api.getVault()
        setSyncAccount({ serverOrigin: ORIGIN, principalId: 'account-2' })
        const error = new TypeError('Failed to fetch')
        await expect(openGraphKeys(failing(error), 'g1', ORIGIN, async () => wrapKey)).rejects.toBe(error)
    })
})
