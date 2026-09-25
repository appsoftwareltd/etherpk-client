import { describe, expect, it } from 'vitest'

import { type InlinePart, inlineParts } from './inline-parts'

/**
 * The read-only reading of a line of document source. What matters in each case is that the
 * panel and the editor agree about what a construct IS — the editor's rules are the ones being
 * called here, so a difference in the answers would be a difference in the wiring, not in the
 * rules.
 */

const PDF = '../assets/q3-report.a1b2c3d4.pdf'
const PNG = '../assets/chart.11111111.png'

/** The parts, minus the plain text between them — what a case is usually about. */
function marked(text: string): InlinePart[] {
    return inlineParts(text).filter((part) => part.kind !== 'text')
}

/** The rendered reading of a line: what a reader would see, with syntax dropped. */
function rendered(text: string): string {
    return inlineParts(text)
        .map((part) => (part.kind === 'image' ? `[image ${part.url}]` : part.kind === 'text' ? part.text : part.text))
        .join('')
}

describe('plain text', () => {
    it('passes a line with nothing in it through as one part', () => {
        expect(inlineParts('just some prose')).toEqual([{ kind: 'text', text: 'just some prose' }])
    })

    it('returns nothing at all for an empty line', () => {
        expect(inlineParts('')).toEqual([])
    })
})

describe('wikilinks', () => {
    it('claims the whole [[…]] and carries its concept', () => {
        expect(inlineParts('see [[Physics]] today')).toEqual([
            { kind: 'text', text: 'see ' },
            { kind: 'wikilink', text: '[[Physics]]', concept: 'Physics' },
            { kind: 'text', text: ' today' },
        ])
    })

    it('leaves a wikilink inside code as text', () => {
        expect(marked('a `[[Physics]]` b')).toEqual([])
    })
})

describe('hyperlinks', () => {
    it('renders [text](url) as its text, with the syntax dropped', () => {
        expect(inlineParts('[docs](https://example.com)')).toEqual([
            { kind: 'link', text: 'docs', href: 'https://example.com' },
        ])
    })

    it('renders an autolink as its url, with the angle brackets dropped', () => {
        expect(inlineParts('<https://example.com>')).toEqual([
            { kind: 'link', text: 'https://example.com', href: 'https://example.com' },
        ])
    })

    it('claims a bare url written into prose', () => {
        expect(rendered('see https://example.com now')).toBe('see https://example.com now')
        expect(marked('see https://example.com now')).toEqual([
            { kind: 'link', text: 'https://example.com', href: 'https://example.com' },
        ])
    })

    it('gives a scheme-less host and an address the scheme a click needs', () => {
        expect(marked('www.example.com')).toEqual([
            { kind: 'link', text: 'www.example.com', href: 'https://www.example.com' },
        ])
        expect(marked('docs@example.com')).toEqual([
            { kind: 'link', text: 'docs@example.com', href: 'mailto:docs@example.com' },
        ])
    })

    it('claims a url on a dotless host, which GFM alone declines', () => {
        expect(marked('http://localhost:5285/g/abc')).toEqual([
            { kind: 'link', text: 'http://localhost:5285/g/abc', href: 'http://localhost:5285/g/abc' },
        ])
    })

    it('leaves a scheme it will not open as raw text rather than a link that does nothing', () => {
        const source = '[run](javascript:alert(1))'
        expect(marked(source)).toEqual([])
        expect(rendered(source)).toBe(source)
    })

    it('leaves a url inside code alone', () => {
        expect(marked('a `https://example.com` b')).toEqual([])
    })
})

describe('asset references', () => {
    it('renders a link to an asset as its label, and carries the reference', () => {
        expect(inlineParts(`the [Q3 report](${PDF}) is in`)).toEqual([
            { kind: 'text', text: 'the ' },
            { kind: 'asset', text: 'Q3 report', ref: PDF },
            { kind: 'text', text: ' is in' },
        ])
    })

    it('treats image syntax over a document as the asset link it is', () => {
        expect(marked(`![Q3 report.pdf](${PDF})`)).toEqual([{ kind: 'asset', text: 'Q3 report.pdf', ref: PDF }])
    })

    it('falls back to the file name when the label is empty', () => {
        expect(marked(`[](${PDF})`)).toEqual([{ kind: 'asset', text: 'q3-report.pdf', ref: PDF }])
    })

    it('keeps a destination with brackets in it whole', () => {
        const ref = '../assets/estimate_(1).a1b2c3d4.pdf'
        expect(marked(`[Estimate](${ref})`)).toEqual([{ kind: 'asset', text: 'Estimate', ref }])
    })

    it('claims both references on one line', () => {
        expect(marked(`[a](${PDF}) and [b](${PDF})`)).toEqual([
            { kind: 'asset', text: 'a', ref: PDF },
            { kind: 'asset', text: 'b', ref: PDF },
        ])
    })

    it('leaves an asset reference inside code as text', () => {
        expect(marked(`a \`[Q3](${PDF})\` b`)).toEqual([])
    })
})

