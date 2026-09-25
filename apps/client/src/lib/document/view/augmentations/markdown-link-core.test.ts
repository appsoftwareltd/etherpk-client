import { parser } from '@lezer/markdown'
import { describe, expect, it } from 'vitest'

import { type LinkPiece, isOpenableUrl, linkPieces, parseInlineLink, safeHref } from './markdown-link-core'
import { editorMarkdownExtensions } from './scheme-url-autolink'

/** The same parser configuration the editor mounts (code-highlight.ts → markdownWithCodeHighlight). */
const markdown = parser.configure(editorMarkdownExtensions)

/**
 * Scan a whole document. `caretLine` is the 1-based line the caret sits on — the line that
 * reveals its raw syntax; by default the caret is nowhere, so everything renders.
 */
function scan(doc: string, caretLine?: number): LinkPiece[] {
    const lineOf = (pos: number) => doc.slice(0, pos).split('\n').length
    return linkPieces({
        tree: markdown.parse(doc),
        sliceDoc: (from, to) => doc.slice(from, to),
        from: 0,
        to: doc.length,
        isActiveLine: (pos) => lineOf(pos) === caretLine,
    })
}

/** The rendered link spans as `text → href`, which is what the reader ends up clicking. */
function links(doc: string, caretLine?: number): string[] {
    return scan(doc, caretLine)
        .filter((p) => p.kind === 'link')
        .map((p) => `${doc.slice(p.from, p.to)} → ${p.kind === 'link' ? p.href : ''}`)
}

/** The spans hidden behind the rendered links. */
function hidden(doc: string, caretLine?: number): string[] {
    return scan(doc, caretLine)
        .filter((p) => p.kind === 'hide')
        .map((p) => doc.slice(p.from, p.to))
}

describe('parseInlineLink', () => {
    it('splits `[label](url)`', () => {
        expect(parseInlineLink('[docs](https://example.com)')).toEqual({ label: 'docs', url: 'https://example.com' })
    })

    it('refuses anything else — a wikilink has no `(url)`', () => {
        expect(parseInlineLink('[Some Page]')).toBeNull()
        expect(parseInlineLink('[ref][1]')).toBeNull()
    })
})

describe('isOpenableUrl', () => {
    it('is true only for a whole address the browser would open', () => {
        expect(isOpenableUrl('https://example.com/a?b=1')).toBe(true)
        expect(isOpenableUrl('mailto:docs@example.com')).toBe(true)
        expect(isOpenableUrl('www.example.com')).toBe(true)
        expect(isOpenableUrl('docs@example.com')).toBe(true)
    })

    it('is false for a relative path, a refused scheme, prose, and an address with whitespace in it', () => {
        expect(isOpenableUrl('notes/page.md')).toBe(false)
        expect(isOpenableUrl('javascript:alert(1)')).toBe(false)
        expect(isOpenableUrl('See https://example.com')).toBe(false)
        expect(isOpenableUrl('https://example.com/a b')).toBe(false)
        expect(isOpenableUrl('')).toBe(false)
    })
})

describe('safeHref', () => {
    it('passes through the schemes a browser can open', () => {
        expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
        expect(safeHref('http://example.com')).toBe('http://example.com')
        expect(safeHref('mailto:docs@example.com')).toBe('mailto:docs@example.com')
    })

    it('gives a GFM-autolinked bare host a scheme — `www.x` is otherwise a relative path', () => {
        expect(safeHref('www.example.com')).toBe('https://www.example.com')
    })

    it('turns a bare address into a mailto', () => {
        expect(safeHref('docs@example.com')).toBe('mailto:docs@example.com')
    })

    it('refuses a scheme that would run script in the app origin', () => {
        expect(safeHref('javascript:alert(1)')).toBeNull()
        expect(safeHref('JavaScript:alert(1)')).toBeNull()
        expect(safeHref('data:text/html,<script>x</script>')).toBeNull()
        expect(safeHref('vbscript:msgbox')).toBeNull()
    })

    it('reads the scheme as the browser does, after the characters its URL parser strips', () => {
        // The URL parser drops leading and trailing C0 controls and spaces, and tabs and newlines
        // anywhere, before it reads the scheme; each of these opens as javascript: in a browser.
        for (const target of ['\u0001javascript:alert(1)', '\u0000javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', ' \u001fjavascript:alert(1)']) {
            expect(safeHref(target)).toBeNull()
        }
        expect(safeHref('\u0001https://example.com')).toBe('https://example.com')
        expect(safeHref('https://exa\tmple.com')).toBe('https://example.com')
    })

    it('leaves an ordinary relative target alone', () => {
        expect(safeHref('notes/page.md')).toBe('notes/page.md')
        expect(safeHref('')).toBeNull()
    })
})

