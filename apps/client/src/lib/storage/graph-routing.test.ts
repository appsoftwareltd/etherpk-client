import { describe, expect, it } from 'vitest'

import type { GraphRecord } from './graph-registry'
import { resolveGraphTarget } from './graph-routing'

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
