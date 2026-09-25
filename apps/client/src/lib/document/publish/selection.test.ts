import { describe, expect, it } from 'vitest'

import { discoverPublications } from './publication'
import { includeStatus, includeUsesOf, publicDocumentsInNoPublication, selectDocuments } from './selection'
import type { PublishDocument } from './types'

function page(concept: string, text: string): PublishDocument {
    return { concept, kind: 'page', text, aliases: [] }
}
function journal(day: string, text: string): PublishDocument {
    return { concept: day, kind: 'journal', text, aliases: [] }
}

const CIPHER = '---\ntitle: Secrets\npublic: true\npublications: [docs]\n---\n```etherpk-cipher\nAQQAAAGY\n```\n'

const docs = [
    page('Docs Site', '---\npublication:\n  id: docs\n---\n- [[Guide]]\n'),
    page('Blog', '---\npublication:\n  id: blog\n  selection: all-public\n---\n'),
    page('Guide', '---\npublic: true\npublications: [docs]\n---\n- the guide\n'),
    page('Both', '---\npublic: true\npublications: [docs, blog]\n---\n- both\n'),
    page('Private', '- nobody sees this\n'),
    page('Public Untagged', '---\npublic: true\n---\n- where do I go\n'),
    page('Secrets', CIPHER),
    page('Typo', '---\npublic: true\npublications: [dcos]\n---\n- typo\n'),
    journal('2026-06-02', '---\npublic: true\n---\n- a public day\n'),
    page('Not Public Named', '---\npublications: [docs]\n---\n- no consent\n'),
]
const { publications } = discoverPublications(docs)
const byId = new Map(publications.map((p) => [p.id, p]))

