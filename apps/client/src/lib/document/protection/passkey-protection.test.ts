import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type DeviceProtectionWrap, keyFingerprint, toBase64Url } from '$lib/crypto'

import {
    type DeviceWrapStore,
    type PasskeyCeremony,
    PasskeyUnsupportedError,
    boundPasskey,
    decodeCredentialId,
    encodeCredentialId,
    enrolPasskey,
    indexedDbWrapStore,
    prfEnabledOn,
    prfSalt,
    prfSecretOf,
    unlockWithPasskey,
} from './passkey-protection'

const KEY = new Uint8Array(32).fill(7)
const SECRET = new Uint8Array(32).fill(3)

/** A PublicKeyCredential stand-in carrying whatever extension results the test needs. */
function credential(results: unknown, rawId = new Uint8Array([1, 2, 3]).buffer): PublicKeyCredential {
    return { rawId, getClientExtensionResults: () => results } as unknown as PublicKeyCredential
}

function ceremonyYielding(secret: Uint8Array | null): PasskeyCeremony {
    return {
        create: async () => credential({ prf: { enabled: secret !== null } }),
        assert: async () =>
            credential({ prf: { results: secret ? { first: secret.buffer.slice(0) } : undefined } }),
    }
}

function memoryStore(): DeviceWrapStore & { peek: () => Map<string, DeviceProtectionWrap> } {
    const wraps = new Map<string, DeviceProtectionWrap>()
    return {
        read: async (graphId) => wraps.get(graphId) ?? null,
        write: async (graphId, wrap) => void wraps.set(graphId, wrap),
        clear: async (graphId) => void wraps.delete(graphId),
        peek: () => wraps,
    }
}

describe('the PRF salt', () => {
    it('is stable for one graph, so the same passkey derives the same secret every time', () => {
        expect(prfSalt('graph-1')).toEqual(prfSalt('graph-1'))
    })

    it('differs between graphs, so one device’s two graphs do not share a derived secret', () => {
        expect(prfSalt('graph-1')).not.toEqual(prfSalt('graph-2'))
    })
})

describe('reading the ceremony result', () => {
    it('returns the PRF output when the authenticator produced one', () => {
        const secret = prfSecretOf(credential({ prf: { results: { first: SECRET.buffer.slice(0) } } }))

        expect(toBase64Url(secret!)).toBe(toBase64Url(SECRET))
    })

    // There is no capability query for this — an authenticator without PRF announces itself only
    // by producing nothing, so a null result has to be a supported outcome rather than a crash.
    it('returns null when the authenticator has no PRF support', () => {
        expect(prfSecretOf(credential({}))).toBeNull()
        expect(prfSecretOf(null)).toBeNull()
    })

    it('reads the enabled flag from a freshly created credential', () => {
        expect(prfEnabledOn(credential({ prf: { enabled: true } }))).toBe(true)
        expect(prfEnabledOn(credential({ prf: {} }))).toBe(false)
        expect(prfEnabledOn(null)).toBe(false)
    })
})

describe('credential ids', () => {
    it('round-trip through the base64url form the wrap stores', () => {
        const raw = new Uint8Array([0, 1, 250, 255, 128]).buffer

        expect(decodeCredentialId(encodeCredentialId(raw))).toEqual(new Uint8Array(raw))
    })
})

describe('enrolling a passkey', () => {
    it('stores a wrap that opens the same Protection Key', async () => {
        const store = memoryStore()

        const wrap = await enrolPasskey('graph-1', KEY, { ceremony: ceremonyYielding(SECRET), store })

        expect(wrap.fingerprint).toBe(toBase64Url(await keyFingerprint(KEY)))
        expect(store.peek().get('graph-1')).toEqual(wrap)
    })

    // Deriving the secret from an assertion rather than from creation is deliberate: `prf.eval` at
    // creation is honoured inconsistently, and a wrap built from a secret we cannot reproduce on
    // unlock is worse than no wrap at all.
    it('reads the secret from an assertion, not from the creation result', async () => {
        const assert = vi.fn(async () => credential({ prf: { results: { first: SECRET.buffer.slice(0) } } }))

        await enrolPasskey('graph-1', KEY, {
            ceremony: { create: async () => credential({ prf: { enabled: true } }), assert },
            store: memoryStore(),
        })

        expect(assert).toHaveBeenCalled()
    })

    it('refuses, with a reason, when the authenticator has no PRF support', async () => {
        await expect(
            enrolPasskey('graph-1', KEY, { ceremony: ceremonyYielding(null), store: memoryStore() }),
        ).rejects.toThrow(PasskeyUnsupportedError)
    })

    it('stores nothing when the ceremony cannot produce a secret', async () => {
        const store = memoryStore()

        await enrolPasskey('graph-1', KEY, { ceremony: ceremonyYielding(null), store }).catch(() => {})

        expect(store.peek().size).toBe(0)
    })
})

