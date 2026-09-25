import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ProtectionRecord } from '$lib/crypto'
import type { DirectoryAdapter } from '$lib/storage/fs/directory-adapter'
import { createMemoryDirectoryAdapter } from '$lib/storage/fs/memory-adapter'

import { PROTECTION_FILE, filesystemProtectionStore, inMemoryProtectionStore, localProtectionStore, vaultProtectionStore } from './protection-store'

const RECORD: ProtectionRecord = {
    v: 1,
    fingerprint: 'ZmluZ2VycHJpbnQ',
    // A real-shaped salt: parsing bounds the KDF parameters, and a four-byte salt is refused.
    kdf: { m: 19456, t: 2, p: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA' },
    wrapped: 'd3JhcHBlZA',
}

/** What a build after this one might write: the same record under a version we do not know. */
const NEWER = { ...RECORD, v: 2 } as unknown as ProtectionRecord

// A store answers `missing` only when it is sure nothing is there, `invalid` when something is
// there that this build cannot use, and rejects when it could not look. The service takes only
// `missing` as leave to mint a fresh key, so nothing that writes a record proceeds on anything
// else.

describe('the Filesystem Backend store', () => {
    it('reads back what it wrote', async () => {
        const store = filesystemProtectionStore(createMemoryDirectoryAdapter({ now: () => 1 }))

        await store.write(RECORD)

        expect(await store.read()).toEqual({ kind: 'ok', record: RECORD })
    })

    it('reads missing for a graph that has never been protected', async () => {
        expect(await filesystemProtectionStore(createMemoryDirectoryAdapter({ now: () => 1 })).read()).toEqual({ kind: 'missing' })
    })

    it('reads a hand-mangled file as invalid, naming the file, never as absent', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: () => 1 })
        // What a git conflict leaves behind; git-managed graph folders are a supported workflow.
        await adapter.write('etherpk', PROTECTION_FILE, '<<<<<<< HEAD\n{"v":1}\n=======\nnot json\n>>>>>>> theirs\n')

        expect(await filesystemProtectionStore(adapter).read()).toMatchObject({
            kind: 'invalid',
            location: 'etherpk/protection.json',
            problem: 'damaged',
        })
    })

    it('reads a record from a newer build as invalid, and says which kind', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: () => 1 })
        await adapter.write('etherpk', PROTECTION_FILE, JSON.stringify(NEWER))

        expect(await filesystemProtectionStore(adapter).read()).toMatchObject({ kind: 'invalid', problem: 'newer-version' })
    })

    // EtherPK never writes an empty record file - the web adapter swaps a complete file in on
    // close - so an empty one is what a full disk or a copy cut short leaves. Reading it as
    // absent would replace it.
    it('reads an empty file as invalid rather than absent', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: () => 1 })
        await adapter.write('etherpk', PROTECTION_FILE, '')

        expect(await filesystemProtectionStore(adapter).read()).toMatchObject({ kind: 'invalid', problem: 'damaged' })
    })

    it('rejects when the folder cannot be looked in, rather than answering absent', async () => {
        // A revoked folder permission: the web adapter's probe rethrows anything but
        // NotFoundError, and the store must let that through as "could not read".
        const adapter = createMemoryDirectoryAdapter({ now: () => 1 })
        const denied: DirectoryAdapter = {
            ...adapter,
            exists: async () => {
                throw new DOMException('permission revoked', 'NotAllowedError')
            },
        }

        await expect(filesystemProtectionStore(denied).read()).rejects.toThrow('permission revoked')
    })

    it('rejects when the file is there but cannot be read right now', async () => {
        // OPFS raises NotReadableError for a file another handle is mid-way through writing.
        const adapter = createMemoryDirectoryAdapter({ now: () => 1 })
        await adapter.write('etherpk', PROTECTION_FILE, JSON.stringify(RECORD))
        const busy: DirectoryAdapter = {
            ...adapter,
            read: async () => {
                throw new DOMException('being written', 'NotReadableError')
            },
        }

        await expect(filesystemProtectionStore(busy).read()).rejects.toThrow('being written')
    })

    // Graph Settings are SHARED graph content (ADR 0036); the Protection Key is personal
    // (ADR 0057). Keeping the record in its own file stops a future settings sync carrying it.
    it('stores the record in its own file, not in shared graph settings', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: () => 1 })

        await filesystemProtectionStore(adapter).write(RECORD)

        expect(await adapter.exists('etherpk', PROTECTION_FILE)).toBe(true)
        expect(await adapter.exists('etherpk', 'settings.json')).toBe(false)
    })

    it('clears the record when protection is turned off for the graph', async () => {
        const store = filesystemProtectionStore(createMemoryDirectoryAdapter({ now: () => 1 }))
        await store.write(RECORD)

        await store.clear()

        expect(await store.read()).toEqual({ kind: 'missing' })
    })
})

