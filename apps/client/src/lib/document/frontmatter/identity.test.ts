import { describe, expect, it } from 'vitest'

import {
    FRONTMATTER_PROPERTIES,
    frontmatterIdentity,
    normaliseAliases,
    sameAliases,
    syncedImportText,
    withFrontmatterIdentity,
} from './identity'
import { proposeFrontmatter } from './proposal'

const DOC = '---\ntitle: Kanban\naliases:\n  - Board\ncolour: blue\n---\n\n- body\n'

describe('the property table', () => {
    it('knows title (confirm), aliases (silent) and the publishing keys (read by publish, no editor effect)', () => {
        const policies = Object.fromEntries(FRONTMATTER_PROPERTIES.map((p) => [p.key, p.policy]))
        expect(policies).toEqual({ title: 'confirm', aliases: 'silent', public: 'none', publications: 'none', publication: 'none', includes: 'none', slug: 'none' })
    })
})

describe('frontmatterIdentity', () => {
    it('reads the title and aliases, and says a block is present', () => {
        expect(frontmatterIdentity(DOC)).toEqual({ title: 'Kanban', aliases: ['Board'], hasAliasesKey: true, hasBlock: true, readable: true })
    })

    it('reads a document with no block as having no claim', () => {
        expect(frontmatterIdentity('- body\n')).toEqual({ title: null, aliases: [], hasAliasesKey: false, hasBlock: false, readable: true })
    })

    it('reads a block without a title or aliases as an empty claim', () => {
        expect(frontmatterIdentity('---\ncolour: blue\n---\nx')).toEqual({ title: null, aliases: [], hasAliasesKey: false, hasBlock: true, readable: true })
    })

    it('ignores a blank title and non-string aliases', () => {
        expect(frontmatterIdentity('---\ntitle: "  "\naliases: [1, Real]\n---\n')).toEqual({
            title: null,
            aliases: ['Real'],
            hasAliasesKey: true,
            hasBlock: true,
            readable: true,
        })
    })

    it('reads a block whose YAML does not parse to a mapping as unreadable: identity unknown, not empty', () => {
        expect(frontmatterIdentity('---\ntags: [a]\naliases: [Board]\ntags: [b]\n---\n')).toEqual({
            title: null,
            aliases: [],
            hasAliasesKey: false,
            hasBlock: true,
            readable: false,
        })
        expect(frontmatterIdentity('---\nali\n---\n').readable).toBe(false)
        expect(frontmatterIdentity('---\n---\n').readable).toBe(true)
    })

    it('tells an empty aliases list from no aliases key', () => {
        expect(frontmatterIdentity('---\naliases: []\n---\n').hasAliasesKey).toBe(true)
        expect(frontmatterIdentity('---\ntags: [x]\n---\n').hasAliasesKey).toBe(false)
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

describe('syncedImportText', () => {
    it('strips title and keeps aliases in a block that other keys keep', () => {
        expect(syncedImportText(DOC)).toBe('---\naliases:\n  - Board\ncolour: blue\n---\n\n- body\n')
    })

    it('drops a block that holds nothing but identity keys', () => {
        expect(syncedImportText('---\ntitle: Kanban\n---\n\n- body\n')).toBe('\n- body\n')
        expect(syncedImportText('---\ntitle: Kanban\naliases:\n  - Board\n---\n\n- body\n')).toBe('\n- body\n')
        expect(syncedImportText('---\naliases:\n  - Board\n---\n\n- body\n')).toBe('\n- body\n')
    })

    it('leaves a document without a block, or a block without a title, untouched', () => {
        expect(syncedImportText('- body\n')).toBe('- body\n')
        expect(syncedImportText('---\n---\n- body\n')).toBe('---\n---\n- body\n')
        const untitled = '---\ncolour:   blue\naliases: [Board]\n---\n- body\n'
        expect(syncedImportText(untitled)).toBe(untitled)
    })

    it('leaves a block whose YAML does not parse alone', () => {
        const broken = '---\ntitle: [Kanban\ncolour: blue\n---\n- body\n'
        expect(syncedImportText(broken)).toBe(broken)
    })

    // The import writes the block's aliases to the registry. Had it stripped them from a block
    // that other keys keep, the block would read as "no aliases" and the first edit to it would
    // clear every imported alias without a word.
    it('keeps a block that agrees with the registry the import writes, through a later edit', () => {
        const registry = { kind: 'page' as const, concept: 'Kanban', aliases: frontmatterIdentity(DOC).aliases }
        const stored = syncedImportText(DOC)
        expect(proposeFrontmatter({ text: stored, registry, backend: 'server' })).toEqual([])

        const tagged = stored.replace('colour: blue\n', 'colour: blue\ntags: [work]\n')
        expect(proposeFrontmatter({ text: tagged, registry, backend: 'server' })).toEqual([])
    })
})
