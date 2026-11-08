import { describe, expect, it } from 'vitest'

import { createEbookDeviceMemory, MAX_REMEMBERED_BOOKS } from './ebook-device-memory'
import { DEFAULT_EBOOK_SETTINGS } from './ebook-settings'

function storage(initial: string | null = null) {
    let value = initial
    return { getItem: () => value, setItem: (_key: string, next: string) => void (value = next), read: () => value }
}

const CFI = 'epubcfi(/6/4!/4/2:12)'

describe('what a device remembers about reading EBooks', () => {
    it('starts from the defaults, on nothing or on rubbish', () => {
        expect(createEbookDeviceMemory(storage()).preferences().settings).toEqual(DEFAULT_EBOOK_SETTINGS)
        expect(createEbookDeviceMemory(storage('{nope')).preferences().settings).toEqual(DEFAULT_EBOOK_SETTINGS)
    })

    it('keeps settings between visits', () => {
        const held = storage()
        createEbookDeviceMemory(held).setPreferences({ settings: { ...DEFAULT_EBOOK_SETTINGS, fontSize: 24 } })
        expect(createEbookDeviceMemory(held).preferences().settings.fontSize).toBe(24)
    })

    it('checks a remembered place when it reads it', () => {
        const memory = createEbookDeviceMemory(storage())
        memory.updateEbook('g', 'h', { place: { cfi: CFI, fraction: 0.5, at: 1 } })
        expect(memory.ebook('g', 'h').place?.fraction).toBe(0.5)
        memory.updateEbook('g', 'h', { place: { cfi: 'nonsense', fraction: 0.5, at: 1 } })
        expect(memory.ebook('g', 'h').place).toBeUndefined()
    })

    it('keeps a place another window reached, when this window saves something else', () => {
        const held = storage()
        const here = createEbookDeviceMemory(held)
        const there = createEbookDeviceMemory(held)
        there.updateEbook('g', 'x', { place: { cfi: CFI, fraction: 0.6, at: 2 } })
        here.updateEbook('g', 'y', { place: { cfi: CFI, fraction: 0.1, at: 3 } })
        expect(createEbookDeviceMemory(held).ebook('g', 'x').place?.fraction).toBe(0.6)
        expect(here.ebook('g', 'x').place?.fraction).toBe(0.6)
    })

    it('holds on to what it could not store, for as long as the tab is open', () => {
        const memory = createEbookDeviceMemory({
            getItem: () => null,
            setItem: () => {
                throw new Error('storage is blocked')
            },
        })
        memory.updateEbook('g', 'x', { place: { cfi: CFI, fraction: 0.6, at: 2 } })
        memory.setPreferences({ settings: { ...DEFAULT_EBOOK_SETTINGS, fontSize: 24 } })
        expect(memory.ebook('g', 'x').place?.fraction).toBe(0.6)
        expect(memory.preferences().settings.fontSize).toBe(24)
    })

    it('forgets the oldest EBook past the limit, and one that is deleted', () => {
        const memory = createEbookDeviceMemory(storage())
        for (let n = 0; n <= MAX_REMEMBERED_BOOKS; n++) memory.updateEbook('g', `h${n}`, { place: { cfi: CFI, fraction: 0, at: n } })
        expect(memory.ebook('g', 'h0').place).toBeUndefined()
        expect(memory.ebook('g', 'h1').place).toBeDefined()
        memory.forgetEbook('g', 'h1')
        expect(memory.ebook('g', 'h1').place).toBeUndefined()
    })
})
