import { describe, expect, it } from 'vitest'

import {
    type GraphRecord,
    type GraphStoragePort,
    createGraphRegistry,
    newGraphId,
    withCachedToolbarColor,
} from './graph-registry'

/** An in-memory GraphStoragePort for the pure registry tests. */
function memoryPort(): GraphStoragePort {
    const map = new Map<string, GraphRecord>()
    return {
        async getAll() {
            return [...map.values()]
        },
        async put(record) {
            map.set(record.id, record)
        },
        async delete(id) {
            map.delete(id)
        },
    }
}

function record(id: string, createdAt: number): GraphRecord {
    return { id, name: `Graph ${id}`, backend: 'filesystem', createdAt, handle: { fake: id } }
}

const accountA = { serverOrigin: 'https://sync.example.com', principalId: 'principal-a' }
const accountB = { serverOrigin: 'https://sync.example.com', principalId: 'principal-b' }

function serverRecord(id: string, account = accountA): GraphRecord {
    return {
        id,
        name: `Server ${id}`,
        backend: 'server',
        createdAt: 1000,
        handle: { rootDocId: `root-${id}` },
        serverScope: account,
        membershipActive: true,
    }
}

describe('newGraphId', () => {
    it('delegates to the injected generator', () => {
        expect(newGraphId(() => 'abc')).toBe('abc')
    })
})

