import { describe, expect, it } from 'vitest'

import { isEbookCfi, sanitizeEbookHighlight, sanitizeEbookPlace, sanitizeEbookState } from './ebook-state'

const CFI = 'epubcfi(/6/4!/4/2,/1:0,/1:5)'
const highlight = { id: 'a', cfi: CFI, colour: '#ffee00', text: 'beans', fraction: 0.25, createdAt: 1, updatedAt: 2 }

describe('a place in an EBook', () => {
    it('can name an element whose id holds a space or a quote, as real EBooks do', () => {
        expect(isEbookCfi('epubcfi(/4/2[Chapter 1]/4[plain],/1:0,/1:4)')).toBe(true)
        expect(isEbookCfi("epubcfi(/4/2[Sidney's note]/4:2)")).toBe(true)
    })

    it('is nothing else', () => {
        for (const value of ['javascript:alert(1)', 'epubcfi()', 'epubcfi(/4\n/2)', `epubcfi(/${'4'.repeat(3000)})`, 4, null]) expect(isEbookCfi(value)).toBe(false)
    })
})

describe('reading back an EBook\'s stored state', () => {
    it('keeps a whole highlight', () => {
        expect(sanitizeEbookHighlight({ ...highlight, note: 'water them', chapter: 'Beans' })).toEqual({ ...highlight, note: 'water them', chapter: 'Beans' })
    })

    it('drops one with no place in the EBook, or a place that is not one', () => {
        expect(sanitizeEbookHighlight({ ...highlight, cfi: undefined })).toBeNull()
        expect(sanitizeEbookHighlight({ ...highlight, cfi: 'javascript:alert(1)' })).toBeNull()
        expect(sanitizeEbookHighlight({ ...highlight, colour: 'red' })).toBeNull()
    })

    it('keeps the good entries of a damaged list', () => {
        expect(sanitizeEbookState({ highlights: [highlight, { id: 'b' }, 'x'] }).highlights).toEqual([highlight])
    })

    it('ignores a place that cannot be read', () => {
        expect(sanitizeEbookPlace({ cfi: CFI, fraction: 3, at: 1 })).toBeUndefined()
        expect(sanitizeEbookPlace({ cfi: CFI, fraction: 0.5, at: 1 })).toEqual({ cfi: CFI, fraction: 0.5, at: 1 })
        expect(sanitizeEbookState({ place: 'x' })).toEqual({ highlights: [] })
    })

    it('cuts a very long note', () => {
        expect(sanitizeEbookHighlight({ ...highlight, note: 'x'.repeat(30_000) })?.note).toHaveLength(20_000)
    })
})
