import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import type { PdfNote, PdfStroke } from './pdf-state'
import { openSyncedPdfState, readPdfStateDoc, refusingPdfState, writePdfStateDoc } from './synced-pdf-state'

const note: PdfNote = { id: 'n', kind: 'note', page: 1, colour: '#000000', createdAt: 1, updatedAt: 1, x: 1, y: 2, fontSize: 12, text: 'Water the beans' }
const stroke: PdfStroke = { id: 's', kind: 'stroke', tool: 'pen', page: 1, colour: '#000000', createdAt: 1, updatedAt: 1, width: 1, points: [1, 2, 3, 4] }

function open(doc = new Y.Doc()) {
    return openSyncedPdfState({ doc, ready: async () => {}, flush: async () => {}, release: () => {} })
}

describe('a private PDF document', () => {
    it('shows a write at once and tells its listeners', async () => {
        const store = await open()
        let heard = 0
        store.subscribe(() => heard++)
        store.putAnnotation(note)
        expect(store.state().annotations).toEqual([note])
        expect(heard).toBe(1)
    })

    it('merges annotations two devices made while apart', async () => {
        const one = new Y.Doc()
        const two = new Y.Doc()
        ;(await open(one)).putAnnotation(note)
        ;(await open(two)).putAnnotation(stroke)
        Y.applyUpdate(one, Y.encodeStateAsUpdate(two))
        Y.applyUpdate(two, Y.encodeStateAsUpdate(one))
        const ids = (doc: Y.Doc) => readPdfStateDoc(doc).annotations.map((a) => a.id).sort()
        expect(ids(one)).toEqual(['n', 's'])
        expect(ids(two)).toEqual(['n', 's'])
    })

    it('keeps a removal on one device when the other changed something else', async () => {
        const one = new Y.Doc()
        const storeOne = await open(one)
        storeOne.putAnnotation(note)
        const two = new Y.Doc()
        Y.applyUpdate(two, Y.encodeStateAsUpdate(one))
        storeOne.removeAnnotation('n')
        ;(await open(two)).putAnnotation(stroke)
        Y.applyUpdate(one, Y.encodeStateAsUpdate(two))
        expect(readPdfStateDoc(one).annotations.map((a) => a.id)).toEqual(['s'])
    })

    it('follows the place, PDF bookmarks and form values', async () => {
        const store = await open()
        store.setPlace({ page: 9, offset: 0.1, at: 5 })
        store.setFormValue('12R', { value: 'Sam' })
        expect(store.state()).toMatchObject({
            place: { page: 9 },
            forms: { '12R': { value: 'Sam' } },
        })
        store.setFormValue('12R', undefined)
        expect(store.state()).toMatchObject({ forms: {} })
    })

    it('drops an entry it cannot read rather than failing', async () => {
        const doc = new Y.Doc()
        doc.getMap('annotations').set('bad', { kind: 'nope' })
        expect((await open(doc)).state().annotations).toEqual([])
    })

    it('takes in a whole state, merging by id', () => {
        const doc = new Y.Doc()
        writePdfStateDoc(doc, { annotations: [note], forms: {} })
        writePdfStateDoc(doc, { annotations: [note, stroke], forms: {} })
        expect(readPdfStateDoc(doc).annotations).toHaveLength(2)
    })

    it('flushes and lets go on close', async () => {
        let released = 0
        let flushed = 0
        const store = await openSyncedPdfState({
            doc: new Y.Doc(),
            ready: async () => {},
            flush: async () => void flushed++,
            release: () => void released++,
        })
        await store.close()
        expect([flushed, released]).toEqual([1, 1])
    })

    it('refuses every write with the reason when there is no person to keep it for', () => {
        const store = refusingPdfState('No account')
        store.putAnnotation(note)
        expect(store.state().annotations).toEqual([])
        expect(store.problem()).toBe('No account')
    })
})
