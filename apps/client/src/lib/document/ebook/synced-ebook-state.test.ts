import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import type { EbookHighlight } from './ebook-state'
import { openSyncedEbookState, readEbookStateDoc, writeEbookStateDoc } from './synced-ebook-state'

const CFI = 'epubcfi(/6/4!/4/2,/1:0,/1:5)'
const highlight = (id: string): EbookHighlight => ({ id, cfi: CFI, colour: '#ffee00', text: 'beans', fraction: 0.25, createdAt: 1, updatedAt: 2 })

const open = (doc: Y.Doc) => openSyncedEbookState({ doc, ready: async () => {}, flush: async () => {}, release: () => {} })

describe('an EBook\'s state in a private document', () => {
    it('merges highlights made on two devices while apart', async () => {
        const phone = new Y.Doc()
        const desktop = new Y.Doc()
        ;(await open(phone)).putHighlight(highlight('a'))
        ;(await open(desktop)).putHighlight(highlight('b'))
        Y.applyUpdate(phone, Y.encodeStateAsUpdate(desktop))
        expect(readEbookStateDoc(phone).highlights.map((h) => h.id).sort()).toEqual(['a', 'b'])
    })

    it('tells a listener what another device did', async () => {
        const doc = new Y.Doc()
        const store = await open(doc)
        let heard = 0
        store.subscribe(() => heard++)
        const other = new Y.Doc()
        writeEbookStateDoc(other, { highlights: [highlight('c')] })
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(other))
        expect(heard).toBe(1)
        expect(store.state().highlights.map((h) => h.id)).toEqual(['c'])
    })

    it('keeps the later place', async () => {
        const doc = new Y.Doc()
        const store = await open(doc)
        store.setPlace({ cfi: CFI, fraction: 0.1, at: 1 })
        store.setPlace({ cfi: CFI, fraction: 0.2, at: 2 })
        expect(store.state().place?.fraction).toBe(0.2)
    })

    it('notes that there is something for an Export to carry, and not for a place alone', async () => {
        const doc = new Y.Doc()
        let noted = 0
        const store = await openSyncedEbookState({ doc, ready: async () => {}, flush: async () => {}, release: () => {}, noteContent: () => noted++ })
        store.setPlace({ cfi: CFI, fraction: 0.1, at: 1 })
        expect(noted).toBe(0)
        store.putHighlight(highlight('d'))
        expect(noted).toBe(1)
    })
})
