import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
    graphAddressOf,
    currentGraphId,
    graphAddressPath,
    graphsSharingAnAddress,
    legacyGraphAddress,
    parseGraphAddressPath,
    resolveGraphAddress,
    sameGraphAddress,
    type AddressedGraph,
} from './graph-address'

const folder = (id: string, name: string): AddressedGraph => ({ id, backend: 'filesystem', handle: { kind: 'directory', name } })
const browser = (id: string): AddressedGraph => ({ id, backend: 'filesystem', where: 'browser', handle: { kind: 'directory', name: `graph-${id}` } })
const synced = (id: string): AddressedGraph => ({ id, backend: 'server', handle: { rootDocId: 'r' } })

describe('graphAddressPath', () => {
    it('writes where the graph is kept, then its name', () => {
        expect(graphAddressPath({ where: 'folder', name: 'reports' })).toBe('/graph/folder/reports')
        expect(graphAddressPath({ where: 'sync', name: '9d5cabe1-b05e-4dca-a12f-4b63a775b5b0' })).toBe('/graph/sync/9d5cabe1-b05e-4dca-a12f-4b63a775b5b0')
        expect(graphAddressPath({ where: 'browser', name: 'demo' })).toBe('/graph/browser/demo')
    })

    it('encodes a folder name', () => {
        expect(graphAddressPath({ where: 'folder', name: 'Garden Notes #2' })).toBe('/graph/folder/Garden%20Notes%20%232')
    })
})

describe('parseGraphAddressPath', () => {
    it('reads the address and what follows it', () => {
        expect(parseGraphAddressPath('/graph/folder/Garden%20Notes/d/Kitchen/Sink')).toEqual({
            address: { where: 'folder', name: 'Garden Notes' },
            rest: '/d/Kitchen/Sink',
        })
        expect(parseGraphAddressPath('/graph/sync/abc')).toEqual({ address: { where: 'sync', name: 'abc' }, rest: '' })
    })

    it('reads nothing from another path, an unknown place or a malformed escape', () => {
        expect(parseGraphAddressPath('/graphs')).toBeNull()
        expect(parseGraphAddressPath('/graph/cloud/abc')).toBeNull()
        expect(parseGraphAddressPath('/graph/folder/')).toBeNull()
        expect(parseGraphAddressPath('/graph/folder/%E0%A4%A')).toBeNull()
        expect(parseGraphAddressPath('/g/abc/d/Kitchen')).toBeNull()
    })
})

describe('graphAddressOf', () => {
    it('names a folder graph by its folder, a synced graph and a browser graph by id', () => {
        expect(graphAddressOf(folder('f1', 'reports'))).toEqual({ where: 'folder', name: 'reports' })
        expect(graphAddressOf(synced('s1'))).toEqual({ where: 'sync', name: 's1' })
        expect(graphAddressOf(browser('b1'))).toEqual({ where: 'browser', name: 'b1' })
    })

    it('never uses the Graph Name', () => {
        expect(graphAddressOf({ ...folder('f1', 'reports'), name: 'Change Reports' } as AddressedGraph)).toEqual({ where: 'folder', name: 'reports' })
    })
})

describe('resolveGraphAddress', () => {
    const graphs = [folder('f1', 'reports'), folder('f2', 'notes'), folder('f3', 'notes'), synced('s1'), browser('b1')]

    it('finds the one graph an address names', () => {
        expect(resolveGraphAddress({ where: 'folder', name: 'reports' }, graphs)).toEqual({ kind: 'held', graph: graphs[0] })
        expect(resolveGraphAddress({ where: 'sync', name: 's1' }, graphs)).toEqual({ kind: 'held', graph: graphs[3] })
        expect(resolveGraphAddress({ where: 'browser', name: 'b1' }, graphs)).toEqual({ kind: 'held', graph: graphs[4] })
    })

    it('offers a choice between two folders with one name', () => {
        expect(resolveGraphAddress({ where: 'folder', name: 'notes' }, graphs)).toEqual({ kind: 'choice', graphs: [graphs[1], graphs[2]] })
    })

    it('says a graph is not held, and never crosses kinds', () => {
        expect(resolveGraphAddress({ where: 'folder', name: 'garden' }, graphs)).toEqual({ kind: 'not-held' })
        // A browser graph's id that matches a folder's name is not that folder.
        expect(resolveGraphAddress({ where: 'folder', name: 'b1' }, graphs)).toEqual({ kind: 'not-held' })
        expect(resolveGraphAddress({ where: 'browser', name: 'reports' }, graphs)).toEqual({ kind: 'not-held' })
        expect(resolveGraphAddress({ where: 'sync', name: 'f1' }, graphs)).toEqual({ kind: 'not-held' })
    })

    it('matches a folder name exactly, case included', () => {
        expect(resolveGraphAddress({ where: 'folder', name: 'Reports' }, graphs)).toEqual({ kind: 'not-held' })
    })
})

describe('sameGraphAddress', () => {
    it('compares both parts', () => {
        expect(sameGraphAddress({ where: 'folder', name: 'a' }, { where: 'folder', name: 'a' })).toBe(true)
        expect(sameGraphAddress({ where: 'folder', name: 'a' }, { where: 'browser', name: 'a' })).toBe(false)
        expect(sameGraphAddress({ where: 'folder', name: 'a' }, { where: 'folder', name: 'b' })).toBe(false)
    })
})

