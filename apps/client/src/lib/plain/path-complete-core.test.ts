import { describe, expect, it } from 'vitest'

import { openLinkSlot, restOfDestination, suggestPaths } from './path-complete-core'

describe('where a link’s destination is being typed', () => {
    it('starts after the `](` that closes a `[`, for a link and for a picture', () => {
        expect(openLinkSlot('see [soil](so')).toEqual({ open: 9, queryFrom: 11 })
        expect(openLinkSlot('![bed](')).toEqual({ open: 5, queryFrom: 7 })
        expect(openLinkSlot('[a](x.md) and [b](gui')).toEqual({ open: 16, queryFrom: 18 })
    })

    it('is over once the destination is closed, a title begins, or it was never a link', () => {
        expect(openLinkSlot('see [soil](soil.md)')).toBeNull()
        expect(openLinkSlot('see [soil](soil.md "Clay')).toBeNull()
        expect(openLinkSlot('f](x')).toBeNull()
        expect(openLinkSlot('plain text')).toBeNull()
        expect(openLinkSlot('[a](<my file')).toBeNull()
    })

    it('says how much of the text after the caret is still the destination', () => {
        expect(restOfDestination('il.md) and more')).toEqual({ length: 5, closed: true })
        expect(restOfDestination('il.md and more')).toEqual({ length: 5, closed: false })
        expect(restOfDestination('')).toEqual({ length: 0, closed: false })
    })
})

describe('the paths offered for a link', () => {
    const files = ['README.md', 'guide/soil.md', 'guide/watering.md', 'guide/images/bed layout.png', 'manuals/soil-test.pdf']

    it('offers each file as the relative link from the file being edited, a neighbour first', () => {
        expect(suggestPaths('guide/watering.md', files, 'so')).toEqual([
            { path: 'guide/soil.md', href: 'soil.md', label: 'soil.md', detail: 'same folder', icon: 'file-text' },
            { path: 'manuals/soil-test.pdf', href: '../manuals/soil-test.pdf', label: '../manuals/soil-test.pdf', detail: 'manuals', icon: 'pdf' },
        ])
    })

    it('escapes the link it writes and shows it as a person reads it', () => {
        expect(suggestPaths('guide/watering.md', files, 'bed')).toEqual([
            { path: 'guide/images/bed layout.png', href: 'images/bed%20layout.png', label: 'images/bed layout.png', detail: 'guide/images', icon: 'image' },
        ])
    })

    it('follows a path as it is typed, and never offers the file to itself', () => {
        expect(suggestPaths('guide/watering.md', files, '../').map((s) => s.label)).toEqual(['../README.md', '../manuals/soil-test.pdf'])
        expect(suggestPaths('guide/watering.md', files, 'images/').map((s) => s.href)).toEqual(['images/bed%20layout.png'])
        expect(suggestPaths('guide/watering.md', files, 'water')).toEqual([])
        expect(suggestPaths('README.md', files, '').map((s) => s.detail)).toContain('guide')
    })
})
