import { describe, expect, it } from 'vitest'

import type { ExtensionManifest } from '@appsoftwareltd/etherpk-extension-api'

import { type AddressedExtension, createAddressBook } from './addresses'

function extension(manifest: Partial<ExtensionManifest> & Pick<ExtensionManifest, 'id'>): AddressedExtension {
    return { id: manifest.id, package: { manifest: { displayName: manifest.id, publisher: 'App Software', main: './src/extension.ts', ...manifest } } }
}

const book = createAddressBook([
    extension({
        id: 'kanban',
        views: [{ kind: 'kanban.board', title: 'Kanban: {target}', region: 'main', address: { segment: 'k', target: 'concept' } }],
    }),
    extension({
        id: 'graph-view',
        views: [
            { kind: 'graph-view.local', target: 'local', title: 'Graph View', region: 'right-sidebar', resident: { side: 'right' } },
            { kind: 'graph-view.whole', target: 'whole', title: 'Whole graph', region: 'main', address: { segment: 'graph-view' } },
        ],
    }),
])

describe('the address book', () => {
    it('names a concept View by its segment and the concept, each path segment encoded', () => {
        expect(book.url('g1', { kind: 'kanban.board', target: 'Projects/Q4 plan' })).toBe('/g/g1/k/Projects/Q4%20plan')
    })

    it('names a one-per-graph View by its segment alone', () => {
        expect(book.url('g 1', { kind: 'graph-view.whole', target: 'whole' })).toBe('/g/g%201/graph-view')
    })

    it('gives no address to a kind that declares none, or a kind no extension declares', () => {
        expect(book.url('g1', { kind: 'graph-view.local', target: 'local' })).toBeNull()
        expect(book.url('g1', { kind: 'document', target: 'Home' })).toBeNull()
    })

    it('reads an address back into the View it names', () => {
        expect(book.view('k', 'Projects/Q4 plan')).toEqual({ kind: 'kanban.board', target: 'Projects/Q4 plan' })
        expect(book.view('graph-view', '')).toEqual({ kind: 'graph-view.whole', target: 'whole' })
    })

    it('refuses an address no extension declares, a concept address with no concept, and a fixed one with a tail', () => {
        expect(book.view('m', 'Paris')).toBeNull()
        expect(book.view('k', '')).toBeNull()
        expect(book.view('graph-view', 'extra')).toBeNull()
    })

    it('lists the declared segments for the route to match', () => {
        expect([...book.segments()].sort()).toEqual(['graph-view', 'k'])
    })

    it('knows which kinds are about a concept, so they follow a rename', () => {
        expect(book.takesConcept('kanban.board')).toBe(true)
        expect(book.takesConcept('graph-view.whole')).toBe(false)
        expect(book.takesConcept('document')).toBe(false)
    })
})

describe('the addresses of an extension from the Extension Directory', () => {
    const orchard = {
        ...extension({
            id: 'orchard',
            views: [
                { kind: 'orchard.trees', title: 'Trees: {target}', region: 'main', address: { segment: 'trees', target: 'concept' } },
                { kind: 'orchard.map', target: 'map', title: 'Orchard map', region: 'main', address: { segment: 'map' } },
            ],
        }),
        installed: { version: '1.0.0', integrity: 'sha512-orchard' },
    }
    const builtIns = (): AddressedExtension[] => [
        extension({ id: 'kanban', views: [{ kind: 'kanban.board', title: 'Kanban: {target}', region: 'main', address: { segment: 'k', target: 'concept' } }] }),
    ]
    const directoryBook = createAddressBook(() => [...builtIns(), orchard])

    it('are under /x/ and its id, so they never meet the Client’s own or another extension’s', () => {
        expect(directoryBook.url('g1', { kind: 'orchard.trees', target: 'Apple tree' })).toBe('/g/g1/x/orchard/trees/Apple%20tree')
        expect(directoryBook.url('g1', { kind: 'orchard.map', target: 'map' })).toBe('/g/g1/x/orchard/map')
        expect(directoryBook.url('g1', { kind: 'kanban.board', target: 'Projects' })).toBe('/g/g1/k/Projects')
    })

    it('read back into the View they name', () => {
        expect(directoryBook.view('x', 'orchard/trees/Apple tree')).toEqual({ kind: 'orchard.trees', target: 'Apple tree' })
        expect(directoryBook.view('x', 'orchard/map')).toEqual({ kind: 'orchard.map', target: 'map' })
        expect(directoryBook.takesConcept('orchard.trees')).toBe(true)
    })

    it('answer only under their own prefix, and a built-in’s only bare', () => {
        expect(directoryBook.view('trees', 'Apple tree')).toBeNull()
        expect(directoryBook.view('x', 'kanban/k/Projects')).toBeNull()
        expect(directoryBook.view('x', 'orchard/map/extra')).toBeNull()
        expect(directoryBook.view('x', 'orchard/paths/North')).toBeNull()
        expect(directoryBook.view('x', '')).toBeNull()
    })

    it('say which extension an address belongs to when it is not here', () => {
        expect(directoryBook.missing('x', 'pear/branches/Old pear')).toBe('pear')
        expect(directoryBook.missing('x', 'orchard/trees/Apple tree')).toBeNull()
        expect(directoryBook.missing('x', 'orchard/paths/North')).toBeNull()
        expect(directoryBook.missing('k', 'Projects')).toBeNull()
        expect(directoryBook.missing('x', 'Not an id/trees')).toBeNull()
    })

    it('follow the extensions as they are added and removed', () => {
        const live = builtIns()
        const liveBook = createAddressBook(() => live)
        expect(liveBook.view('x', 'orchard/map')).toBeNull()
        live.push(orchard)
        expect(liveBook.view('x', 'orchard/map')).toEqual({ kind: 'orchard.map', target: 'map' })
    })
})
