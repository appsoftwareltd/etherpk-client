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

    // A block whose YAML does not parse says nothing yet - most often a line is still being typed
    // when the caret leaves the block. Its identity is unknown rather than empty, so leaving it
    // mid-edit can neither clear the aliases nor propose a rename.
    it('proposes nothing while the block does not parse', () => {
        const unreadable = {
            'a duplicate key': '---\ntags: [a]\naliases: [Board]\ntags: [b]\n---\n',
            'a half-typed line': '---\naliases: [Board]\nsta\n---\n',
            'an unclosed list': '---\naliases: [Board, Bo\n---\n',
            'a half-typed first line': '---\nali\n---\n',
        }
        for (const [what, text] of Object.entries(unreadable)) {
            expect(proposeFrontmatter({ text, registry: page('Kanban', ['Board', 'Old']), backend: 'server' }), what).toEqual([])
            expect(
                proposeFrontmatter({ text, registry: page('Kanban', ['Board']), backend: 'filesystem', fileStem: 'kanban-file' }),
                what,
            ).toEqual([])
        }
    })

    // A block the person typed in this episode, onto a document that had none, has made no claim
    // about aliases unless it names them: a synced page whose old name was kept as an alias has
    // them in the registry only, and typing `tags:` above its body must not clear them.
    it('a block typed in this episode claims no aliases until it has an aliases key', () => {
        const typed = '---\ntags: [x]\n---\n- body'
        expect(proposeFrontmatter({ text: typed, registry: page('Kanban', ['Old']), backend: 'server', blockIsNew: true })).toEqual([])
        // Without the episode's word that the block is new, the missing key still clears them.
        expect(proposeFrontmatter({ text: typed, registry: page('Kanban', ['Old']), backend: 'server' })).toEqual([
            { property: 'aliases', policy: 'silent', from: ['Old'], to: [] },
        ])
        // A new block that does name aliases proposes them, on either backend.
        const named = '---\ntags: [x]\naliases: [Board]\n---\n- body'
        expect(proposeFrontmatter({ text: named, registry: page('Kanban', ['Old']), backend: 'server', blockIsNew: true })).toEqual([
            { property: 'aliases', policy: 'silent', from: ['Old'], to: ['Board'] },
        ])
        expect(proposeFrontmatter({ text: named, registry: page('Kanban'), backend: 'filesystem', fileStem: 'Kanban', blockIsNew: true })).toEqual([
            { property: 'aliases', policy: 'silent', from: [], to: ['Board'] },
        ])
        // On a local graph a document without a block has no aliases, so a new block without the
        // key changes nothing there either; its missing title still names the file, as before.
        expect(proposeFrontmatter({ text: typed, registry: page('Kanban'), backend: 'filesystem', fileStem: 'Kanban', blockIsNew: true })).toEqual([])
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
