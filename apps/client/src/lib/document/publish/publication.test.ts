import { describe, expect, it } from 'vitest'

import { discoverPublications, includeFactsOf, readMembership, readPublicationDefinition } from './publication'
import type { PublishDocument } from './types'

function page(concept: string, text: string): PublishDocument {
    return { concept, kind: 'page', text, aliases: [] }
}

describe('readMembership', () => {
    it('is public only when the frontmatter says `public: true`', () => {
        expect(readMembership('---\npublic: true\n---\n- hi\n').isPublic).toBe(true)
        expect(readMembership('---\npublic: false\n---\n- hi\n').isPublic).toBe(false)
        expect(readMembership('---\npublic: yes please\n---\n- hi\n').isPublic).toBe(false)
        expect(readMembership('- no block\n').isPublic).toBe(false)
    })

    it('reads the publications a document names, and reports entries that are not ids', () => {
        const m = readMembership('---\npublic: true\npublications:\n  - docs\n  - blog\n  - Not An Id\n---\n')
        expect(m.publications).toEqual(['docs', 'blog'])
        expect(m.issues.map((i) => i.code)).toEqual(['publications-invalid-id'])
    })

    it('treats a scalar `publications` as one id, and anything else as none', () => {
        expect(readMembership('---\npublications: docs\n---\n').publications).toEqual(['docs'])
        const m = readMembership('---\npublications:\n  a: 1\n---\n')
        expect(m.publications).toEqual([])
        expect(m.issues.map((i) => i.code)).toEqual(['publications-not-a-list'])
    })
})

describe('includeFactsOf', () => {
    it('lists the snippets a publication page names, one fact per slot, and nothing for other pages', () => {
        expect(includeFactsOf(page('Docs', '---\npublication:\n  id: docs\n  includes:\n    footer: Site Footer\n    head: Analytics\n---\n'))).toEqual([
            { publication: 'docs', slot: 'footer', concept: 'Site Footer' },
            { publication: 'docs', slot: 'head', concept: 'Analytics' },
        ])
        expect(includeFactsOf(page('Docs', '---\npublication:\n  id: docs\n---\n'))).toEqual([])
        expect(includeFactsOf(page('Plain', '---\npublic: true\n---\nbody'))).toEqual([])
        // An invalid definition defines nothing, so it names nothing either.
        expect(includeFactsOf(page('Bad', '---\npublication:\n  id: Not An Id\n  includes:\n    footer: Site Footer\n---\n'))).toEqual([])
    })
})

