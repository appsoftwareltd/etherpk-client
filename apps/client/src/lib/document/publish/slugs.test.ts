import { describe, expect, it } from 'vitest'

import { RESERVED_SLUGS, allocateSlugs, explicitSlugOf } from './slugs'
import type { PublishDocument } from './types'

function doc(concept: string, kind: 'page' | 'journal' = 'page', text = ''): PublishDocument {
    return { concept, kind, text, aliases: [] }
}

describe('allocateSlugs', () => {
    it('slugs a page by its concept and a journal entry by its day', () => {
        const slugs = allocateSlugs([doc('Quantum Mechanics'), doc('2026-06-02', 'journal')])
        expect(slugs.get('quantum mechanics')).toBe('quantum-mechanics')
        expect(slugs.get('2026-06-02')).toBe('2026-06-02')
    })

    it('a scoped concept slugs its whole name, brackets dropped', () => {
        expect(allocateSlugs([doc('[[Physics]] Quantum Mechanics')]).get('[[physics]] quantum mechanics')).toBe(
            'physics-quantum-mechanics',
        )
    })

    it('suffixes collisions deterministically, later-ordered documents getting the suffix', () => {
        const slugs = allocateSlugs([doc('Notes'), doc('notes!'), doc('Notes?')])
        expect(slugs.get('notes')).toBe('notes')
        expect(slugs.get('notes!')).toBe('notes-2')
        expect(slugs.get('notes?')).toBe('notes-3')
    })

    it('keeps the generated files\' names free, and never emits an empty slug', () => {
        const slugs = allocateSlugs([doc('Index'), doc('404'), doc('Journal'), doc('Search'), doc('???')])
        for (const reserved of RESERVED_SLUGS) expect([...slugs.values()]).not.toContain(reserved)
        expect(slugs.get('index')).toBe('index-2')
        expect(slugs.get('404')).toBe('404-2')
        expect(slugs.get('???')).toBe('page')
    })

    it('reports which documents were renamed on collision', () => {
        const { collisions } = allocateSlugs.withReport([doc('Notes'), doc('notes!')])
        expect(collisions).toEqual([{ concept: 'notes!', wanted: 'notes', slug: 'notes-2', explicit: false }])
    })

    it('a `slug:` in the frontmatter overrides the derived slug, normalised the same way', () => {
        const slugs = allocateSlugs([
            doc('[[Docs]] Privacy Policy', 'page', '---\ntitle: "[[Docs]] Privacy Policy"\nslug: Privacy Policy\n---\n'),
            doc('2026-06-02', 'journal', '---\nslug: launch-day\n---\n- day\n'),
        ])
        expect(slugs.get('[[docs]] privacy policy')).toBe('privacy-policy')
        expect(slugs.get('2026-06-02')).toBe('launch-day')
    })

    it('an explicit slug wins over a derived one whatever the order, and two explicit ones are suffixed with a report', () => {
        const { slugs, collisions } = allocateSlugs.withReport([
            doc('Privacy Policy'),
            doc('Legal', 'page', '---\nslug: privacy-policy\n---\n'),
            doc('Terms', 'page', '---\nslug: privacy-policy\n---\n'),
        ])
        expect(slugs.get('legal')).toBe('privacy-policy')
        expect(slugs.get('terms')).toBe('privacy-policy-2')
        expect(slugs.get('privacy policy')).toBe('privacy-policy-3')
        expect(collisions).toEqual([
            { concept: 'Terms', wanted: 'privacy-policy', slug: 'privacy-policy-2', explicit: true },
            { concept: 'Privacy Policy', wanted: 'privacy-policy', slug: 'privacy-policy-3', explicit: false },
        ])
    })

    it('an explicit slug that is reserved or empties is ignored and reported', () => {
        const { slugs, ignored } = allocateSlugs.withReport([
            doc('Home', 'page', '---\nslug: index\n---\n'),
            doc('Odd', 'page', '---\nslug: "???"\n---\n'),
            doc('Listy', 'page', '---\nslug: [a]\n---\n'),
        ])
        expect(slugs.get('home')).toBe('home')
        expect(slugs.get('odd')).toBe('odd')
        expect(ignored.map((i) => i.concept)).toEqual(['Home', 'Odd', 'Listy'])
    })
})

describe('explicitSlugOf', () => {
    it('reads and normalises the key', () => {
        expect(explicitSlugOf('---\nslug: My Page\n---\n')).toBe('my-page')
        expect(explicitSlugOf('- no block\n')).toBeNull()
        expect(explicitSlugOf('---\nslug: 12\n---\n')).toBe('12')
    })
})
