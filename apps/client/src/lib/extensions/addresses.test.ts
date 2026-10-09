import { describe, expect, it } from 'vitest'

import type { ExtensionManifest } from '@appsoftwareltd/etherpk-extension-api'

import { createAddressBook } from './addresses'

function extension(manifest: Partial<ExtensionManifest> & Pick<ExtensionManifest, 'id'>) {
    return { package: { manifest: { displayName: manifest.id, publisher: 'App Software', main: './src/extension.ts', ...manifest } } }
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