describe('legacyGraphAddress', () => {
    const graphs = [folder('f1', 'reports'), synced('s1'), browser('b1')]

    it('sends an old /g/<id> address on to the address of the graph it named', () => {
        expect(legacyGraphAddress('/g/f1/d/Garden%20Notes', '', graphs)).toBe('/graph/folder/reports/d/Garden%20Notes')
        expect(legacyGraphAddress('/g/s1', '?settings=agents', graphs)).toBe('/graph/sync/s1?settings=agents')
        expect(legacyGraphAddress('/g/b1/k/Board', '', graphs)).toBe('/graph/browser/b1/k/Board')
    })

    it('takes an id nothing here holds to be a synced graph, the only kind another device can share', () => {
        expect(legacyGraphAddress('/g/unknown/d/Page', '', graphs)).toBe('/graph/sync/unknown/d/Page')
    })

    it('reads the development flag that said a graph is kept in the browser, and drops it', () => {
        expect(legacyGraphAddress('/g/dev1/d/Page', '?fs=opfs&autosaveMs=150', graphs)).toBe('/graph/browser/dev1/d/Page?autosaveMs=150')
        expect(legacyGraphAddress('/g/dev1', '?fs=opfs', graphs)).toBe('/graph/browser/dev1')
    })

    it('answers null for a path that is no old address', () => {
        expect(legacyGraphAddress('/graphs', '', graphs)).toBeNull()
        expect(legacyGraphAddress('/g/', '', graphs)).toBeNull()
    })
})

describe('an address round trip', () => {
    const where = fc.constantFrom('folder' as const, 'sync' as const, 'browser' as const)
    // A folder's name is any text without a slash; an id is the same to the address.
    const name = fc.string({ minLength: 1, unit: 'grapheme' }).filter((text) => !text.includes('/') && text !== '.' && text !== '..')

    it('parses back to the address that was written, with the rest of the path intact', () => {
        fc.assert(
            fc.property(where, name, fc.constantFrom('', '/d/Garden/Beds', '/a/abc', '/kanban'), (where, name, rest) => {
                const parsed = parseGraphAddressPath(graphAddressPath({ where, name }) + rest)
                expect(parsed).toEqual({ address: { where, name }, rest })
            }),
        )
    })

    it('survives the browser: a URL built from the path gives the same address back', () => {
        fc.assert(
            fc.property(where, name, (where, name) => {
                const url = new URL(graphAddressPath({ where, name }) + '/d/Page', 'https://app.example.test')
                expect(parseGraphAddressPath(url.pathname)?.address).toEqual({ where, name })
            }),
        )
    })

    it('resolves the address of a registered graph back to that graph, whatever else is registered', () => {
        const graph = fc.oneof(
            fc.tuple(fc.uuid(), name).map(([id, folderName]) => folder(id, folderName)),
            fc.uuid().map(synced),
            fc.uuid().map(browser),
        )
        fc.assert(
            fc.property(fc.uniqueArray(graph, { selector: (g) => g.id, minLength: 1 }), (graphs) => {
                for (const one of graphs) {
                    const found = resolveGraphAddress(graphAddressOf(one), graphs)
                    if (found.kind === 'held') expect(found.graph).toBe(one)
                    else {
                        // Only two folders with one name are a choice, and the graph is among them.
                        expect(found.kind).toBe('choice')
                        expect(found.kind === 'choice' && found.graphs.includes(one)).toBe(true)
                        expect(one.backend === 'filesystem' && one.where !== 'browser').toBe(true)
                    }
                }
            }),
        )
    })
})

describe('graphsSharingAnAddress', () => {
    it('names the folder graphs whose folders share a name, and no other graph', () => {
        const graphs = [folder('f1', 'reports'), folder('f2', 'notes'), folder('f3', 'notes'), synced('s1'), browser('b1'), browser('b2')]
        expect(graphsSharingAnAddress(graphs)).toEqual(new Set(['f2', 'f3']))
    })

    it('names none where every address is one graph\'s', () => {
        expect(graphsSharingAnAddress([folder('f1', 'reports'), folder('f2', 'Reports'), synced('s1')])).toEqual(new Set())
    })
})

describe('currentGraphId', () => {
    const graphs = [folder('f1', 'reports'), folder('f2', 'notes'), folder('f3', 'notes'), synced('s1')]
    const notes = { where: 'folder', name: 'notes' } as const

    it('is the graph the workspace has open, whatever shares its address', () => {
        expect(currentGraphId(notes, 'f3', graphs)).toBe('f3')
        expect(currentGraphId(notes, 'f2', graphs)).toBe('f2')
    })

    it('is the one graph the address names while no graph is open yet', () => {
        expect(currentGraphId({ where: 'folder', name: 'reports' }, null, graphs)).toBe('f1')
        expect(currentGraphId({ where: 'sync', name: 's1' }, null, graphs)).toBe('s1')
    })

    it('is no graph while two share the address and none is open: the person has not said which', () => {
        expect(currentGraphId(notes, null, graphs)).toBeNull()
    })

    it('is no graph off a workspace address, or at an address nothing here holds', () => {
        expect(currentGraphId(null, null, graphs)).toBeNull()
        expect(currentGraphId({ where: 'folder', name: 'garden' }, null, graphs)).toBeNull()
    })
})