describe('linkPieces', () => {
    it('renders `[text](url)` as its text, hiding the syntax', () => {
        expect(links('see [the docs](https://example.com) now')).toEqual(['the docs → https://example.com'])
        expect(hidden('see [the docs](https://example.com) now')).toEqual(['[', '](https://example.com)'])
    })

    it('makes a bare url clickable where it stands, with nothing to hide', () => {
        expect(links('Visit https://example.com/a?b=1 today')).toEqual([
            'https://example.com/a?b=1 → https://example.com/a?b=1',
        ])
        expect(hidden('Visit https://example.com/a?b=1 today')).toEqual([])
    })

    it('renders an `<autolink>` as its url, hiding the angle brackets', () => {
        expect(links('go <https://example.com> now')).toEqual(['https://example.com → https://example.com'])
        expect(hidden('go <https://example.com> now')).toEqual(['<', '>'])
    })

    it('links a bare host and a bare address, normalised', () => {
        expect(links('www.example.com and docs@example.com')).toEqual([
            'www.example.com → https://www.example.com',
            'docs@example.com → mailto:docs@example.com',
        ])
    })

    it('links a url inside an outliner bullet and a task', () => {
        expect(links('- a bullet with https://example.com/x')).toEqual([
            'https://example.com/x → https://example.com/x',
        ])
        expect(links('- [ ] task with https://example.com/x')).toEqual([
            'https://example.com/x → https://example.com/x',
        ])
    })

    it('stops the url before trailing sentence punctuation', () => {
        expect(links('Trailing https://example.com. End')).toEqual(['https://example.com → https://example.com'])
    })

    it('reveals the raw syntax on the caret’s line, so the link can be edited', () => {
        const doc = 'first [docs](https://example.com)\nsecond <https://example.com>'
        expect(hidden(doc, 1)).toEqual(['<', '>']) // line 2 still renders
        expect(hidden(doc, 2)).toEqual(['[', '](https://example.com)'])
        expect(links(doc, 1)).toHaveLength(2) // both stay clickable while revealed
    })

    it('leaves a url in code alone — a fence and inline code are not prose', () => {
        expect(links('```\nhttps://example.com\n```')).toEqual([])
        expect(links('`https://example.com` in code')).toEqual([])
    })

    it('leaves an image to the embed augmentation', () => {
        expect(links('![alt](https://example.com/a.png)')).toEqual([])
    })

    it('leaves a `[[wikilink]]` to the wikilink augmentation, url-shaped or not', () => {
        expect(links('see [[Some Page]] here')).toEqual([])
        expect(links('see [[https://example.com]] here')).toEqual([])
    })

    it('leaves an asset target to the asset-link augmentation, which downloads', () => {
        expect(links('[report](../assets/q3.pdf)')).toEqual([])
    })

    it('leaves an unopenable target raw rather than making it look clickable', () => {
        expect(links('[click](javascript:alert)')).toEqual([])
        expect(hidden('[click](javascript:alert)')).toEqual([])
    })

    it('leaves an empty label raw — there would be nothing to click', () => {
        expect(links('[](https://example.com)')).toEqual([])
    })

    it('scans only the requested range, as the viewport does', () => {
        const doc = 'https://a.example.com\nhttps://b.example.com'
        const second = doc.indexOf('https://b')
        const pieces = linkPieces({
            tree: markdown.parse(doc),
            sliceDoc: (from, to) => doc.slice(from, to),
            from: second,
            to: doc.length,
            isActiveLine: () => false,
        })
        expect(pieces.map((p) => doc.slice(p.from, p.to))).toEqual(['https://b.example.com'])
    })
})

/**
 * GFM only autolinks a dotted host, so these are the urls scheme-url-autolink.ts picks up:
 * the parser extension is exercised through the same scan as everything above.
 */