describe('the Server Backend store', () => {
    function fakeVault(initial?: Record<string, ProtectionRecord>) {
        let protection = initial
        return {
            store: vaultProtectionStore('graph-1', {
                readProtection: async () => protection,
                writeProtection: async (next) => {
                    protection = next
                },
            }),
            peek: () => protection,
        }
    }

    it('reads back what it wrote, scoped to its own graph', async () => {
        const { store, peek } = fakeVault()

        await store.write(RECORD)

        expect(await store.read()).toEqual({ kind: 'ok', record: RECORD })
        expect(peek()).toEqual({ 'graph-1': RECORD })
    })

    it('leaves another graph’s record alone when writing, even one it could not read itself', async () => {
        // Another graph's entry may come from a newer build on another device. It is carried
        // verbatim: this store's job is its own graph's entry, and dropping or rewriting a
        // neighbour would lose that graph's key.
        const { store, peek } = fakeVault({ 'graph-2': NEWER })

        await store.write({ ...RECORD, fingerprint: 'b3RoZXI' })

        expect(peek()?.['graph-2']).toEqual(NEWER)
        expect(peek()?.['graph-1'].fingerprint).toBe('b3RoZXI')
    })

    it('clears only its own graph', async () => {
        const { store, peek } = fakeVault({ 'graph-1': RECORD, 'graph-2': RECORD })

        await store.clear()

        expect(peek()?.['graph-1']).toBeUndefined()
        expect(peek()?.['graph-2']).toEqual(RECORD)
    })

    it('reads missing when the vault has no protection map at all', async () => {
        expect(await fakeVault().store.read()).toEqual({ kind: 'missing' })
    })

    it('reads missing when the vault holds other graphs but not this one', async () => {
        expect(await fakeVault({ 'graph-2': RECORD }).store.read()).toEqual({ kind: 'missing' })
    })

    // The vault is shared by every device on the account, so a newer build on one device is
    // exactly how a record this build does not understand arrives here. Handing it on as if it
    // were ours would put its parameters straight into Argon2id.
    it('reads an entry written by a newer build as invalid, not as a record', async () => {
        expect(await fakeVault({ 'graph-1': NEWER }).store.read()).toMatchObject({ kind: 'invalid', problem: 'newer-version' })
    })

    it('lets a failed vault read through as a rejection: a locked vault is not an empty one', async () => {
        const store = vaultProtectionStore('graph-1', {
            readProtection: async () => {
                throw new Error('vault is locked')
            },
            writeProtection: async () => {},
        })

        await expect(store.read()).rejects.toThrow('vault is locked')
    })
})

describe('the in-memory store', () => {
    it('round-trips, so tests and the memory adapter need no filesystem', async () => {
        const store = inMemoryProtectionStore()

        await store.write(RECORD)

        expect(await store.read()).toEqual({ kind: 'ok', record: RECORD })
        await store.clear()
        expect(await store.read()).toEqual({ kind: 'missing' })
    })
})

// A Server Backend reached with no account has no vault to hold the record. Keeping it on the
// device is what a graph folder does with protection.json; the alternative - an in-memory store -
// lost the passphrase on every reload.
describe('the device-local record store', () => {
    const backing = new Map<string, string>()
    let failReads: Error | null = null
    const shim = {
        getItem: (k: string) => {
            if (failReads) throw failReads
            return backing.get(k) ?? null
        },
        setItem: (k: string, v: string) => void backing.set(k, v),
        removeItem: (k: string) => void backing.delete(k),
    }
    const original = (globalThis as { localStorage?: unknown }).localStorage
    beforeEach(() => {
        backing.clear()
        failReads = null
        Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true, writable: true })
    })
    afterEach(() => {
        Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true, writable: true })
    })

    it('reads back what it wrote, keyed by graph', async () => {
        const record = { ...RECORD }
        const store = localProtectionStore('graph-a')
        await store.write(record)
        expect(await store.read()).toEqual({ kind: 'ok', record })
        expect(await localProtectionStore('graph-b').read()).toEqual({ kind: 'missing' })
    })

    it('reads missing when nothing was written, and after clear', async () => {
        const store = localProtectionStore('graph-a')
        expect(await store.read()).toEqual({ kind: 'missing' })
        await store.write(RECORD)
        await store.clear()
        expect(await store.read()).toEqual({ kind: 'missing' })
    })

    it('reads a mangled entry as invalid, naming the entry, never as absent', async () => {
        backing.set('etherpk:protection:graph-a', '{not json')
        expect(await localProtectionStore('graph-a').read()).toMatchObject({
            kind: 'invalid',
            location: expect.stringContaining('etherpk:protection:graph-a'),
            problem: 'damaged',
        })
    })

    it('rejects when storage cannot be read, rather than answering absent', async () => {
        // localStorage disabled by policy throws on access; that is "could not look", not "empty".
        failReads = new DOMException('storage disabled', 'SecurityError')
        await expect(localProtectionStore('graph-a').read()).rejects.toThrow('storage disabled')
    })
})
