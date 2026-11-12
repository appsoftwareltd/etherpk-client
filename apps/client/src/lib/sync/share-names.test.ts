import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { quickNoteTextsIn } from './graph-sync'
import { shareNamesOf } from './share-names'

function rootDoc(): Y.Doc {
    const root = new Y.Doc()
    const registry = root.getMap('registry')
    registry.set('d1', { kind: 'page', title: 'Garden', aliases: ['Allotment'] })
    registry.set('d2', { kind: 'page', title: 'Kitchen' })
    registry.set('d3', { kind: 'journal', date: '2026-09-17' })
    registry.set('d4', { kind: 'page', title: 'Allotment' })
    return root
}

describe('shareNamesOf', () => {
    it('names every page, journal day and alias, and a page before an alias of the same name', () => {
        const { concepts } = shareNamesOf(rootDoc(), undefined)
        expect(concepts.map((c) => [c.display, c.kind])).toEqual([
            ['Garden', 'page'],
            ['Kitchen', 'page'],
            ['2026-09-17', 'journal'],
            ['Allotment', 'page'],
        ])
    })

    it('says which page an alias leads to', () => {
        const root = rootDoc()
        root.getMap('registry').set('d5', { kind: 'page', title: 'Shed', aliases: ['Workshop'] })
        expect(shareNamesOf(root, undefined).concepts.at(-1)).toEqual({ display: 'Workshop', key: 'workshop', kind: 'alias', canonical: 'Shed' })
    })

    it('offers the shared favourites when the record names no member', () => {
        const root = rootDoc()
        root.getMap('meta').set('settings', { favourites: ['Kitchen', '2026-09-17', { kind: 'tasks' }] })
        expect(shareNamesOf(root, undefined).fileUnder).toEqual(['Kitchen'])
    })

    it("offers a member's own favourites, joined with the shared ones until theirs are seeded", () => {
        const root = rootDoc()
        root.getMap('meta').set('settings', { favourites: ['Kitchen', 'garden'] })
        root.getArray('favourites:m1').push(['Garden'])
        expect(shareNamesOf(root, 'm1').fileUnder).toEqual(['Garden', 'Kitchen'])
        root.getMap('memberFlags:m1').set('favouritesSeeded', true)
        expect(shareNamesOf(root, 'm1').fileUnder).toEqual(['Garden'])
    })

    it('offers nothing from an empty document', () => {
        expect(shareNamesOf(new Y.Doc(), 'm1')).toMatchObject({ concepts: [], fileUnder: [] })
    })

    it("gives the graph's display size for a picture, and none when the graph has switched it off", () => {
        const root = new Y.Doc()
        root.getMap('meta').set('settings', { defaultMaxImageDisplaySize: '300X200' })
        expect(shareNamesOf(root, undefined).imageSize).toBe('300x200')
        root.getMap('meta').set('settings', { defaultMaxImageDisplaySize: '0' })
        expect(shareNamesOf(root, undefined).imageSize).toBeUndefined()
    })
})

describe('quickNoteTextsIn', () => {
    it("reads the shared list and every member's own, and nothing else", () => {
        const root = new Y.Doc()
        root.getArray('quickNotes').push([{ id: 'a', text: 'shared note', createdAt: 1 }])
        root.getArray('quickNotes:m1').push([{ id: 'b', text: 'first member', createdAt: 2 }])
        root.getArray('quickNotes:m2').push([{ id: 'c', text: 'second member', createdAt: 3 }, { id: 'd', text: '  ', createdAt: 4 }])
        root.getArray('favourites:m1').push(['Garden'])
        expect(quickNoteTextsIn(root).sort()).toEqual(['first member', 'second member', 'shared note'])
    })
})
