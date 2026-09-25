import { describe, expect, it } from 'vitest'

import { PREVIEW_NAVIGATE, dataUrlOf, previewDocument, previewPages } from './preview'

const bundle = new Map<string, string | Uint8Array>([
    ['index.html', '<!DOCTYPE html><html><head><link rel="stylesheet" href="theme/theme.css"><link rel="icon" href="https://x.example/i.png"></head><body><a href="guide.html">Guide</a><a href="https://example.com">Out</a><a href="404.html" class="wikilink-missing">Gone</a><img src="assets/chart.png"><form data-search-index="search.json"></form><script src="theme/search.js" defer></script></body></html>'],
    ['guide.html', '<html><body>guide</body></html>'],
    ['404.html', '<html><body>404</body></html>'],
    ['journal.html', '<html><body>journal</body></html>'],
    ['theme/theme.css', 'body{color:red}'],
    ['theme/search.js', 'console.log("s")'],
    ['assets/chart.png', new Uint8Array([137, 80, 78, 71])],
    ['search.json', '{"documents":[]}'],
])

describe('previewDocument', () => {
    it('inlines the bundle stylesheet and script, and leaves external ones alone', () => {
        const html = previewDocument(bundle, 'index.html') as string
        expect(html).toContain('<style data-preview-of="theme/theme.css">body{color:red}</style>')
        expect(html).toContain('<script data-preview-of="theme/search.js" defer>console.log("s")</script>')
        expect(html).toContain('href="https://x.example/i.png"')
    })

    it('turns bundle assets and the search index into data urls', () => {
        const html = previewDocument(bundle, 'index.html') as string
        expect(html).toContain('<img src="data:image/png;base64,iVBORw==">')
        expect(html).toContain('data-search-index="data:application/json;base64,')
        expect(dataUrlOf(bundle, 'nope.png')).toBeNull()
    })

    it('turns links to site pages into messages, keeps external and missing-page links, and appends the script', () => {
        const html = previewDocument(bundle, 'index.html') as string
        expect(html).toContain('<a href="#" data-preview-page="guide.html">Guide</a>')
        expect(html).toContain('<a href="#" data-preview-page="404.html" class="wikilink-missing">Gone</a>')
        expect(html).toContain('<a href="https://example.com">Out</a>')
        expect(html).toContain(PREVIEW_NAVIGATE)
        expect(html.indexOf('postMessage')).toBeGreaterThan(html.indexOf('<body>'))
    })

    it('is null for a page the bundle does not have', () => {
        expect(previewDocument(bundle, 'missing.html')).toBeNull()
    })
})

describe('previewPages', () => {
    it('lists the pages home first, then by name, the archive and the 404 last', () => {
        expect(previewPages(bundle)).toEqual(['index.html', 'guide.html', 'journal.html', '404.html'])
    })
})
