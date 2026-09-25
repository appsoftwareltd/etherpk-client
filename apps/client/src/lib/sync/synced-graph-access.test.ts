import { afterEach, describe, expect, it } from 'vitest'

import { createGraphKeyring, encryptVault, generateIdentityKeyPair, toBase64Url } from '$lib/crypto'

import { heldGraphKeyring, openHeldVault, resolveSyncedGraphConnection } from './synced-graph-access'
import { SYNC_CONFIG_STORAGE_KEY } from './sync-config'
import type { SyncApi } from './sync-api'

/** A `Storage` in memory, installed as the global the config and vault modules read. */
function installLocalStorage(): Map<string, string> {
    const map = new Map<string, string>()
    const storage: Storage = {
        get length() {
            return map.size
        },
        clear: () => map.clear(),
        getItem: (k) => map.get(k) ?? null,
        key: (i) => [...map.keys()][i] ?? null,
        removeItem: (k) => void map.delete(k),
        setItem: (k, v) => void map.set(k, String(v)),
    }
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
    return map
}

/** A sealed vault holding `keyrings`, and the wrap key that opens it. */
async function sealedVault(keyrings: ReturnType<typeof createGraphKeyring>[]) {
    const identity = generateIdentityKeyPair()
    const wrapKey = new Uint8Array(32).fill(7)
    const encrypted = await encryptVault(
        { identityPrivateKey: identity.privateKey, identityPublicKey: identity.publicKey, keyrings },
        wrapKey,
    )
    return { envelope: toBase64Url(encrypted.envelope), wrapKey, vaultKey: encrypted.vaultKey }
}

function apiWithVault(envelope: string | null): Pick<SyncApi, 'getVault'> {
    return { getVault: async () => (envelope ? { vault: envelope, version: 1 } : null) }
}

afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage')
})

describe('resolveSyncedGraphConnection', () => {
    it('is null on a device with no sync configuration', () => {
        installLocalStorage()
        expect(resolveSyncedGraphConnection('g1')).toBeNull()
    })

    it('derives the API, the relay URL and a refreshing token source from a custom connection', async () => {
        const store = installLocalStorage()
        store.set(SYNC_CONFIG_STORAGE_KEY, JSON.stringify({ mode: 'custom', serverBaseUrl: 'https://sync.example.com/', token: 'epk_pat_x' }))
        const connection = resolveSyncedGraphConnection('g1')
        expect(connection).not.toBeNull()
        expect(connection!.serverBaseUrl).toBe('https://sync.example.com/')
        expect(connection!.relayUrl).toBe('wss://sync.example.com/sync')
        expect(typeof connection!.token).toBe('function')
        expect(typeof connection!.api.mintSyncToken).toBe('function')
    })
})

describe('openHeldVault', () => {
    it('is null when this device holds no wrap key, without asking the server', async () => {
        let asked = 0
        const api: Pick<SyncApi, 'getVault'> = {
            getVault: async () => {
                asked++
                return null
            },
        }
        expect(await openHeldVault(api, null)).toBeNull()
        expect(asked).toBe(0)
    })

    it('is null when the account has no vault yet', async () => {
        expect(await openHeldVault(apiWithVault(null), new Uint8Array(32))).toBeNull()
    })

    it('opens the vault under the held key and hands back its keyrings', async () => {
        const keyring = createGraphKeyring('g1')
        const sealed = await sealedVault([keyring])
        const opened = await openHeldVault(apiWithVault(sealed.envelope), sealed.wrapKey)
        expect(opened?.vault.keyrings.map((k) => k.graphId)).toEqual(['g1'])
    })

    it('rejects a key that does not open the vault, rather than reading it as "no vault"', async () => {
        const sealed = await sealedVault([])
        await expect(openHeldVault(apiWithVault(sealed.envelope), new Uint8Array(32).fill(9))).rejects.toThrow()
    })
})

describe('heldGraphKeyring', () => {
    it("is the graph's keyring when the held vault carries one, else null", async () => {
        const keyring = createGraphKeyring('g1')
        const sealed = await sealedVault([keyring])
        const api = apiWithVault(sealed.envelope)
        expect((await heldGraphKeyring(api, 'g1', sealed.wrapKey))?.graphId).toBe('g1')
        expect(await heldGraphKeyring(api, 'g2', sealed.wrapKey)).toBeNull()
        expect(await heldGraphKeyring(api, 'g1', null)).toBeNull()
    })
})