describe('a url on a dotless host', () => {
    it('links localhost and an intranet name when they carry a scheme', () => {
        const doc = 'dev http://localhost:5174/g/4b28/d/2026-09-02 and https://intranet/page'
        expect(links(doc)).toEqual([
            'http://localhost:5174/g/4b28/d/2026-09-02 → http://localhost:5174/g/4b28/d/2026-09-02',
            'https://intranet/page → https://intranet/page',
        ])
        expect(hidden(doc)).toEqual([])
    })

    it('links a bare host with no path', () => {
        expect(links('http://localhost and http://localhost:3000')).toEqual([
            'http://localhost → http://localhost',
            'http://localhost:3000 → http://localhost:3000',
        ])
    })

    it('stops before trailing punctuation and an unbalanced close paren', () => {
        expect(links('see http://localhost:5174/x. Then (http://localhost:5174/y) done')).toEqual([
            'http://localhost:5174/x → http://localhost:5174/x',
            'http://localhost:5174/y → http://localhost:5174/y',
        ])
        expect(links('a wiki url http://localhost/w/Foo_(bar) here')).toEqual([
            'http://localhost/w/Foo_(bar) → http://localhost/w/Foo_(bar)',
        ])
    })

    it('leaves a scheme with no host, a url in code, and a mid-word match alone', () => {
        expect(links('just http:// here')).toEqual([])
        expect(links('`http://localhost:5174/x` in code')).toEqual([])
        expect(links('xhttp://localhost')).toEqual([])
    })

    it('still renders `[text](url)` and `<url>` forms on a dotless host', () => {
        expect(links('[dev](http://localhost:5174/x) <http://localhost:5174/y>')).toEqual([
            'dev → http://localhost:5174/x',
            'http://localhost:5174/y → http://localhost:5174/y',
        ])
        expect(hidden('[dev](http://localhost:5174/x) <http://localhost:5174/y>')).toEqual([
            '[',
            '](http://localhost:5174/x)',
            '<',
            '>',
        ])
    })

    it('does not swallow the `]` of an enclosing link label', () => {
        // The label holds a url; the link as a whole still renders as its label text.
        expect(links('[see http://localhost:5174/x](http://localhost:5174/y)')).toEqual([
            'see http://localhost:5174/x → http://localhost:5174/y',
        ])
    })
})

/** Image syntax over a non-image (an import's attachment) is a link, not a broken picture. */
describe('image syntax over a non-image target', () => {
    it('renders `![text](url)` as a link when the url is a document, hiding `![` and `](url)`', () => {
        const doc = 'see ![the report](https://example.com/report.pdf) now'
        expect(links(doc)).toEqual(['the report → https://example.com/report.pdf'])
        expect(hidden(doc)).toEqual(['![', '](https://example.com/report.pdf)'])
    })

    it('leaves a real image to the embed augmentation, extension or not', () => {
        expect(links('![pic](https://example.com/a.png)')).toEqual([])
        expect(links('![pic](https://picsum.photos/200)')).toEqual([])
    })

    it('leaves an asset document to the asset-link augmentation, which downloads', () => {
        expect(links('- ![Benefit summary.pdf](../assets/benefit-summary.02a0f4ec.pdf)')).toEqual([])
    })
})

// ── File links (CONTEXT.md → File Link) ───────────────────────────────────────────────────────

describe('file links', () => {
    /** The file-link spans as `text → path`: what a click copies. */
    const fileLinks = (doc: string) =>
        scan(doc)
            .filter((p) => p.kind === 'file-link')
            .map((p) => `${doc.slice(p.from, p.to)} → ${p.kind === 'file-link' ? p.path : ''}`)

    it('is its own piece kind for each of the three shapes, carrying the native path', () => {
        expect(fileLinks('see file:///home/g/My%20Doc.pdf now')).toEqual(['file:///home/g/My%20Doc.pdf → /home/g/My Doc.pdf'])
        expect(fileLinks('see <file:///home/g/x.pdf> now')).toEqual(['file:///home/g/x.pdf → /home/g/x.pdf'])
        expect(fileLinks('see [the report](file:///C:/Users/g/q3.docx) now')).toEqual(['the report → C:\\Users\\g\\q3.docx'])
    })

    it('hides the same syntax a hyperlink hides', () => {
        const hidden = (doc: string) => scan(doc).filter((p) => p.kind === 'hide').map((p) => doc.slice(p.from, p.to))
        expect(hidden('<file:///home/g/x.pdf>')).toEqual(['<', '>'])
        expect(hidden('[report](file:///home/g/x.pdf)')).toEqual(['[', '](file:///home/g/x.pdf)'])
    })

    it('is never a hyperlink: the browser must not be handed a file url', () => {
        expect(links('see file:///home/g/x.pdf now')).toEqual([])
        expect(safeHref('file:///home/g/x.pdf')).toBeNull()
    })

    it('leaves a file url with no path raw', () => {
        expect(scan('see [x](file://) now').filter((p) => p.kind !== 'hide')).toEqual([])
    })
})
