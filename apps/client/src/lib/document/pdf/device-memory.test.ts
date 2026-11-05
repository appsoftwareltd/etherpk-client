import { describe, expect, it } from 'vitest'

import { createPdfDeviceMemory, MAX_REMEMBERED_PDFS } from './device-memory'

function fakeStorage(): Pick<Storage, 'getItem' | 'setItem'> & { map: Map<string, string> } {
    const map = new Map<string, string>()
    return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => void map.set(key, value) }
}

describe('PDF device memory', () => {
    it('starts with the defaults', () => {
        const memory = createPdfDeviceMemory(fakeStorage())
        expect(memory.preferences()).toEqual({ pageByPage: false, darkPages: false, keepScreenOn: true, penPressure: true })
        expect(memory.pdf('graph', 'a')).toEqual({})
    })

    it('keeps preferences for the device', () => {
        const storage = fakeStorage()
        createPdfDeviceMemory(storage).setPreferences({ darkPages: true })
        expect(createPdfDeviceMemory(storage).preferences().darkPages).toBe(true)
    })

    it('says nothing about a finger drawing until a person changes it, then keeps it', () => {
        const storage = fakeStorage()
        expect(createPdfDeviceMemory(storage).preferences().fingerDraws).toBeUndefined()
        createPdfDeviceMemory(storage).setPreferences({ fingerDraws: false })
        expect(createPdfDeviceMemory(storage).preferences().fingerDraws).toBe(false)
    })

    it('keeps zoom, crop and place per graph and per PDF', () => {
        const storage = fakeStorage()
        const memory = createPdfDeviceMemory(storage)
        memory.updatePdf('one', 'a', { zoom: 1.5, crop: true })
        memory.updatePdf('one', 'a', { place: { page: 3, offset: 0.25, at: 7 } })
        memory.updatePdf('two', 'a', { zoom: 2 })
        const again = createPdfDeviceMemory(storage)
        expect(again.pdf('one', 'a')).toEqual({ zoom: 1.5, crop: true, place: { page: 3, offset: 0.25, at: 7 } })
        expect(again.pdf('two', 'a')).toEqual({ zoom: 2 })
    })

    it('forgets the PDFs used longest ago rather than growing without end', () => {
        const memory = createPdfDeviceMemory(fakeStorage())
        for (let i = 0; i <= MAX_REMEMBERED_PDFS; i++) memory.updatePdf('one', `pdf-${i}`, { zoom: 1 })
        expect(memory.pdf('one', 'pdf-0')).toEqual({})
        expect(memory.pdf('one', `pdf-${MAX_REMEMBERED_PDFS}`)).toEqual({ zoom: 1 })
    })

    it('reads damaged storage as nothing remembered', () => {
        const storage = fakeStorage()
        storage.setItem('etherpk.pdf.device', '{not json')
        const memory = createPdfDeviceMemory(storage)
        expect(memory.pdf('one', 'a')).toEqual({})
        expect(memory.preferences().keepScreenOn).toBe(true)
    })

    it('still answers when the browser refuses to store anything', () => {
        const memory = createPdfDeviceMemory({
            getItem: () => {
                throw new Error('denied')
            },
            setItem: () => {
                throw new Error('denied')
            },
        })
        memory.updatePdf('one', 'a', { zoom: 2 })
        expect(memory.pdf('one', 'a')).toEqual({ zoom: 2 })
    })
})
