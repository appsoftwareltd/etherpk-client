import { describe, expect, it } from 'vitest'

import { reconcileNames } from './name-reconcile'

/** What the index holds: Kanban (alias Board), the journal 2026-06-02 and Roadmap. */
const indexed = [
    { concept: 'Kanban', kind: 'page' as const, aliases: ['Board'] },
    { concept: '2026-06-02', kind: 'journal' as const, aliases: [] },
    { concept: 'Roadmap', kind: 'page' as const, aliases: [] },
]

describe('reconcileNames', () => {
    it('finds nothing to do when the index already has every name', () => {
        expect(reconcileNames(indexed, indexed)).toEqual({ changed: [], removed: [] })
    })

    it('names a document whose aliases changed, whichever way', () => {
        expect(reconcileNames(indexed, [{ ...indexed[0], aliases: ['Board', 'Desk'] }, indexed[1], indexed[2]]).changed).toEqual(['Kanban'])
        expect(reconcileNames(indexed, [{ ...indexed[0], aliases: [] }, indexed[1], indexed[2]]).changed).toEqual(['Kanban'])
        // Case is not a different alias: the same name, as the index keys it.
        expect(reconcileNames(indexed, [{ ...indexed[0], aliases: ['BOARD'] }, indexed[1], indexed[2]]).changed).toEqual([])
    })

    it('names a retitled document under its new name, and removes the old one', () => {
        expect(reconcileNames(indexed, [{ concept: 'Kanban Board', kind: 'page', aliases: ['Board', 'Kanban'] }, indexed[1], indexed[2]])).toEqual({
            changed: ['Kanban Board'],
            removed: ['Kanban'],
        })
    })

    it('names a document whose title only changed case, so the index shows it as written', () => {
        expect(reconcileNames(indexed, [{ ...indexed[0], concept: 'kanban' }, indexed[1], indexed[2]]).changed).toEqual(['kanban'])
    })

    it('names a new document and removes a deleted one', () => {
        expect(reconcileNames(indexed, [indexed[0], indexed[2], { concept: 'Plan', kind: 'page', aliases: [] }])).toEqual({
            changed: ['Plan'],
            removed: ['2026-06-02'],
        })
    })

    // A page whose title another page has as an alias is a document of its own, and is removed
    // when it is deleted like any other.
    it('keeps a page whose title is another page alias apart from that alias', () => {
        const clashing = [{ ...indexed[0], aliases: ['Board', 'Roadmap'] }, indexed[1], indexed[2]]
        expect(reconcileNames(clashing, clashing)).toEqual({ changed: [], removed: [] })
        expect(reconcileNames(clashing, [clashing[0], clashing[1]])).toEqual({ changed: [], removed: ['Roadmap'] })
    })
})
