import { describe, expect, it } from 'vitest'

import { buildNav } from './nav'
import { createPublicationResolver } from './resolve'
import type { PublishDocument } from './types'

function page(concept: string): PublishDocument {
    return { concept, kind: 'page', text: '---\npublic: true\n---\n- x\n', aliases: [] }
}

const included = [page('Getting Started'), page('Installing'), page('[[Editor]] Keybindings'), page('Editor')]
const resolver = createPublicationResolver({
    included,
    allDocuments: [...included, page('Secret')],
    slugs: new Map([
        ['getting started', 'getting-started'],
        ['installing', 'installing'],
        ['[[editor]] keybindings', 'editor-keybindings'],
        ['editor', 'editor'],
    ]),
})

describe('buildNav', () => {
    it('turns the outline into a tree: wikilink bullets are entries, text bullets and headings are groups', () => {
        const outline = [
            '- [[Getting Started]]',
            '  - [[Installing]]',
            '- Reference',
            '  - [[[[Editor]] Keybindings]]',
            '',
            '## More',
            '',
            '- [Source](https://example.com/etherpk)',
            '',
        ].join('\n')
        const { nav, issues } = buildNav(outline, resolver)
        expect(issues).toEqual([])
        expect(nav).toEqual([
            {
                label: 'Getting Started',
                labelHtml: 'Getting Started',
                href: 'getting-started.html',
                concept: 'Getting Started',
                children: [{ label: 'Installing', labelHtml: 'Installing', href: 'installing.html', concept: 'Installing', children: [] }],
            },
            {
                label: 'Reference',
                labelHtml: 'Reference',
                children: [
                    {
                        label: 'Editor Keybindings',
                        labelHtml: '<a href="editor.html" class="wikilink">Editor</a><a href="editor-keybindings.html" class="wikilink"> Keybindings</a>',
                        href: 'editor-keybindings.html',
                        concept: '[[Editor]] Keybindings',
                        children: [],
                    },
                ],
            },
            {
                label: 'More',
                labelHtml: 'More',
                children: [
                    { label: 'Source', labelHtml: 'Source', href: 'https://example.com/etherpk', external: true, children: [] },
                ],
            },
        ])
    })

    it('drops an entry whose document is not in the publication, and says so', () => {
        const { nav, issues } = buildNav('- [[Secret]]\n- [[Nowhere]]\n- [[Installing]]\n', resolver)
        expect(nav.map((n) => n.label)).toEqual(['Installing'])
        expect(issues).toEqual([
            expect.objectContaining({ code: 'nav-entry-not-published', message: expect.stringContaining('Secret') }),
            expect.objectContaining({ code: 'nav-entry-not-published', message: expect.stringContaining('Nowhere') }),
        ])
    })

    it('a bullet that is not exactly one wikilink is a group label, brackets stripped', () => {
        const { nav } = buildNav('- Read [[Installing]] first\n  - [[Installing]]\n', resolver)
        expect(nav[0].label).toBe('Read Installing first')
        expect(nav[0].href).toBeUndefined()
        expect(nav[0].children[0].href).toBe('installing.html')
    })

    it('an empty outline is an empty nav', () => {
        expect(buildNav('', resolver)).toEqual({ nav: [], issues: [] })
    })
})