describe('images', () => {
    it('renders a line whose only content is an image as the picture', () => {
        expect(inlineParts(`![Chart](${PNG})`)).toEqual([{ kind: 'image', alt: 'Chart', url: PNG }])
    })

    it('reads the display-size hint out of the alt text', () => {
        expect(inlineParts(`![Chart|300x200](${PNG})`)).toEqual([
            { kind: 'image', alt: 'Chart', url: PNG, maxWidth: 300, maxHeight: 200 },
        ])
    })

    it('renders a remote image on its own line', () => {
        const url = 'https://example.com/a.png'
        expect(inlineParts(`![Pic](${url})`)).toEqual([{ kind: 'image', alt: 'Pic', url }])
    })

    it('keeps a bullet marker the label did not strip', () => {
        expect(inlineParts(`- ![Chart](${PNG})`)).toEqual([
            { kind: 'text', text: '- ' },
            { kind: 'image', alt: 'Chart', url: PNG },
        ])
    })

    it('renders an image written mid-sentence as an asset link, exactly as the editor does', () => {
        expect(marked(`see ![chart](${PNG}) here`)).toEqual([{ kind: 'asset', text: 'chart', ref: PNG }])
    })
})

describe('mixed lines', () => {
    it('claims a wikilink, a hyperlink and an asset on one line, in order', () => {
        expect(marked(`[[Physics]] see [docs](https://example.com) and [Q3](${PDF})`)).toEqual([
            { kind: 'wikilink', text: '[[Physics]]', concept: 'Physics' },
            { kind: 'link', text: 'docs', href: 'https://example.com' },
            { kind: 'asset', text: 'Q3', ref: PDF },
        ])
    })

    it('lets an enclosing wikilink win over a url written inside it', () => {
        expect(marked('[[https://example.com]]')).toEqual([
            { kind: 'wikilink', text: '[[https://example.com]]', concept: 'https://example.com' },
        ])
    })

    // A label holding a `]` is not a link at all: the shared grammar spells a label as
    // everything up to the first `]` (markdown-link-target.ts). The editor reads it the same
    // way, which is the point — the panel must not be more generous than the document it quotes.
    it('refuses a link whose label holds a bracket, exactly as the editor does', () => {
        expect(marked('[see [[Physics]]](https://example.com)')).toEqual([
            { kind: 'wikilink', text: '[[Physics]]', concept: 'Physics' },
            { kind: 'link', text: 'https://example.com', href: 'https://example.com' },
        ])
    })
})

describe('file links', () => {
    it('renders a file link as its text with the native path to copy, in every shape', () => {
        expect(inlineParts('[the report](file:///home/g/My%20Doc.pdf)')).toEqual([
            { kind: 'file-link', text: 'the report', path: '/home/g/My Doc.pdf' },
        ])
        expect(inlineParts('<file:///C:/Users/g/x.txt>')).toEqual([
            { kind: 'file-link', text: 'file:///C:/Users/g/x.txt', path: 'C:\\Users\\g\\x.txt' },
        ])
        expect(inlineParts('see file:///home/g/x.txt now')).toEqual([
            { kind: 'text', text: 'see ' },
            { kind: 'file-link', text: 'file:///home/g/x.txt', path: '/home/g/x.txt' },
            { kind: 'text', text: ' now' },
        ])
    })
})

// The editor styles these constructs and hides their markers off the caret's line
// (markdown-format.ts); a read-only line is always off it.
describe('inline marks', () => {
    it('drops the markers and marks the text, for every mark the editor styles', () => {
        expect(inlineParts('a **bold**, *it*, `code`, ~~gone~~ and ==lit==')).toEqual([
            { kind: 'text', text: 'a ' },
            { kind: 'text', text: 'bold', marks: ['strong'] },
            { kind: 'text', text: ', ' },
            { kind: 'text', text: 'it', marks: ['em'] },
            { kind: 'text', text: ', ' },
            { kind: 'text', text: 'code', marks: ['code'] },
            { kind: 'text', text: ', ' },
            { kind: 'text', text: 'gone', marks: ['strike'] },
            { kind: 'text', text: ' and ' },
            { kind: 'text', text: 'lit', marks: ['highlight'] },
        ])
    })

    it('nests marks, listing them in one order whatever order they were written in', () => {
        expect(inlineParts('***both***')).toEqual([{ kind: 'text', text: 'both', marks: ['strong', 'em'] }])
        expect(inlineParts('~~**x**~~')).toEqual([{ kind: 'text', text: 'x', marks: ['strong', 'strike'] }])
    })

    it('marks a link inside a mark, and keeps it a link', () => {
        expect(inlineParts('**see [[X]]**')).toEqual([
            { kind: 'text', text: 'see ', marks: ['strong'] },
            { kind: 'wikilink', text: '[[X]]', concept: 'X', marks: ['strong'] },
        ])
    })

    it('keeps what is inside inline code as written', () => {
        expect(inlineParts('`**x** [[y]]`')).toEqual([{ kind: 'text', text: '**x** [[y]]', marks: ['code'] }])
    })

    it('leaves an unclosed marker as text', () => {
        expect(inlineParts('a **b')).toEqual([{ kind: 'text', text: 'a **b' }])
    })
})

describe('inline math', () => {
    it('claims a $…$ span with its TeX, as the editor renders it', () => {
        expect(inlineParts('area $\\pi r^2$ here')).toEqual([
            { kind: 'text', text: 'area ' },
            { kind: 'math', text: '$\\pi r^2$', tex: '\\pi r^2' },
            { kind: 'text', text: ' here' },
        ])
    })

    it('leaves a lone price as text', () => {
        expect(inlineParts('costs $5 today')).toEqual([{ kind: 'text', text: 'costs $5 today' }])
    })
})
