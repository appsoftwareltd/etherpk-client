import { describe, expect, it } from 'vitest'

import { ebookLinkMarkdown, ebookQuoteMarkdown, cfiFromReference, requestEbookPlace, requestedEbookPlace } from './ebook-links'

const CFI = 'epubcfi(/6/4!/4/2,/1:0,/1:5)'
const REF = '../assets/garden-notes.1a2b3c4d.epub'

describe('links to a place in an EBook', () => {
    it('reads back the place it wrote', () => {
        const link = ebookLinkMarkdown('Garden Notes, Beans', REF, CFI)
        const target = /\]\((.*)\)$/.exec(link)?.[1] ?? ''
        expect(cfiFromReference(target)).toBe(CFI)
    })

    it('writes a link with no bare bracket for markdown to trip on', () => {
        const link = ebookLinkMarkdown('[Garden] Notes', REF, CFI)
        expect(link).toMatch(/^\[Garden Notes\]\(/)
        expect(link.slice(link.indexOf('](') + 2, -1)).not.toMatch(/[()!]/)
    })

    it('refuses anything that is not a place in an EBook', () => {
        expect(cfiFromReference(`${REF}#page=4`)).toBeNull()
        expect(cfiFromReference(REF)).toBeNull()
        expect(cfiFromReference(`${REF}#cfi=javascript%3Aalert(1)`)).toBeNull()
        expect(cfiFromReference(`${REF}#cfi=%E0%A4%A`)).toBeNull()
    })

    it('quotes a passage with a link back, and a note beneath it', () => {
        const quote = ebookQuoteMarkdown('water  the\nbeans', 'do this first', 'Garden Notes', REF, CFI)
        expect(quote.startsWith('- water the beans [Garden Notes](')).toBe(true)
        expect(quote.endsWith('\n  - do this first\n')).toBe(true)
    })

    it('never lets words from an EBook load an image when the page is opened', () => {
        const quote = ebookQuoteMarkdown('see ![a](https://example.com/x.png) here', undefined, 'Garden Notes', REF, CFI)
        expect(quote).not.toContain('![')
        expect(quote).toContain('! [a]')
    })

    it('answers a request once', () => {
        requestEbookPlace('garden.epub', CFI)
        expect(requestedEbookPlace('garden.epub')).toBe(CFI)
        expect(requestedEbookPlace('garden.epub')).toBeNull()
    })
})
