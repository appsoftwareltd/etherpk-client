import { describe, expect, it } from 'vitest'

import { renderTree } from './markdown'

describe("a reply's markdown as nodes to draw, never as HTML (ADR 0147)", () => {
    it('reads paragraphs, emphasis, code and a heading', () => {
        expect(renderTree('## Beans\n\nWater **daily**, *early*, with `can`.')).toEqual([
            { kind: 'heading', level: 2, children: [{ kind: 'text', text: 'Beans' }] },
            {
                kind: 'paragraph',
                children: [
                    { kind: 'text', text: 'Water ' },
                    { kind: 'strong', children: [{ kind: 'text', text: 'daily' }] },
                    { kind: 'text', text: ', ' },
                    { kind: 'em', children: [{ kind: 'text', text: 'early' }] },
                    { kind: 'text', text: ', with ' },
                    { kind: 'code', text: 'can' },
                    { kind: 'text', text: '.' },
                ],
            },
        ])
    })

    it('turns a wikilink into a link to the document, a scoped one whole, and leaves one in code as code', () => {
        expect(renderTree('See [[Garden]] and [[[[Garden]] Beds]], not `[[Shed]]`.')).toEqual([
            {
                kind: 'paragraph',
                children: [
                    { kind: 'text', text: 'See ' },
                    { kind: 'wikilink', name: 'Garden' },
                    { kind: 'text', text: ' and ' },
                    { kind: 'wikilink', name: '[[Garden]] Beds' },
                    { kind: 'text', text: ', not ' },
                    { kind: 'code', text: '[[Shed]]' },
                    { kind: 'text', text: '.' },
                ],
            },
        ])
    })

    it('keeps a code block whole, wikilink-looking text included', () => {
        expect(renderTree('```ts\nconst a = "[[Garden]]"\n```')).toEqual([{ kind: 'codeblock', lang: 'ts', text: 'const a = "[[Garden]]"\n' }])
    })

    it('shows raw HTML as text', () => {
        const tree = renderTree('<img src="https://example.com/x.png" onerror="alert(1)">')
        expect(tree).toEqual([{ kind: 'paragraph', children: [{ kind: 'text', text: '<img src="https://example.com/x.png" onerror="alert(1)">' }] }])
    })

    it('never loads a remote image: it becomes a link to it', () => {
        expect(renderTree('![a chart](https://example.com/chart.png?q=secret)')).toEqual([{ kind: 'paragraph', children: [{ kind: 'image-link', href: 'https://example.com/chart.png?q=secret', alt: 'a chart' }] }])
    })

    it('keeps only web and mail links as links', () => {
        const [paragraph] = renderTree('[site](https://example.com) and [bad](javascript:alert(1)) and [files](ftp://example.com/x)')
        expect(paragraph).toEqual({
            kind: 'paragraph',
            children: [
                { kind: 'link', href: 'https://example.com/', children: [{ kind: 'text', text: 'site' }] },
                // markdown-it refuses a script address outright, and an address that is neither web
                // nor mail keeps only its label.
                { kind: 'text', text: ' and [bad](javascript:alert(1)) and files' },
            ],
        })
    })

    it('reads lists, nested, numbered from where they start', () => {
        expect(renderTree('3. Dig\n4. Sow\n   - beans')).toEqual([
            {
                kind: 'list',
                ordered: true,
                start: 3,
                items: [[{ kind: 'paragraph', children: [{ kind: 'text', text: 'Dig' }] }], [{ kind: 'paragraph', children: [{ kind: 'text', text: 'Sow' }] }, { kind: 'list', ordered: false, start: 1, items: [[{ kind: 'paragraph', children: [{ kind: 'text', text: 'beans' }] }]] }]],
            },
        ])
    })

    it('reads a table', () => {
        expect(renderTree('| Bed | Crop |\n| --- | --- |\n| A | beans |')).toEqual([
            { kind: 'table', head: [[{ kind: 'text', text: 'Bed' }], [{ kind: 'text', text: 'Crop' }]], rows: [[[{ kind: 'text', text: 'A' }], [{ kind: 'text', text: 'beans' }]]] },
        ])
    })
})