describe('readPublicationDefinition', () => {
    it('reads a full definition, defaulting what the page leaves out', () => {
        const doc = page(
            'Docs Site',
            '---\ntitle: Docs Site\npublication:\n  id: docs\n---\n- [[Getting Started]]\n',
        )
        const { publication, issues } = readPublicationDefinition(doc)
        expect(issues).toEqual([])
        expect(publication).toEqual({
            id: 'docs',
            name: 'Docs Site',
            concept: 'Docs Site',
            kind: 'docs',
            selection: 'named',
            theme: 'etherpk-docs',
            recent: 10,
            includes: {},
            outline: '- [[Getting Started]]\n',
        })
    })

    it('reads every key, and the blog kind defaults to the blog theme', () => {
        const doc = page(
            'Blog',
            [
                '---',
                'publication:',
                '  id: blog',
                '  kind: blog',
                '  selection: all-public',
                '  home: Welcome',
                '  url: https://blog.example.com/',
                '  recent: 5',
                '  includes:',
                '    footer: Blog Footer',
                '    head: Blog Head',
                '---',
                '- [[About]]',
                '',
            ].join('\n'),
        )
        const { publication } = readPublicationDefinition(doc)
        expect(publication).toMatchObject({
            id: 'blog',
            kind: 'blog',
            selection: 'all-public',
            home: 'Welcome',
            url: 'https://blog.example.com',
            theme: 'etherpk-blog',
            recent: 5,
            includes: { footer: 'Blog Footer', head: 'Blog Head' },
        })
    })

    it('defaults the front page to ten recent posts, and refuses a count that is not a whole number above zero', () => {
        expect(readPublicationDefinition(page('B', '---\npublication:\n  id: blog\n  kind: blog\n---\n')).publication?.recent).toBe(10)
        for (const bad of ['0', '-1', '2.5', 'many']) {
            const { publication, issues } = readPublicationDefinition(page('B', `---\npublication:\n  id: blog\n  recent: ${bad}\n---\n`))
            expect(publication, bad).toBeNull()
            expect(issues.map((i) => i.code)).toEqual(['publication-invalid-recent'])
        }
    })

    it('is nothing for a page without the key', () => {
        expect(readPublicationDefinition(page('A', '---\npublic: true\n---\n')).publication).toBeNull()
    })

    it('tells a member that wrote `publication: docs` which key it meant', () => {
        const { publication, issues } = readPublicationDefinition(page('A', '---\npublication: docs\n---\n'))
        expect(publication).toBeNull()
        expect(issues).toEqual([
            expect.objectContaining({ level: 'error', code: 'publication-not-a-mapping', concept: 'A' }),
        ])
        expect(issues[0].message).toContain('publications: [docs]')
    })

    it('refuses an id that is not kebab-case, a bad kind, selection or url', () => {
        const { publication, issues } = readPublicationDefinition(
            page('A', '---\npublication:\n  id: Docs Site\n  kind: wiki\n  selection: some\n  url: ftp://x\n---\n'),
        )
        expect(publication).toBeNull()
        expect(issues.map((i) => i.code).sort()).toEqual(
            ['publication-invalid-id', 'publication-invalid-kind', 'publication-invalid-selection', 'publication-invalid-url'].sort(),
        )
    })

    it('needs an id', () => {
        const { publication, issues } = readPublicationDefinition(page('A', '---\npublication:\n  kind: docs\n---\n'))
        expect(publication).toBeNull()
        expect(issues.map((i) => i.code)).toEqual(['publication-missing-id'])
    })

    it('keeps a theme reference as written, whether a name, a url or a graph theme id', () => {
        const { publication } = readPublicationDefinition(
            page('A', '---\npublication:\n  id: a\n  theme: https://example.com/theme/theme.json\n---\n'),
        )
        expect(publication?.theme).toBe('https://example.com/theme/theme.json')
    })

    it('drops an include whose value is not a concept name, with a warning', () => {
        const { publication, issues } = readPublicationDefinition(
            page('A', '---\npublication:\n  id: a\n  includes:\n    footer: 12\n    head: Site Head\n---\n'),
        )
        expect(publication?.includes).toEqual({ head: 'Site Head' })
        expect(issues.map((i) => i.code)).toEqual(['publication-invalid-include'])
    })
})

describe('discoverPublications', () => {
    it('finds every publication page and skips the rest', () => {
        const docs = [
            page('Docs Site', '---\npublication:\n  id: docs\n---\n'),
            page('Note', '---\npublic: true\n---\n- hi\n'),
            page('Blog', '---\npublication:\n  id: blog\n  kind: blog\n---\n'),
        ]
        const { publications, issues } = discoverPublications(docs)
        expect(publications.map((p) => p.id)).toEqual(['blog', 'docs'])
        expect(issues).toEqual([])
    })

    it('reports two pages claiming one id and takes neither', () => {
        const docs = [
            page('One', '---\npublication:\n  id: docs\n---\n'),
            page('Two', '---\npublication:\n  id: docs\n---\n'),
            page('Three', '---\npublication:\n  id: blog\n---\n'),
        ]
        const { publications, issues } = discoverPublications(docs)
        expect(publications.map((p) => p.id)).toEqual(['blog'])
        expect(issues).toEqual([
            expect.objectContaining({ code: 'publication-duplicate-id', concept: 'One' }),
            expect.objectContaining({ code: 'publication-duplicate-id', concept: 'Two' }),
        ])
    })

    it('never takes a journal entry as a publication page', () => {
        const journal: PublishDocument = {
            concept: '2026-06-02',
            kind: 'journal',
            text: '---\npublication:\n  id: docs\n---\n- hi\n',
            aliases: [],
        }
        const { publications, issues } = discoverPublications([journal])
        expect(publications).toEqual([])
        expect(issues.map((i) => i.code)).toEqual(['publication-on-journal'])
    })
})
