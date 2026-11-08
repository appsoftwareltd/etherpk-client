import { describe, expect, it } from 'vitest'

import type { EbookHighlight } from './ebook-state'
import { highlightsMarkdown, highlightsPageName } from './export-highlights'

const REF = '../assets/garden-notes.a1.epub'
const highlight = (id: string, fraction: number, over: Partial<EbookHighlight> = {}): EbookHighlight => ({
    id,
    cfi: `epubcfi(/6/${id}!/4/2:1)`,
    colour: '#ffee00',
    text: `words ${id}`,
    fraction,
    createdAt: 1,
    updatedAt: 1,
    ...over,
})

describe('an EBook\'s highlights as a page', () => {
    it('names the page after the EBook, with nothing a page\'s name cannot hold', () => {
        expect(highlightsPageName('Garden Notes')).toBe('Garden Notes Highlights')
        expect(highlightsPageName('Beans: A/B [Guide]')).toBe('Beans A B Guide Highlights')
        expect(highlightsPageName('')).toBe('EBook Highlights')
    })

    it('puts them in EBook order under their chapters, each with a link back', () => {
        const text = highlightsMarkdown([highlight('8', 0.8, { chapter: 'Tomatoes' }), highlight('2', 0.2, { chapter: 'Beans' }), highlight('3', 0.3, { chapter: 'Beans' })], REF)
        const lines = text.trimEnd().split('\n')
        expect(lines[0]).toBe('- Beans')
        expect(lines[1]).toMatch(/^ {2}- words 2 \[20%\]\(.*#cfi=epubcfi%28/)
        expect(lines[2]).toMatch(/^ {2}- words 3 /)
        expect(lines[3]).toBe('- Tomatoes')
        expect(lines[4]).toMatch(/^ {2}- words 8 /)
    })

    it('never lets a chapter\'s name or a passage load an image when the page is opened', () => {
        const text = highlightsMarkdown([highlight('1', 0.1, { chapter: '![c](https://example.com/c.png)', text: 'see ![t](https://example.com/t.png)' })], REF)
        expect(text).not.toContain('![')
    })

    it('keeps a note beneath its highlight, and one with no chapter at the top level', () => {
        const text = highlightsMarkdown([highlight('1', 0.1, { note: 'do  this\nfirst' })], REF)
        expect(text.split('\n')[0]).toMatch(/^- words 1 /)
        expect(text.split('\n')[1]).toBe('  - do this first')
    })
})
