import { describe, expect, it } from 'vitest'

import { canAddFrontmatter, planAddFrontmatter, withAddedFrontmatter } from './add-frontmatter'

const identity = { title: 'Kanban', aliases: [] as string[] }

describe('planAddFrontmatter', () => {
    it('offers every key a page can carry, in order, each with its summary', () => {
        const plan = planAddFrontmatter('- body\n', 'page')
        expect(plan.kind).toBe('choices')
        if (plan.kind !== 'choices') return
        expect(plan.choices.map((c) => c.key)).toEqual(['title', 'aliases', 'public', 'publications', 'slug', 'date', 'publication'])
        expect(plan.choices.every((c) => !c.present && c.summary.length > 0)).toBe(true)
    })

    it('offers a journal entry only the keys a day can use', () => {
        const plan = planAddFrontmatter('- body\n', 'journal')
        expect(plan.kind === 'choices' && plan.choices.map((c) => c.key)).toEqual(['aliases', 'public', 'publications', 'slug'])
    })

    it('marks the keys the block already names, empty or not', () => {
        const plan = planAddFrontmatter('---\ntitle: Kanban\nslug:\nstatus: draft\n---\n', 'page')
        expect(plan.kind === 'choices' && plan.choices.filter((c) => c.present).map((c) => c.key)).toEqual(['title', 'slug'])
    })

    it('reports a block that does not parse, with the parser’s message and the line to fix', () => {
        const plan = planAddFrontmatter('---\ntitle: Kanban\ntags: [a\n---\n', 'page')
        expect(plan.kind).toBe('unreadable')
        if (plan.kind !== 'unreadable') return
        expect(plan.line).toBe(2)
        expect(plan.message.length).toBeGreaterThan(0)
    })
})

describe('canAddFrontmatter', () => {
    it('is true while any key is missing, and false once every one is there', () => {
        expect(canAddFrontmatter('- body\n', 'journal')).toBe(true)
        expect(canAddFrontmatter('---\naliases:\npublic: false\npublications:\nslug:\n---\n', 'journal')).toBe(false)
    })

    it('is true for a block that does not parse, so the action can say what is wrong', () => {
        expect(canAddFrontmatter('---\na: [\n---\n', 'journal')).toBe(true)
    })
})

describe('withAddedFrontmatter', () => {
    it('gives a document with no block one holding the chosen keys, each inert', () => {
        const added = withAddedFrontmatter('- body\n', ['title', 'aliases', 'public', 'publications', 'slug', 'date'], identity)
        expect(added.text).toBe('---\ntitle: Kanban\naliases:\npublic: false\npublications:\nslug:\ndate:\n---\n- body\n')
    })

    it('writes the current aliases, and the publication outline with every value empty', () => {
        const added = withAddedFrontmatter('- body\n', ['aliases', 'publication'], { title: 'Docs', aliases: ['Board', 'Kan'] })
        expect(added.text).toBe(
            '---\naliases:\n  - Board\n  - Kan\npublication:\n  id:\n  kind:\n  selection:\n  url:\n  home:\n  theme:\n  recent:\n  includes:\n---\n- body\n',
        )
    })

    it('adds only the missing keys, after the existing ones, and never changes a value', () => {
        const text = '---\n# mine\nstatus: draft\npublic: true\n---\n- body\n'
        const added = withAddedFrontmatter(text, ['title', 'public', 'slug'], identity)
        expect(added.text).toBe('---\n# mine\nstatus: draft\npublic: true\ntitle: Kanban\nslug:\n---\n- body\n')
    })

    it('puts the caret at the end of the first value it added', () => {
        const text = '---\nstatus: draft\n---\n- body\n'
        const added = withAddedFrontmatter(text, ['public', 'slug'], identity)
        expect(added.text.slice(0, added.caret!)).toBe('---\nstatus: draft\npublic: false')
        expect(added.line).toBe(2)
    })

    it('puts the caret on the first item of a list or the first setting of a mapping', () => {
        const list = withAddedFrontmatter('', ['aliases'], { title: 'A', aliases: ['B'] })
        expect(list.text.slice(0, list.caret!)).toBe('---\naliases:\n  - B')
        const mapping = withAddedFrontmatter('', ['publication'], identity)
        expect(mapping.text.slice(0, mapping.caret!)).toBe('---\npublication:\n  id:')
    })

    it('changes nothing when every chosen key is already there, or the block does not parse', () => {
        const text = '---\npublic: true\n---\n'
        expect(withAddedFrontmatter(text, ['public'], identity)).toEqual({ text, caret: null, line: null })
        const bad = '---\na: [\n---\n'
        expect(withAddedFrontmatter(bad, ['public'], identity)).toEqual({ text: bad, caret: null, line: null })
    })
})
