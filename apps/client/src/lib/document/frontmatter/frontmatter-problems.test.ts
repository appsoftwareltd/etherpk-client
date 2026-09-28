import { describe, expect, it } from 'vitest'

import { frontmatterProblems } from './frontmatter-problems'

describe('frontmatterProblems', () => {
    it('finds nothing in a good block, an empty one, or a document without one', () => {
        expect(frontmatterProblems('---\ntitle: A\npublic: true\npublications:\n  - docs\nslug: a-page\ndate: 2026-09-28\n---\n', 'page')).toEqual([])
        expect(frontmatterProblems('---\n---\n', 'page')).toEqual([])
        expect(frontmatterProblems('- body\n', 'page')).toEqual([])
    })

    it('reports a block that does not parse, at its line, and says the block is ignored until fixed', () => {
        const [problem, ...rest] = frontmatterProblems('---\ntitle: A\n\tslug: b\n---\n', 'page')
        expect(rest).toEqual([])
        expect(problem).toMatchObject({ level: 'error', line: 2 })
        expect(problem.message).toContain('tab')
        expect(problem.message).toContain('ignores')
    })

    it('names a duplicated key in words a person reads', () => {
        const [problem] = frontmatterProblems('---\ntitle: A\ntitle: B\n---\n', 'page')
        expect(problem).toMatchObject({ level: 'error', line: 2 })
        expect(problem.message).toContain('twice')
    })

    it('warns about a quoted `public`, at the `public` line', () => {
        const problems = frontmatterProblems('---\ntitle: A\npublic: "true"\n---\n', 'page')
        expect(problems).toEqual([expect.objectContaining({ level: 'warning', line: 2 })])
        expect(problems[0].message).toContain('public: true')
    })

    it('reports the publisher’s own problems with publications and a publication, at the key they are about', () => {
        const members = frontmatterProblems('---\npublications:\n  a: 1\n---\n', 'page')
        expect(members).toEqual([expect.objectContaining({ level: 'warning', line: 1 })])
        const definition = frontmatterProblems('---\ntitle: Docs\npublication:\n  id: Docs Site\n  kind: wiki\n---\n', 'page')
        expect(definition.map((p) => [p.level, p.line])).toEqual([
            ['error', 3],
            ['error', 4],
        ])
    })

    it('warns about a date that is not a day, a slug with nothing usable, and aliases that are not a list', () => {
        const problems = frontmatterProblems('---\ndate: next week\nslug: "???"\naliases: Board\n---\n', 'page')
        expect(problems.map((p) => [p.level, p.line])).toEqual([
            ['warning', 1],
            ['warning', 2],
            ['warning', 3],
        ])
    })

    it('says a journal entry’s title means nothing, since a day is named by its date', () => {
        const problems = frontmatterProblems('---\ntitle: My day\n---\n', 'journal')
        expect(problems).toEqual([expect.objectContaining({ level: 'warning', line: 1 })])
    })

    it('finds nothing wrong with empty values: they are not set yet', () => {
        expect(frontmatterProblems('---\ntitle: A\naliases:\npublic:\npublications:\nslug:\ndate:\npublication:\n  id:\n  kind:\n---\n', 'page')).toEqual([])
    })
})
