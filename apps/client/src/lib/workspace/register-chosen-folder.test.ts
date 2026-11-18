import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { GraphRecord } from '#lib/storage/graph-registry.js'
import type { FolderOwner } from '#lib/storage/synced/mirror-takeover.js'

import { registerChosenFolder, type FolderRegistration } from './register-chosen-folder'

/** A folder as the test knows it: its name, and which folder on disk it is. */
interface Folder {
    name: string
    disk: string
}

/** A registry in memory, and everything a registration needs over it. Each await yields, as IndexedDB does. */
function world(options: { lock: 'one-at-a-time' | 'none'; mirrors?: string[] } = { lock: 'one-at-a-time' }) {
    const graphs: GraphRecord[] = []
    const prepared: string[] = []
    const welcomed: string[] = []
    let ids = 0
    let queue: Promise<unknown> = Promise.resolve()
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
    const deps = (folder: Folder): FolderRegistration<Folder> => ({
        handle: folder,
        name: folder.name,
        registry: {
            async getGraph(id) {
                await tick()
                return graphs.find((graph) => graph.id === id)
            },
            async insertGraph(record) {
                await tick()
                graphs.push(record)
            },
        },
        async findOwner(handle): Promise<FolderOwner | null> {
            // Read now, answered a moment later: another registration can land in between.
            const seen = [...graphs]
            await tick()
            if (options.mirrors?.includes(handle.disk)) return { kind: 'mirror', graphId: 'synced', name: 'Team Archive', relation: 'same' }
            const same = seen.find((graph) => (graph.handle as Folder).disk === handle.disk)
            return same ? { kind: 'folder-graph', graphId: same.id, name: same.name, relation: 'same' } : null
        },
        async beforeInsert(handle) {
            await tick()
            prepared.push(handle.disk)
        },
        async afterInsert(graph) {
            welcomed.push(graph.id)
        },
        refusal: (name, owner) => `${name} is the mirror of ${owner.name}`,
        oneAtATime: (run) => {
            if (options.lock === 'none') return run()
            const next = queue.then(run, run)
            queue = next.catch(() => {})
            return next
        },
        newId: () => `g${++ids}`,
        now: () => 1,
    })
    return { graphs, prepared, welcomed, deps }
}

describe('registerChosenFolder', () => {
    it('registers a folder as a Folder Graph named after it, and prepares it first', async () => {
        const w = world()
        const outcome = await registerChosenFolder(w.deps({ name: 'reports', disk: '/home/me/reports' }))
        expect(outcome).toEqual({ kind: 'graph', graph: w.graphs[0] })
        expect(w.graphs[0]).toMatchObject({ id: 'g1', name: 'reports', backend: 'filesystem', where: 'folder' })
        expect(w.prepared).toEqual(['/home/me/reports'])
        expect(w.welcomed).toEqual(['g1'])
    })

    it('opens the graph a folder already is, and registers nothing', async () => {
        const w = world()
        const folder = { name: 'reports', disk: '/home/me/reports' }
        const first = await registerChosenFolder(w.deps(folder))
        const again = await registerChosenFolder(w.deps(folder))
        expect(again).toEqual(first)
        expect(w.graphs).toHaveLength(1)
        expect(w.welcomed).toEqual(['g1'])
    })

    it("refuses a synced graph's mirror before anything is written into it", async () => {
        const w = world({ lock: 'one-at-a-time', mirrors: ['/home/me/backup'] })
        const outcome = await registerChosenFolder(w.deps({ name: 'backup', disk: '/home/me/backup' }))
        expect(outcome).toEqual({ kind: 'refused', message: 'backup is the mirror of Team Archive' })
        expect(w.graphs).toEqual([])
        expect(w.prepared).toEqual([])
    })

    it('two tabs choosing one folder at the same moment make one graph, and both open it', async () => {
        const w = world()
        const folder = { name: 'reports', disk: '/home/me/reports' }
        const [one, two] = await Promise.all([registerChosenFolder(w.deps(folder)), registerChosenFolder(w.deps(folder))])
        expect(w.graphs).toHaveLength(1)
        expect(one).toEqual({ kind: 'graph', graph: w.graphs[0] })
        expect(two).toEqual(one)
    })

    // What the lock is for: the check and the write are two steps, and the registry is asked in
    // between. Without it the same two presses make two graphs for one folder, which a
    // `/graph/folder/reports` link then asks "which one" about for ever.
    it('makes two graphs for one folder when registrations are not taken one at a time', async () => {
        const w = world({ lock: 'none' })
        const folder = { name: 'reports', disk: '/home/me/reports' }
        await Promise.all([registerChosenFolder(w.deps(folder)), registerChosenFolder(w.deps(folder))])
        expect(w.graphs).toHaveLength(2)
    })

    it('a failed registration does not hold up the next one', async () => {
        const w = world()
        const broken = w.deps({ name: 'reports', disk: '/home/me/reports' })
        await expect(registerChosenFolder({ ...broken, beforeInsert: () => Promise.reject(new Error('The folder is read-only')) })).rejects.toThrow('read-only')
        expect(w.graphs).toEqual([])
        const outcome = await registerChosenFolder(w.deps({ name: 'reports', disk: '/home/me/reports' }))
        expect(outcome.kind).toBe('graph')
        expect(w.graphs).toHaveLength(1)
    })

    it('any number of presses, on any folders, in any order: one graph for each folder', async () => {
        const folder = fc.record({ name: fc.constantFrom('reports', 'notes'), disk: fc.constantFrom('/a/reports', '/b/reports', '/a/notes') })
        await fc.assert(
            fc.asyncProperty(fc.array(folder, { minLength: 1, maxLength: 8 }), async (presses) => {
                const w = world()
                const outcomes = await Promise.all(presses.map((press) => registerChosenFolder(w.deps(press))))
                const disks = w.graphs.map((graph) => (graph.handle as Folder).disk)
                expect(new Set(disks).size, 'no folder is two graphs').toBe(disks.length)
                expect(new Set(disks)).toEqual(new Set(presses.map((press) => press.disk)))
                // Every press opens the one graph of the folder it chose.
                outcomes.forEach((outcome, i) => {
                    expect(outcome.kind).toBe('graph')
                    if (outcome.kind === 'graph') expect((outcome.graph.handle as Folder).disk).toBe(presses[i].disk)
                })
            }),
            { numRuns: 200, seed: 20261118 },
        )
    })
})
