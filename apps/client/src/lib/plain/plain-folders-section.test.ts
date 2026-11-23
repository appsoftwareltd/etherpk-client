import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { plainFoldersSection, type PlainFoldersListing } from './plain-folders-section'

describe('plainFoldersSection', () => {
    it('is there before any folder has been opened, with the way to open one', () => {
        expect(plainFoldersSection({ count: 0, listing: 'listed', canOpen: true })).toBe('empty')
    })

    it('lists the folders this device holds', () => {
        expect(plainFoldersSection({ count: 2, listing: 'listed', canOpen: true })).toBe('list')
    })

    it('waits for the list before calling it empty', () => {
        expect(plainFoldersSection({ count: 0, listing: 'pending', canOpen: true })).toBe('hidden')
    })

    it('says a list that could not be read was not read, rather than that there are none', () => {
        expect(plainFoldersSection({ count: 0, listing: 'unreadable', canOpen: true })).toBe('unreadable')
    })

    it('is left out where the browser cannot open a folder and holds none', () => {
        expect(plainFoldersSection({ count: 0, listing: 'listed', canOpen: false })).toBe('hidden')
        expect(plainFoldersSection({ count: 0, listing: 'unreadable', canOpen: false })).toBe('hidden')
    })

    it('never hides a folder it holds, and never says there are none without having read the list', () => {
        const listings = fc.constantFrom<PlainFoldersListing>('pending', 'listed', 'unreadable')
        fc.assert(
            fc.property(fc.nat(5), listings, fc.boolean(), (count, listing, canOpen) => {
                const shown = plainFoldersSection({ count, listing, canOpen })
                expect(shown === 'list').toBe(count > 0)
                if (shown === 'empty') expect({ listing, canOpen }).toEqual({ listing: 'listed', canOpen: true })
            }),
            { seed: 20261123 },
        )
    })
})
