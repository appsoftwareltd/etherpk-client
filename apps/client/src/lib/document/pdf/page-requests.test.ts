import { describe, expect, it } from 'vitest'

import { pageFromReference, requestedPdfPage, requestPdfPage, withoutFragment } from './page-requests'

describe('a link to a page of a PDF', () => {
    it('reads the page out of the fragment', () => {
        expect(pageFromReference('../assets/guide.pdf#page=12')).toBe(12)
        expect(pageFromReference('../assets/guide.pdf#zoom=2&page=3')).toBe(3)
    })

    it('reads nothing from a reference with no page, or a page before the first', () => {
        expect(pageFromReference('../assets/guide.pdf')).toBeNull()
        expect(pageFromReference('../assets/guide.pdf#page=0')).toBeNull()
    })

    it('takes the fragment off', () => {
        expect(withoutFragment('../assets/guide.pdf#page=12')).toBe('../assets/guide.pdf')
    })

    it('answers a request once', () => {
        requestPdfPage('guide', 4)
        expect(requestedPdfPage('guide')).toBe(4)
        expect(requestedPdfPage('guide')).toBeNull()
    })
})
