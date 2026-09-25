import { describe, expect, it } from 'vitest'

import { proposeFrontmatter } from './proposal'

const page = (concept: string, aliases: string[] = []) => ({ kind: 'page' as const, concept, aliases })

describe('proposeFrontmatter', () => {
    it('proposes nothing for a document without a block, whatever the registry says', () => {
        expect(proposeFrontmatter({ text: '- body', registry: page('Kanban', ['Old']), backend: 'server' })).toEqual([])
        expect(
            proposeFrontmatter({ text: '- body', registry: page('Kanban'), backend: 'filesystem', fileStem: 'kanban' }),
        ).toEqual([])
    })

    it('proposes nothing when the block agrees with the registry', () => {
        const text = '---\ntitle: Kanban\naliases: [Board]\n---\n'
        expect(proposeFrontmatter({ text, registry: page('Kanban', ['board']), backend: 'server' })).toEqual([])
    })

    it('a changed title is a confirmed step', () => {
        const text = '---\ntitle: Kanban 2\n---\n'
        expect(proposeFrontmatter({ text, registry: page('Kanban'), backend: 'server' })).toEqual([
            { property: 'title', policy: 'confirm', from: 'Kanban', to: 'Kanban 2' },
        ])
    })

    it('changed aliases are a silent step, and come before the title', () => {
        const text = '---\ntitle: Kanban 2\naliases:\n  - Board\n  - Kanban 2\n---\n'
        expect(proposeFrontmatter({ text, registry: page('Kanban', ['Old']), backend: 'server' })).toEqual([
            { property: 'aliases', policy: 'silent', from: ['Old'], to: ['Board', 'Kanban 2'] },
            { property: 'title', policy: 'confirm', from: 'Kanban', to: 'Kanban 2' },
        ])
    })

    it('a block that drops its aliases key clears the aliases', () => {
        const text = '---\ntitle: Kanban\n---\n'
        expect(proposeFrontmatter({ text, registry: page('Kanban', ['Old']), backend: 'server' })).toEqual([
            { property: 'aliases', policy: 'silent', from: ['Old'], to: [] },
        ])
    })

    it('on a local graph a block without a title names the file, so it proposes the file name', () => {
        const text = '---\ncolour: blue\n---\n'
        expect(proposeFrontmatter({ text, registry: page('Kanban 2'), backend: 'filesystem', fileStem: 'kanban-2' })).toEqual([
            { property: 'title', policy: 'confirm', from: 'Kanban 2', to: 'kanban-2' },
        ])
        // ...unless the file name already IS the concept.
        expect(proposeFrontmatter({ text, registry: page('Kanban'), backend: 'filesystem', fileStem: 'Kanban' })).toEqual([])
    })

    it('on a synced graph a block without a title makes no claim about it', () => {
        const text = '---\ncolour: blue\n---\n'
        expect(proposeFrontmatter({ text, registry: page('Kanban'), backend: 'server' })).toEqual([])
    })

    it('a journal entry takes aliases but never a title', () => {
        const text = '---\ntitle: Christmas\naliases: [Xmas]\n---\n'
        expect(
            proposeFrontmatter({ text, registry: { kind: 'journal', concept: '2026-12-25', aliases: [] }, backend: 'server' }),
        ).toEqual([{ property: 'aliases', policy: 'silent', from: [], to: ['Xmas'] }])
    })

    it('a case-only title change is still a proposal', () => {
        const text = '---\ntitle: kanban\n---\n'
        expect(proposeFrontmatter({ text, registry: page('Kanban'), backend: 'server' })).toEqual([
            { property: 'title', policy: 'confirm', from: 'Kanban', to: 'kanban' },
        ])
    })

    it('an alias equal to the document\'s own name is not an alias', () => {
        const text = '---\ntitle: Kanban\naliases: [Kanban, Board]\n---\n'
        expect(proposeFrontmatter({ text, registry: page('Kanban', ['Board']), backend: 'server' })).toEqual([])
    })
})