describe('selectDocuments', () => {
    it('a named publication takes public documents that name it, and nothing else', () => {
        const { included, excluded } = selectDocuments(docs, byId.get('docs')!, publications)
        expect(included.map((d) => d.concept)).toEqual(['Guide', 'Both'])
        const reasons = Object.fromEntries(excluded.map((e) => [e.concept, e.reason]))
        expect(reasons).toEqual({
            'Docs Site': 'publication-page',
            Blog: 'publication-page',
            Private: 'not-public',
            'Public Untagged': 'not-named',
            Secrets: 'protected',
            Typo: 'not-named',
            '2026-06-02': 'not-named',
            'Not Public Named': 'not-public',
        })
    })

    it('an all-public publication takes every public document, list or no list', () => {
        const { included, excluded } = selectDocuments(docs, byId.get('blog')!, publications)
        expect(included.map((d) => d.concept)).toEqual(['Guide', 'Both', 'Public Untagged', 'Typo', '2026-06-02'])
        expect(excluded.find((e) => e.concept === 'Secrets')?.reason).toBe('protected')
    })

    it('protection overrides public before anything else looks, and the report never carries the body', () => {
        const { excluded, issues } = selectDocuments(docs, byId.get('docs')!, publications)
        const secret = excluded.find((e) => e.concept === 'Secrets')
        expect(secret?.reason).toBe('protected')
        expect(JSON.stringify({ excluded, issues })).not.toContain('AQQAAAGY')
    })

    it('warns about a document naming a publication that does not exist', () => {
        const { issues } = selectDocuments(docs, byId.get('docs')!, publications)
        expect(issues).toContainEqual(expect.objectContaining({ code: 'unknown-publication', concept: 'Typo' }))
    })

    it('a document excluded here but public in another publication is reported as published elsewhere', () => {
        const { excluded } = selectDocuments(docs, byId.get('docs')!, publications)
        expect(excluded.find((e) => e.concept === '2026-06-02')?.publishedIn).toEqual(['blog'])
    })

    it('a page named as an include fills its slot and is not a page of its own, but only once it is public and in the publication', () => {
        // The consent rule has no exception for includes (2026-09-19): a footer reaches the site
        // because its page says public and names the publication, like any other content. Named
        // as an include anywhere, it is a snippet for the whole graph, not a page: it does not
        // turn up in search, the sitemap or the index as `site-footer.html`, in this publication
        // or in an all-public one that would otherwise take it.
        const withIncludes = [
            page('Docs Site', '---\npublication:\n  id: docs\n  includes:\n    footer: Site Footer\n    head: Analytics\n    styles: Private Styles\n---\n- [[Guide]]\n'),
            page('Everything', '---\npublication:\n  id: all\n  selection: all-public\n---\n'),
            page('Guide', '---\npublic: true\npublications: [docs]\n---\n- the guide\n'),
            page('Site Footer', '---\npublic: true\npublications: [docs]\naliases: [Footer]\n---\n© [[Guide]]\n'),
            page('Analytics', '---\npublic: true\n---\n<script src="https://x.example/a.js"></script>\n'),
            page('Private Styles', '```css\nbody{}\n```\n'),
        ]
        withIncludes[3].aliases = ['Footer']
        const { publications: pubs } = discoverPublications(withIncludes)
        const docsPub = pubs.find((p) => p.id === 'docs')!
        const allPub = pubs.find((p) => p.id === 'all')!
        const { included, excluded } = selectDocuments(withIncludes, docsPub, pubs)
        expect(included.map((d) => d.concept)).toEqual(['Guide'])
        expect(excluded.find((e) => e.concept === 'Site Footer')).toEqual({ concept: 'Site Footer', reason: 'include-page', includes: [{ publication: 'docs', slot: 'footer' }] })
        // The all-public publication takes Guide and, being public, would take the footer too;
        // it is a snippet, so it stays out of that site as a page as well.
        const everything = selectDocuments(withIncludes, allPub, pubs)
        expect(everything.included.map((d) => d.concept)).toEqual(['Guide'])
        expect(everything.excluded.find((e) => e.concept === 'Site Footer')?.reason).toBe('include-page')
        expect(includeUsesOf(withIncludes[3], pubs)).toEqual([{ publication: 'docs', slot: 'footer' }])
        // Public but not naming the publication, and not public at all: excluded for those reasons, and the slot says why.
        expect(excluded.find((e) => e.concept === 'Analytics')?.reason).toBe('not-named')
        // Analytics is named as the docs head, so it is a snippet everywhere: the all-public
        // publication takes it (it is public) but does not make a page of it either.
        expect(everything.excluded.find((e) => e.concept === 'Analytics')).toEqual({ concept: 'Analytics', reason: 'include-page', includes: [{ publication: 'docs', slot: 'head' }] })
        expect(excluded.find((e) => e.concept === 'Private Styles')?.reason).toBe('not-public')
        expect(includeStatus(withIncludes[3], docsPub)).toBe('ok')
        expect(includeStatus(withIncludes[4], docsPub)).toBe('not-named')
        expect(includeStatus(withIncludes[5], docsPub)).toBe('not-public')
        expect(includeStatus(withIncludes[0], docsPub)).toBe('publication-page')
        // An all-public publication needs only the consent.
        expect(includeStatus(withIncludes[4], { ...docsPub, selection: 'all-public' })).toBe('ok')
        // The alias reaches the same page.
        const byAlias = selectDocuments(withIncludes, { ...docsPub, includes: { footer: 'Footer' } }, pubs)
        expect(byAlias.excluded.find((e) => e.concept === 'Site Footer')?.reason).toBe('include-page')
    })
})

describe('publicDocumentsInNoPublication', () => {
    it('lists public documents no named publication takes when every publication is named', () => {
        const named = publications.filter((p) => p.selection === 'named')
        expect(publicDocumentsInNoPublication(docs, named).map((d) => d.concept)).toEqual([
            'Public Untagged',
            'Typo',
            '2026-06-02',
        ])
    })

    it('is empty when an all-public publication exists', () => {
        expect(publicDocumentsInNoPublication(docs, publications)).toEqual([])
    })
})
