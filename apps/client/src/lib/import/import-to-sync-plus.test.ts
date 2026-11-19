import { describe, expect, it } from 'vitest'

import {
    PENDING_SYNC_PLUS_IMPORT_MAX_AGE_MS,
    createSyncPlusImportStore,
    importToSyncPlusStep,
    type SyncPlusServer,
} from './import-to-sync-plus'

const MANAGED = 'https://sync.example.test'
const CUSTOM = 'https://notes.example.test'

function server(overrides: Partial<SyncPlusServer> = {}): SyncPlusServer {
    return {
        origin: MANAGED,
        kind: 'managed',
        authState: 'authenticated',
        createBlockedReason: null,
        planPending: false,
        keysHeld: true,
        ...overrides,
    }
}

describe('importToSyncPlusStep', () => {
    it('imports to Managed Sync when its account can take a graph and the keys are here', () => {
        expect(importToSyncPlusStep([server()])).toEqual({ kind: 'import', origin: MANAGED, managed: true, unlock: false })
    })

    it('unlocks first when the keys are locked on this device', () => {
        expect(importToSyncPlusStep([server({ keysHeld: false })])).toEqual({ kind: 'import', origin: MANAGED, managed: true, unlock: true })
    })

    it('prefers Managed Sync over a custom server, and takes a custom one when Managed Sync cannot', () => {
        const custom = server({ origin: CUSTOM, kind: 'custom' })
        expect(importToSyncPlusStep([custom, server()])).toMatchObject({ kind: 'import', origin: MANAGED })
        const freePlan = server({ createBlockedReason: 'Synced graphs need Sync+. Start it from Billing to create one.' })
        expect(importToSyncPlusStep([freePlan, custom])).toEqual({ kind: 'import', origin: CUSTOM, managed: false, unlock: false })
    })

    it('waits while an account check or a plan is still being confirmed', () => {
        expect(importToSyncPlusStep([server({ authState: 'checking' })])).toEqual({ kind: 'wait' })
        expect(importToSyncPlusStep([server({ planPending: true, createBlockedReason: 'still confirming' })])).toEqual({ kind: 'wait' })
    })

    it('offers the way to an account with Sync+ when nothing can take the graph', () => {
        expect(importToSyncPlusStep([])).toEqual({ kind: 'offer' })
        expect(importToSyncPlusStep([server({ authState: 'signed-out', createBlockedReason: 'signed out' })])).toEqual({ kind: 'offer' })
        expect(importToSyncPlusStep([server({ createBlockedReason: 'Synced graphs need Sync+.' })])).toEqual({ kind: 'offer' })
    })
})

/** A localStorage stand-in. */
function memoryStorage() {
    const items = new Map<string, string>()
    return {
        items,
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, value),
        removeItem: (key: string) => void items.delete(key),
    }
}

describe('the pending import', () => {
    it('is kept across a trip to Billing and cleared once dealt with', () => {
        const storage = memoryStorage()
        const store = createSyncPlusImportStore(storage, () => 1000)
        store.setPending({ graphId: 'garden', name: 'Garden' })
        // A new page load reads it back.
        const after = createSyncPlusImportStore(storage, () => 2000)
        expect(after.pending()).toEqual({ graphId: 'garden', name: 'Garden', at: 1000 })
        after.clearPending()
        expect(createSyncPlusImportStore(storage, () => 3000).pending()).toBeNull()
    })

    it('is forgotten once it is more than a day old', () => {
        const storage = memoryStorage()
        createSyncPlusImportStore(storage, () => 0).setPending({ graphId: 'garden', name: 'Garden' })
        expect(createSyncPlusImportStore(storage, () => PENDING_SYNC_PLUS_IMPORT_MAX_AGE_MS).pending()).not.toBeNull()
        expect(createSyncPlusImportStore(storage, () => PENDING_SYNC_PLUS_IMPORT_MAX_AGE_MS + 1).pending()).toBeNull()
        expect(storage.items.size).toBe(0)
    })

    it('reads anything malformed as nothing pending', () => {
        const storage = memoryStorage()
        const store = createSyncPlusImportStore(storage, () => 0)
        for (const raw of ['not json', '[]', '{"graphId":3}', '{"graphId":"g","name":"n"}']) {
            storage.items.set('etherpk:sync-plus-import-pending', raw)
            expect(store.pending()).toBeNull()
        }
    })

    it('survives storage that refuses every call', () => {
        const refusing = {
            getItem: () => {
                throw new Error('denied')
            },
            setItem: () => {
                throw new Error('denied')
            },
            removeItem: () => {
                throw new Error('denied')
            },
        }
        const store = createSyncPlusImportStore(refusing, () => 0)
        expect(() => store.setPending({ graphId: 'g', name: 'n' })).not.toThrow()
        expect(store.pending()).toBeNull()
        expect(() => store.clearPending()).not.toThrow()
        expect(store.copied('g')).toBe(false)
        expect(() => store.recordCopy('g', 's')).not.toThrow()
    })
})

describe('the copies made', () => {
    it('remembers which folder graphs have been imported to a synced graph', () => {
        const storage = memoryStorage()
        const store = createSyncPlusImportStore(storage, () => 0)
        expect(store.copied('garden')).toBe(false)
        store.recordCopy('garden', 'synced-1')
        store.recordCopy('kitchen', 'synced-2')
        const later = createSyncPlusImportStore(storage, () => 0)
        expect(later.copied('garden')).toBe(true)
        expect(later.copied('kitchen')).toBe(true)
        expect(later.copied('shed')).toBe(false)
    })
})
