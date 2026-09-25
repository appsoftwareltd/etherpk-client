import { describe, expect, it } from 'vitest'

import {
    FRONTMATTER_PROPERTIES,
    frontmatterIdentity,
    normaliseAliases,
    sameAliases,
    withFrontmatterIdentity,
    withoutIdentityKeys,
} from './identity'

const DOC = '---\ntitle: Kanban\naliases:\n  - Board\ncolour: blue\n---\n\n- body\n'

describe('the property table', () => {
    it('knows title (confirm), aliases (silent) and the publishing keys (read by publish, no editor effect)', () => {
        const policies = Object.fromEntries(FRONTMATTER_PROPERTIES.map((p) => [p.key, p.policy]))
        expect(policies).toEqual({ title: 'confirm', aliases: 'silent', public: 'none', publications: 'none', publication: 'none', includes: 'none', slug: 'none' })
    })
})

describe('frontmatterIdentity', () => {
    it('reads the title and aliases, and says a block is present', () => {
        expect(frontmatterIdentity(DOC)).toEqual({ title: 'Kanban', aliases: ['Board'], hasBlock: true })
    })

    it('reads a document with no block as having no claim', () => {
        expect(frontmatterIdentity('- body\n')).toEqual({ title: null, aliases: [], hasBlock: false })
    })

    it('reads a block without a title or aliases as an empty claim', () => {
        expect(frontmatterIdentity('---\ncolour: blue\n---\nx')).toEqual({ title: null, aliases: [], hasBlock: true })
    })

    it('ignores a blank title and non-string aliases', () => {
        expect(frontmatterIdentity('---\ntitle: "  "\naliases: [1, Real]\n---\n')).toEqual({
            title: null,
            aliases: ['Real'],
            hasBlock: true,
        })
    })

    it('treats an unterminated block as no block', () => {
        expect(frontmatterIdentity('---\ntitle: A\nstill typing').hasBlock).toBe(false)
    })
})

describe('normaliseAliases / sameAliases', () => {
    it('trims, drops blanks, dedupes case-insensitively and drops the concept itself', () => {
        expect(normaliseAliases([' Board ', '', 'board', 'Kanban', 'Other'], 'Kanban')).toEqual(['Board', 'Other'])
    })

    it('compares as sets, case-insensitively', () => {
        expect(sameAliases(['A', 'b'], ['B', 'a'])).toBe(true)
        expect(sameAliases(['A'], ['A', 'B'])).toBe(false)
    })
})

describe('withFrontmatterIdentity', () => {
    it('rewrites the title in place, keeping other keys and the body', () => {
        const next = withFrontmatterIdentity(DOC, { title: 'Kanban 2' })
        expect(next).toBe('---\ntitle: Kanban 2\naliases:\n  - Board\ncolour: blue\n---\n\n- body\n')
    })

    it('rewrites aliases, and removes the key when they are empty', () => {
        expect(withFrontmatterIdentity(DOC, { aliases: ['Board', 'Kanban'] })).toContain('aliases:\n  - Board\n  - Kanban\n')
        expect(withFrontmatterIdentity(DOC, { aliases: [] })).toBe('---\ntitle: Kanban\ncolour: blue\n---\n\n- body\n')
    })

    it('adds a missing title first and missing aliases last', () => {
        const next = withFrontmatterIdentity('---\ncolour: blue\n---\nx', { title: 'T', aliases: ['A'] })
        expect(next).toBe('---\ntitle: T\ncolour: blue\naliases:\n  - A\n---\nx')
    })

    it('returns the text untouched when the identity already matches, even if the YAML is styled differently', () => {
        const flow = '---\ntitle: Kanban\naliases: [Board]\n---\nx'
        expect(withFrontmatterIdentity(flow, { title: 'Kanban', aliases: ['Board'] })).toBe(flow)
    })

    it('adds no block by default, and adds one when asked', () => {
        expect(withFrontmatterIdentity('x', { title: 'T' })).toBe('x')
        expect(withFrontmatterIdentity('x', { title: 'T' }, { addBlock: true })).toBe('---\ntitle: T\n---\nx')
        expect(withFrontmatterIdentity('x', { aliases: [] }, { addBlock: true })).toBe('x')
    })

    it('removes the title when asked to, leaving the rest', () => {
        expect(withFrontmatterIdentity(DOC, { title: null })).toBe('---\naliases:\n  - Board\ncolour: blue\n---\n\n- body\n')
    })

    it('leaves a malformed block alone rather than destroying it', () => {
        const broken = '---\ntitle: [unclosed\n---\nx'
        expect(withFrontmatterIdentity(broken, { title: 'T' })).toBe(broken)
    })
})

describe('withoutIdentityKeys', () => {
    it('strips title and aliases and keeps the rest of the block', () => {
        expect(withoutIdentityKeys(DOC)).toBe('---\ncolour: blue\n---\n\n- body\n')
    })

    it('drops the block entirely when nothing else is in it', () => {
        expect(withoutIdentityKeys('---\ntitle: Kanban\n---\n\n- body\n')).toBe('\n- body\n')
    })

    it('leaves a document without a block untouched', () => {
        expect(withoutIdentityKeys('- body\n')).toBe('- body\n')
    })
})
