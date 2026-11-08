import { describe, expect, it } from 'vitest'

import { ALIGNABLE, DARK_PAGE, DEFAULT_EBOOK_SETTINGS, FLOATED, floatedAs, isAlignable, LIGHT_PAGE, pageStyles, sanitizeEbookSettings } from './ebook-settings'

describe('an EBook\'s text settings', () => {
    it('takes the defaults from nothing', () => {
        expect(sanitizeEbookSettings(null)).toEqual(DEFAULT_EBOOK_SETTINGS)
        expect(sanitizeEbookSettings('nonsense')).toEqual(DEFAULT_EBOOK_SETTINGS)
    })

    it('keeps text at the size the app allows, whatever was stored', () => {
        expect(sanitizeEbookSettings({ fontSize: 2 }).fontSize).toBe(14)
        expect(sanitizeEbookSettings({ fontSize: 400 }).fontSize).toBe(40)
        expect(sanitizeEbookSettings({ fontSize: 'big' }).fontSize).toBe(DEFAULT_EBOOK_SETTINGS.fontSize)
    })

    it('drops one bad setting and keeps the rest', () => {
        const settings = sanitizeEbookSettings({ flow: 'sideways', justify: true, font: 'sans' })
        expect(settings.flow).toBe('paginated')
        expect(settings.justify).toBe(true)
        expect(settings.font).toBe('sans')
    })
})

describe('the stylesheet for an EBook\'s pages', () => {
    it('leaves the EBook\'s fonts alone until the person chooses one', () => {
        expect(pageStyles(DEFAULT_EBOOK_SETTINGS, LIGHT_PAGE)).not.toContain('font-family')
        expect(pageStyles({ ...DEFAULT_EBOOK_SETTINGS, font: 'serif' }, LIGHT_PAGE)).toContain('font-family: Georgia')
    })

    it('overrides an EBook\'s colours only on a dark page', () => {
        expect(pageStyles(DEFAULT_EBOOK_SETTINGS, LIGHT_PAGE)).not.toContain('color: inherit')
        expect(pageStyles(DEFAULT_EBOOK_SETTINGS, DARK_PAGE)).toContain('color: inherit')
    })

    it('applies size and spacing', () => {
        const css = pageStyles({ ...DEFAULT_EBOOK_SETTINGS, fontSize: 24, lineHeight: 1.8, justify: true, hyphenate: true }, LIGHT_PAGE)
        expect(css).toContain('font-size: 24px')
        expect(css).toContain('line-height: 1.8')
        expect(css).toContain('text-align: justify')
        expect(css).toContain('hyphens: auto')
    })

    it('puts the person\'s line spacing and hyphenation above the EBook\'s own', () => {
        const css = pageStyles({ ...DEFAULT_EBOOK_SETTINGS, lineHeight: 1.8, hyphenate: true }, LIGHT_PAGE)
        expect(css).toContain('line-height: 1.8 !important')
        expect(css).toContain('hyphens: auto !important')
    })

    it('gives the words inside a paragraph its line spacing, and leaves a float the spacing of its own lines', () => {
        expect(pageStyles(DEFAULT_EBOOK_SETTINGS, LIGHT_PAGE)).toContain(`:is(p, li, blockquote, dd) :not(sup, sub, [${FLOATED}="own"]) { line-height: inherit !important; }`)
    })

    it('sets a floated first letter no bigger than its paragraph\'s words in line with them, and leaves a drop cap floated', () => {
        expect(pageStyles(DEFAULT_EBOOK_SETTINGS, LIGHT_PAGE)).toContain(`[${FLOATED}="inline"] { float: none !important; }`)
        expect(floatedAs('I ', 16, 16)).toBe('inline')
        expect(floatedAs('\u201cT', 17, 16)).toBe('inline')
        expect(floatedAs('T', 48, 16)).toBe('own')
        expect(floatedAs('A word set to one side', 16, 16)).toBe('own')
        expect(floatedAs('', 16, 16)).toBe('own')
    })

    it('aligns only the text the EBook leaves to the side it starts from', () => {
        expect(pageStyles({ ...DEFAULT_EBOOK_SETTINGS, justify: true }, LIGHT_PAGE)).toContain(`[${ALIGNABLE}] { text-align: justify !important; }`)
        expect(pageStyles(DEFAULT_EBOOK_SETTINGS, LIGHT_PAGE)).toContain(`[${ALIGNABLE}] { text-align: start !important; }`)
        expect(['start', 'left', 'justify'].every(isAlignable)).toBe(true)
        expect(['center', 'right', 'end', '-webkit-center'].some(isAlignable)).toBe(false)
    })
})
