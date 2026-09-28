import { describe, expect, it } from 'vitest'

import { completionContext, rankFrontmatterItems } from './frontmatter-complete-core'

/** The context for a block written with `|` at the caret, and the lines of the block. */
function at(text: string) {
    const caret = text.indexOf('|')
    const doc = text.replace('|', '')
    return { doc, ctx: completionContext(doc, caret) }
}

const none = { graphKeys: [], graphValues: () => [] }

describe('completionContext', () => {
    it('is a key once a character is typed at the start of a line in the block', () => {
        expect(at('---\npu|\n---\n').ctx).toEqual({ kind: 'key', parent: null, from: 4, to: 6, prefix: 'pu' })
        expect(at('---\n|\n---\n').ctx).toBeNull()
    })

    it('is a publication setting under `publication:`', () => {
        expect(at('---\npublication:\n  ki|\n---\n').ctx).toMatchObject({ kind: 'key', parent: 'publication', prefix: 'ki' })
    })

    it('is a value after `key: `, and a list item’s value under its key', () => {
        expect(at('---\npublic: t|\n---\n').ctx).toMatchObject({ kind: 'value', key: 'public', prefix: 't' })
        expect(at('---\npublication:\n  kind: b|\n---\n').ctx).toMatchObject({ kind: 'value', key: 'publication.kind', prefix: 'b' })
        expect(at('---\npublications:\n  - do|\n---\n').ctx).toMatchObject({ kind: 'value', key: 'publications', prefix: 'do' })
    })

    it('is nothing outside the block, on a delimiter, in a comment, or before the end of a line', () => {
        expect(at('---\ntitle: A\n---\npu|\n').ctx).toBeNull()
        expect(at('---\n# pu|\n---\n').ctx).toBeNull()
        expect(at('---\npu|blic: true\n---\n').ctx).toBeNull()
    })
})

describe('rankFrontmatterItems', () => {
    it('offers no other document’s value for a key that names this one alone', () => {
        const graphValues = () => [{ value: 'privacy-policy', documents: 1 }]
        for (const text of ['---\nslug: p|\n---\n', '---\npublication:\n  id: p|\n---\n', '---\naliases:\n  - p|\n---\n']) {
            const { doc, ctx } = at(text)
            expect(rankFrontmatterItems(doc, ctx!, { graphKeys: [], graphValues })).toEqual([])
        }
    })

    it('offers EtherPK’s keys first, each with its summary, then the graph’s, never one the block has', () => {
        const { doc, ctx } = at('---\npublic: true\np|\n---\n')
        const items = rankFrontmatterItems(doc, ctx!, { graphKeys: [{ key: 'project', documents: 3 }, { key: 'publications', documents: 9 }, { key: 'title', documents: 20 }], graphValues: () => [] })
        expect(items.map((i) => i.label)).toEqual(['publications', 'publication', 'project'])
        expect(items[0].insert).toBe('publications: ')
        expect(items[0].detail?.length).toBeGreaterThan(0)
        expect(items[2].detail).toBe('3 documents')
    })

    it('offers the settings a publication takes', () => {
        const { doc, ctx } = at('---\npublication:\n  id: docs\n  s|\n---\n')
        expect(rankFrontmatterItems(doc, ctx!, none).map((i) => i.label)).toEqual(['selection'])
    })

    it('offers true and false for `public`, and the fixed choices of a publication', () => {
        let { doc, ctx } = at('---\npublic: f|\n---\n')
        expect(rankFrontmatterItems(doc, ctx!, none).map((i) => i.insert)).toEqual(['false'])
        ;({ doc, ctx } = at('---\npublication:\n  selection: a|\n---\n'))
        expect(rankFrontmatterItems(doc, ctx!, none).map((i) => i.insert)).toEqual(['all-public'])
    })

    it('offers the graph’s publication ids for `publications`, and the values a key already has elsewhere', () => {
        let { doc, ctx } = at('---\npublications:\n  - d|\n---\n')
        const graphValues = (key: string) => (key === 'publication.id' ? [{ value: 'docs', documents: 1 }, { value: 'blog', documents: 1 }] : key === 'status' ? [{ value: 'draft', documents: 4 }, { value: 'done: yes', documents: 1 }] : [])
        expect(rankFrontmatterItems(doc, ctx!, { graphKeys: [], graphValues }).map((i) => i.insert)).toEqual(['docs'])
        ;({ doc, ctx } = at('---\nstatus: d|\n---\n'))
        // A value that needs quotes to stay text is inserted quoted.
        expect(rankFrontmatterItems(doc, ctx!, { graphKeys: [], graphValues }).map((i) => i.insert)).toEqual(['draft', '"done: yes"'])
    })
})
