import { describe, expect, it, vi } from 'vitest'

import type { GraphRecord, GraphStoragePort } from './graph-registry'
import { recoverableGraphRecord, withRegistrySafetyCopy } from './graph-registry-safety'
import { createSafetyCopy, type SafetyCopy } from './safety-copy'

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

/** A primary port over a Map, standing in for IndexedDB, with a way to lose everything. */
function memoryPort(): GraphStoragePort & { rows: Map<string, GraphRecord>; wipe(): void } {
    const rows = new Map<string, GraphRecord>()
    return {
        rows,
        wipe: () => rows.clear(),
        getAll: async () => [...rows.values()],
        put: async (record) => void rows.set(record.id, record),
        delete: async (id) => void rows.delete(id),
    }
}

const scope = { serverOrigin: 'https://sync.example.com', principalId: 'p1' }

function synced(id: string, name = id): GraphRecord {
    return { id, name, backend: 'server', createdAt: 1, handle: { rootDocId: `root-${id}` }, serverScope: scope, membershipActive: true }
}

function local(id: string): GraphRecord {
    return { id, name: id, backend: 'filesystem', createdAt: 1, handle: { kind: 'directory' } }
}

function setup() {
    const primary = memoryPort()
    const copy: SafetyCopy<GraphRecord> = createSafetyCopy('graphs', recoverableGraphRecord, memoryStorage())
    const report = vi.fn()
    const port = withRegistrySafetyCopy(primary, copy, report)
    return { primary, copy, report, port }
}

describe('recoverableGraphRecord', () => {
    it('accepts a Server record and strips it to its plain fields', () => {
        const record = recoverableGraphRecord({ ...synced('g'), extra: 'ignored' })
        expect(record).toEqual(synced('g'))
    })

    it('rejects a filesystem record, whose folder handle cannot live in localStorage', () => {
        expect(recoverableGraphRecord(local('f'))).toBeNull()
    })

    it('rejects anything missing the fields a Server record needs to open', () => {
        expect(recoverableGraphRecord({ ...synced('g'), handle: {} })).toBeNull()
        expect(recoverableGraphRecord({ ...synced('g'), serverScope: { serverOrigin: 1 } })).toBeNull()
        expect(recoverableGraphRecord({ ...synced('g'), createdAt: 'yesterday' })).toBeNull()
        expect(recoverableGraphRecord(null)).toBeNull()
    })

    it('keeps an absent scope and membership absent rather than inventing values', () => {
        const { serverScope: _scope, membershipActive: _active, ...bare } = synced('g')
        expect(recoverableGraphRecord(bare)).toEqual(bare)
    })
})

describe('a registry port with a safety copy', () => {
    it('writes every Server record to the copy as it is stored', async () => {
        const { port, copy } = setup()
        await port.put(synced('g'))
        expect(copy.read('g')).toEqual(synced('g'))
    })

    it('does not copy a filesystem record, and drops a stale copy if a record changes backend', async () => {
        const { port, copy } = setup()
        await port.put(local('f'))
        expect(copy.read('f')).toBeNull()
    })

    it('restores Server records the primary has lost, and puts them back into the primary', async () => {
        const { port, primary, report } = setup()
        await port.put(synced('g1', 'Work'))
        await port.put(synced('g2', 'Home'))
        primary.wipe()

        const rows = await port.getAll()

        expect(rows.map((row) => row.id).sort()).toEqual(['g1', 'g2'])
        expect([...primary.rows.keys()].sort()).toEqual(['g1', 'g2'])
        expect(report).toHaveBeenCalledWith([synced('g1', 'Work'), synced('g2', 'Home')])
    })

    it('reports nothing when the primary holds everything', async () => {
        const { port, report } = setup()
        await port.put(synced('g1'))
        await port.getAll()
        expect(report).not.toHaveBeenCalled()
    })

    it('prefers the primary when both hold a record, and refreshes the copy from it', async () => {
        const { port, primary, copy } = setup()
        await port.put(synced('g1', 'Old name'))
        primary.rows.set('g1', synced('g1', 'Renamed elsewhere'))

        const rows = await port.getAll()

        expect(rows[0]?.name).toBe('Renamed elsewhere')
        expect(copy.read('g1')?.name).toBe('Renamed elsewhere')
    })

    it('backfills the copy for records that predate it', async () => {
        const { port, primary, copy } = setup()
        primary.rows.set('legacy', synced('legacy'))

        await port.getAll()

        expect(copy.read('legacy')).toEqual(synced('legacy'))
    })

    it('does not resurrect a graph the user forgot', async () => {
        const { port, primary, copy } = setup()
        await port.put(synced('g1'))
        await port.delete('g1')

        expect(copy.read('g1')).toBeNull()
        expect(await port.getAll()).toEqual([])
        expect(primary.rows.size).toBe(0)
    })

    it('removes the copy before the primary, so a failed delete cannot leave a copy that outlives the row', async () => {
        const { port, primary, copy } = setup()
        await port.put(synced('g1'))
        primary.delete = async () => {
            throw new Error('closing')
        }

        await expect(port.delete('g1')).rejects.toThrow('closing')
        expect(copy.read('g1')).toBeNull()
    })

    it('still lists a restored record when writing it back to the primary fails', async () => {
        const { port, primary } = setup()
        await port.put(synced('g1'))
        primary.wipe()
        primary.put = async () => {
            throw new Error('read only')
        }

        expect((await port.getAll()).map((row) => row.id)).toEqual(['g1'])
    })

    it('leaves filesystem records exactly as the primary returns them', async () => {
        const { port, primary } = setup()
        const handle = { kind: 'directory' }
        primary.rows.set('f', { ...local('f'), handle })

        const [row] = await port.getAll()

        expect(row?.handle).toBe(handle)
    })
})

describe('recoverableGraphRecord and the cached toolbar colour', () => {
    it('carries a cached toolbar colour, so the Graphs menu is right after a restore', () => {
        expect(recoverableGraphRecord({ ...synced('g'), toolbarColor: '#7dd3fc' })).toEqual({ ...synced('g'), toolbarColor: '#7dd3fc' })
    })

    it('drops a colour that is not a canonical hex rather than rejecting the record', () => {
        expect(recoverableGraphRecord({ ...synced('g'), toolbarColor: 'blue' })).toEqual(synced('g'))
        expect(recoverableGraphRecord({ ...synced('g'), toolbarColor: 7 })).toEqual(synced('g'))
    })
})