describe('unlocking with a passkey', () => {
    it('returns the Protection Key without a passphrase', async () => {
        const store = memoryStore()
        const ceremony = ceremonyYielding(SECRET)
        await enrolPasskey('graph-1', KEY, { ceremony, store })

        const key = await unlockWithPasskey('graph-1', toBase64Url(await keyFingerprint(KEY)), { ceremony, store })

        expect(toBase64Url(key)).toBe(toBase64Url(KEY))
    })

    it('refuses when no passkey is bound on this device', async () => {
        await expect(
            unlockWithPasskey('graph-1', null, { ceremony: ceremonyYielding(SECRET), store: memoryStore() }),
        ).rejects.toThrow(PasskeyUnsupportedError)
    })
})

describe('a stale wrap', () => {
    // A wrap for a key the graph no longer uses would unwrap to something that decrypts nothing.
    // Reporting it as absent sends the user to the passphrase instead of into a silent failure.
    it('reads as no passkey bound, so the passphrase is offered instead', async () => {
        const store = memoryStore()
        await enrolPasskey('graph-1', KEY, { ceremony: ceremonyYielding(SECRET), store })

        expect(await boundPasskey('graph-1', 'a-different-fingerprint', { store })).toBeNull()
    })

    it('is still returned when the caller does not know the fingerprint yet', async () => {
        const store = memoryStore()
        await enrolPasskey('graph-1', KEY, { ceremony: ceremonyYielding(SECRET), store })

        expect(await boundPasskey('graph-1', null, { store })).not.toBeNull()
    })
})

describe('the IndexedDB wrap store', () => {
    it('round-trips a wrap and settles only once the write is committed, so "bound" is never a lie', async () => {
        const wrap: DeviceProtectionWrap = { v: 1, fingerprint: 'fp', credentialId: 'cred', wrapped: 'blob' }

        await indexedDbWrapStore.write('graph-idb', wrap)
        // Read straight after the write resolves: a write that settled on the request rather than
        // the transaction could still be un-committed here.
        expect(await indexedDbWrapStore.read('graph-idb')).toEqual(wrap)

        await indexedDbWrapStore.clear('graph-idb')
        expect(await indexedDbWrapStore.read('graph-idb')).toBeNull()
    })

    it('answers null for a graph that has no wrap, which is not an error', async () => {
        expect(await indexedDbWrapStore.read('never-enrolled')).toBeNull()
    })
})

describe('the wrap store when the browser loses its IndexedDB but keeps localStorage', () => {
    function memoryStorage(): Storage {
        const map = new Map<string, string>()
        return {
            get length() {
                return map.size
            },
            clear: () => map.clear(),
            getItem: (key) => map.get(key) ?? null,
            key: (index) => [...map.keys()][index] ?? null,
            removeItem: (key) => void map.delete(key),
            setItem: (key, value) => void map.set(key, String(value)),
        }
    }

    async function deleteProtectionDatabase(): Promise<void> {
        await new Promise<void>((resolve) => {
            const request = indexedDB.deleteDatabase('etherpk-protection')
            request.onsuccess = () => resolve()
            request.onerror = () => resolve()
            request.onblocked = () => resolve()
        })
    }

    /** A fresh module, so the memoised connection and the safety copy start clean. */
    async function freshStore() {
        vi.resetModules()
        const { indexedDbWrapStore: store } = await import('./passkey-protection')
        return store
    }

    const wrap: DeviceProtectionWrap = { v: 1, fingerprint: 'fp', credentialId: 'cred', wrapped: 'sealed' }

    afterEach(async () => {
        await deleteProtectionDatabase()
        // @ts-expect-error - the node runner has no localStorage; these tests install one.
        delete globalThis.localStorage
    })

    it('reads the wrap back after the database is deleted, and re-creates its row', async () => {
        globalThis.localStorage = memoryStorage()
        await (await freshStore()).write('g1', wrap)
        await deleteProtectionDatabase()

        const store = await freshStore()
        expect(await store.read('g1')).toEqual(wrap)
        // Back in IndexedDB as well: a store opened later, with the copy gone, still finds it.
        const copyKeys = [...Array(localStorage.length)].map((_, index) => localStorage.key(index)!)
        for (const key of copyKeys) localStorage.removeItem(key)
        expect(await (await freshStore()).read('g1')).toEqual(wrap)
    })

    it('does not bring back a wrap that was cleared before the loss', async () => {
        globalThis.localStorage = memoryStorage()
        const store = await freshStore()
        await store.write('g1', wrap)
        await store.clear('g1')
        await deleteProtectionDatabase()

        expect(await (await freshStore()).read('g1')).toBeNull()
    })

    it('works with no localStorage at all, exactly as before', async () => {
        const store = await freshStore()
        await store.write('g1', wrap)
        expect(await store.read('g1')).toEqual(wrap)
        await store.clear('g1')
        expect(await store.read('g1')).toBeNull()
    })
})
