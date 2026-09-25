import { describe, expect, it } from 'vitest'

import { type GraphRecord, type GraphStoragePort, createGraphRegistry } from './graph-registry'
import { PLACEHOLDER_SYNCED_GRAPH_NAME, registerSyncedGraphOnDevice } from './register-synced-graph'

function memoryPort(): GraphStoragePort & { rows: Map<string, GraphRecord> } {
    const rows = new Map<string, GraphRecord>()
    return {
        rows,
        async getAll() {
            return [...rows.values()]
        },
        async put(record) {
            rows.set(record.id, record)
        },
        async delete(id) {
            rows.delete(id)
        },
    }
}

const scope = { serverOrigin: 'https://sync.example.com', principalId: 'principal-b' }

describe('registerSyncedGraphOnDevice', () => {
    it('writes a visible Server record stamped with the current account scope', async () => {
        const port = memoryPort()
        const registry = createGraphRegistry(port, { activeServerScope: () => scope })

        const record = await registerSyncedGraphOnDevice(
            { id: 'g1', rootDocId: 'root-g1' },
            { registry, scope, now: () => 4242 },
        )

        expect(record).toEqual({
            id: 'g1',
            name: PLACEHOLDER_SYNCED_GRAPH_NAME,
            backend: 'server',
            createdAt: 4242,
            handle: { rootDocId: 'root-g1' },
            serverScope: scope,
            membershipActive: true,
        })
        expect(await registry.getGraph('g1')).toEqual(record)
    })

    it('keeps a name the caller managed to read from the encrypted meta map', async () => {
        const registry = createGraphRegistry(memoryPort(), { activeServerScope: () => scope })

        const record = await registerSyncedGraphOnDevice(
            { id: 'g1', rootDocId: 'root-g1', name: 'Reading notes' },
            { registry, scope },
        )

        expect(record.name).toBe('Reading notes')
    })

    it('replaces a record stranded under another account, which is what makes it the repair', async () => {
        const port = memoryPort()
        port.rows.set('g1', {
            id: 'g1',
            name: 'Old cached name',
            backend: 'server',
            createdAt: 1,
            handle: { rootDocId: 'root-g1' },
            serverScope: { ...scope, principalId: 'principal-a' },
            membershipActive: true,
        })
        const registry = createGraphRegistry(port, { activeServerScope: () => scope })
        expect(await registry.getGraph('g1')).toBeUndefined()

        await registerSyncedGraphOnDevice({ id: 'g1', rootDocId: 'root-g1' }, { registry, scope })

        expect(await registry.getGraph('g1')).toMatchObject({ serverScope: scope, membershipActive: true })
        expect(port.rows.size).toBe(1)
    })
})