describe('createGraphRegistry', () => {
    it('round-trips insert / get / remove', async () => {
        const reg = createGraphRegistry(memoryPort())
        await reg.insertGraph(record('a', 1000))
        expect((await reg.getGraph('a'))?.name).toBe('Graph a')
        await reg.removeGraph('a')
        expect(await reg.getGraph('a')).toBeUndefined()
    })

    it('lists graphs sorted by createdAt', async () => {
        const reg = createGraphRegistry(memoryPort())
        await reg.insertGraph(record('c', 3000))
        await reg.insertGraph(record('a', 1000))
        await reg.insertGraph(record('b', 2000))
        expect((await reg.listGraphs()).map((g) => g.id)).toEqual(['a', 'b', 'c'])
    })

    it('insert is idempotent on id (replace, not duplicate)', async () => {
        const reg = createGraphRegistry(memoryPort())
        await reg.insertGraph(record('a', 1000))
        await reg.insertGraph({ ...record('a', 1000), name: 'Renamed' })
        const all = await reg.listGraphs()
        expect(all).toHaveLength(1)
        expect(all[0].name).toBe('Renamed')
    })

    it('shows filesystem graphs globally but Server graphs only for the active account', async () => {
        let active = accountA
        const reg = createGraphRegistry(memoryPort(), { activeServerScope: () => active })
        await reg.insertGraph(record('local', 1))
        await reg.insertGraph(serverRecord('a'))
        active = accountB
        await reg.insertGraph(serverRecord('b', accountB))

        expect((await reg.listGraphs()).map((graph) => graph.id)).toEqual(['local', 'b'])
        expect(await reg.getGraph('a')).toBeUndefined()
        active = accountA
        expect((await reg.listGraphs()).map((graph) => graph.id)).toEqual(['local', 'a'])
    })

    // The index-pool sweep keeps the search index of every graph this DEVICE holds. A signed-out,
    // expired or other account hides synced records from listGraphs; sweeping against that list
    // would re-index every synced graph after each session expiry.
    it('lists every record the device holds, whatever account scope or membership hides it', async () => {
        let active: typeof accountA | null = accountA
        const reg = createGraphRegistry(memoryPort(), { activeServerScope: () => active })
        await reg.insertGraph(record('local', 1))
        await reg.insertGraph(serverRecord('a'))
        await reg.insertGraph(serverRecord('b', accountB))
        await reg.insertGraph({ ...serverRecord('left'), membershipActive: false })
        active = null

        expect((await reg.listGraphs()).map((graph) => graph.id)).toEqual(['local'])
        expect((await reg.listAllGraphIds()).sort()).toEqual(['a', 'b', 'left', 'local'])
    })

    it('requires every new Server graph to carry an account scope', async () => {
        const reg = createGraphRegistry(memoryPort(), { activeServerScope: () => accountA })

        await expect(reg.insertGraph({
            id: 'unscoped',
            name: 'Unscoped',
            backend: 'server',
            createdAt: 1,
            handle: { rootDocId: 'root' },
        })).rejects.toThrow('Server graph records require an authenticated account scope')
    })

    it('adopts legacy records only after the current account confirms membership', async () => {
        const port = memoryPort()
        const reg = createGraphRegistry(port, { activeServerScope: () => accountA })
        await port.put({
            id: 'member',
            name: 'Existing encrypted name',
            backend: 'server',
            createdAt: 1,
            handle: { rootDocId: 'root-member' },
        })
        await port.put({
            id: 'not-a-member',
            name: 'Another account graph',
            backend: 'server',
            createdAt: 2,
            handle: { rootDocId: 'root-other' },
        })

        expect(await reg.listGraphs()).toEqual([])
        await reg.reconcileServerMemberships(accountA, ['member'])

        expect((await reg.listGraphs()).map((graph) => graph.id)).toEqual(['member'])
        expect(await reg.getGraph('member')).toMatchObject({
            serverScope: accountA,
            membershipActive: true,
        })
    })

    it('hides a scoped Server record after a successful membership refresh removes it', async () => {
        const reg = createGraphRegistry(memoryPort(), { activeServerScope: () => accountA })
        await reg.insertGraph(serverRecord('revoked'))

        await reg.reconcileServerMemberships(accountA, [])

        expect(await reg.getGraph('revoked')).toBeUndefined()
    })

    // A record written under one Sync Principal, on a browser that then signed in as another
    // Principal on the SAME server (2026-09-01: a second registration on a phone), was skipped
    // by both reconcile branches and so stayed invisible on every load with no repair path.
    it('re-adopts a record stranded under a previous Sync Principal once the server confirms membership', async () => {
        const port = memoryPort()
        const reg = createGraphRegistry(port, { activeServerScope: () => accountB })
        await port.put(serverRecord('mine', accountA))

        expect(await reg.getGraph('mine')).toBeUndefined()
        await reg.reconcileServerMemberships(accountB, ['mine'])

        expect(await reg.getGraph('mine')).toMatchObject({
            serverScope: accountB,
            membershipActive: true,
            name: 'Server mine', // the cached name survives the re-adoption
        })
    })

    it('leaves a record under another Sync Principal untouched when the server does not list it', async () => {
        const port = memoryPort()
        const reg = createGraphRegistry(port, { activeServerScope: () => accountB })
        await port.put(serverRecord('theirs', accountA))

        await reg.reconcileServerMemberships(accountB, [])

        expect(await reg.getGraph('theirs')).toBeUndefined()
        expect((await port.getAll()).find((record) => record.id === 'theirs')).toMatchObject({
            serverScope: accountA,
            membershipActive: true,
        })
    })

    it('never re-adopts across a different server origin, even for a matching graph id', async () => {
        const otherServer = { serverOrigin: 'https://other.example.com', principalId: 'principal-b' }
        const port = memoryPort()
        const reg = createGraphRegistry(port, { activeServerScope: () => otherServer })
        await port.put(serverRecord('same-id', accountA))

        await reg.reconcileServerMemberships(otherServer, ['same-id'])

        expect(await reg.getGraph('same-id')).toBeUndefined()
    })
})

describe('withCachedToolbarColor', () => {
    const base = (): GraphRecord => ({ id: 'g', name: 'G', backend: 'filesystem', createdAt: 1, handle: {} })

    it('returns a record carrying the colour when the cache is behind', () => {
        const next = withCachedToolbarColor(base(), '#7dd3fc')
        expect(next).toEqual({ ...base(), toolbarColor: '#7dd3fc' })
    })

    it('returns null when the cache already says the same thing', () => {
        expect(withCachedToolbarColor({ ...base(), toolbarColor: '#7dd3fc' }, '#7dd3fc')).toBeNull()
        expect(withCachedToolbarColor(base(), undefined)).toBeNull()
    })

    it('drops the key rather than writing undefined when the colour was cleared', () => {
        const next = withCachedToolbarColor({ ...base(), toolbarColor: '#7dd3fc' }, undefined)
        expect(next).toEqual(base())
        expect(next && 'toolbarColor' in next).toBe(false)
    })

    it('never mutates the record it was given', () => {
        const record = base()
        withCachedToolbarColor(record, '#7dd3fc')
        expect(record).toEqual(base())
    })
})
