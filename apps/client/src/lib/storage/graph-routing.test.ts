import { describe, expect, it } from 'vitest'

import type { GraphRecord } from './graph-registry'
import { resolveGraphTarget, rootDestination } from './graph-routing'

function graph(id: string): GraphRecord {
    return { id, name: id, backend: 'filesystem', createdAt: 0, handle: {} }
}

describe('resolveGraphTarget', () => {
    it('sends an empty registry to the public home', () => {
        expect(resolveGraphTarget([], null)).toEqual({ kind: 'home' })
        expect(resolveGraphTarget([], 'anything')).toEqual({ kind: 'home' })
    })

    it('opens the only graph, ignoring the pointer', () => {
        expect(resolveGraphTarget([graph('a')], null)).toEqual({ kind: 'open', id: 'a' })
        expect(resolveGraphTarget([graph('a')], 'stale')).toEqual({ kind: 'open', id: 'a' })
    })

    it('opens the pointed-at graph when several exist and it is still present', () => {
        const graphs = [graph('a'), graph('b'), graph('c')]
        expect(resolveGraphTarget(graphs, 'b')).toEqual({ kind: 'open', id: 'b' })
    })

    it('falls back to the picker when the pointer is unset or stale among many', () => {
        const graphs = [graph('a'), graph('b')]
        expect(resolveGraphTarget(graphs, null)).toEqual({ kind: 'picker' })
        expect(resolveGraphTarget(graphs, 'gone')).toEqual({ kind: 'picker' })
    })
})

describe('rootDestination', () => {
    const today = () => '2026-10-17'
    const open = { kind: 'open', id: 'garden' } as const

    it('opens the graph and forwards the query string, as before', () => {
        expect(rootDestination(open, '', today)).toBe('/g/garden')
        expect(rootDestination(open, '?fs=opfs', today)).toBe('/g/garden?fs=opfs')
        expect(rootDestination({ kind: 'picker' }, '?fs=opfs', today)).toBe('/graphs')
        expect(rootDestination({ kind: 'home' }, '?fs=opfs', today)).toBe('/home?fs=opfs')
    })

    it('drops the installed-launch marker, which is for the request log only', () => {
        expect(rootDestination(open, '?source=pwa', today)).toBe('/g/garden')
        expect(rootDestination(open, '?fs=opfs&source=pwa', today)).toBe('/g/garden?fs=opfs')
    })

    it('sends an installed launch with no graphs to the Graphs page rather than the public home', () => {
        expect(rootDestination({ kind: 'home' }, '?source=pwa', today)).toBe('/graphs')
    })

    it("opens today's journal in the graph for the today shortcut", () => {
        expect(rootDestination(open, '?shortcut=today&source=pwa', today)).toBe('/g/garden/d/2026-10-17')
    })

    it('asks the workspace to run the search and quick note shortcuts once it opens', () => {
        expect(rootDestination(open, '?shortcut=search&source=pwa', today)).toBe('/g/garden?launch=search')
        expect(rootDestination(open, '?shortcut=quick-note', today)).toBe('/g/garden?launch=quick-note')
    })

    it('sends a shortcut with no graph to open to the Graphs page', () => {
        expect(rootDestination({ kind: 'home' }, '?shortcut=today', today)).toBe('/graphs')
        expect(rootDestination({ kind: 'picker' }, '?shortcut=search', today)).toBe('/graphs')
    })

    it('ignores a shortcut it does not know', () => {
        expect(rootDestination(open, '?shortcut=elsewhere', today)).toBe('/g/garden')
    })
})
