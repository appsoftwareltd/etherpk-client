import { describe, expect, it } from 'vitest'

import { calloutHeading, obsidianComments, unsupportedConstructs, withoutComments } from './obsidian-constructs'

const strip = (body: string) => withoutComments(body, obsidianComments(body))

describe('Obsidian comments', () => {
    it('finds inline and multi-line comments, and not in code or unclosed', () => {
        const body = 'a %%one%% b\n%%\ntwo\n%%\n`%%code%%`\n```\n%%fence%%\n```\nopen %% only'
        expect(obsidianComments(body).map((c) => c.text)).toEqual(['one', '\ntwo\n'])
    })

    it('takes a comment line with it, and keeps the words around an inline one', () => {
        expect(strip('first\n%%gone%%\nlast')).toBe('first\nlast')
        expect(strip('keep %%gone%% this')).toBe('keep this')
        expect(strip('keep%%gone%%this')).toBe('keepthis')
        expect(strip('text %%starts\nends%% more')).toBe('text more')
    })

    it('leaves a body with no comments as it is', () => {
        expect(strip('plain\n\ntext')).toBe('plain\n\ntext')
    })
})

describe('Obsidian callouts', () => {
    it('heads the quote with the type, and the title when there is one', () => {
        expect(calloutHeading('> [!info] Read me')).toEqual({ line: '> **Info: Read me**', type: 'info' })
        expect(calloutHeading('> [!faq]+')).toEqual({ line: '> **Faq**', type: 'faq' })
        expect(calloutHeading('> > [!quote] Nested')).toEqual({ line: '> > **Quote: Nested**', type: 'quote' })
    })

    it('is not a callout without the quote marker or the bang', () => {
        expect(calloutHeading('[!note] not quoted')).toBeNull()
        expect(calloutHeading('> [note] a link label')).toBeNull()
    })
})

describe('Obsidian footnotes and tags', () => {
    it('reports a footnote reference or definition', () => {
        expect(unsupportedConstructs('see[^a]').footnotes).toBe(true)
        expect(unsupportedConstructs('[^note]: text').footnotes).toBe(true)
        expect(unsupportedConstructs('an [array] index').footnotes).toBe(false)
    })

    it('reports tags, and not headings, numbers, anchors, links or code', () => {
        const body = [
            '# Heading',
            '#tag at the start, (#paren) and #nested/deep',
            'C# and #1984 and https://example.com/page#frag',
            '[jump](#section) and [[Page#Heading]] and [[#Local]]',
            'code `#inline` here',
            '```',
            '#fenced',
            '```',
        ].join('\n')
        expect(unsupportedConstructs(body).tags).toEqual(['#tag', '#paren', '#nested/deep'])
    })
})
