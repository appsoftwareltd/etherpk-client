import { describe, expect, it } from 'vitest'

import { editFrontmatter, frontmatterData, isEmptyValue, renderFrontmatter, tidyFrontmatter } from './frontmatter-yaml'

describe('frontmatterData', () => {
    it('reads a mapping, an empty block as no keys, and anything else as unreadable', () => {
        expect(frontmatterData('title: A\naliases: [b]')).toEqual({ title: 'A', aliases: ['b'] })
        expect(frontmatterData('')).toEqual({})
        expect(frontmatterData('# only a comment')).toEqual({})
        expect(frontmatterData('- a list')).toBeNull()
        expect(frontmatterData('just text')).toBeNull()
        expect(frontmatterData('a: [')).toBeNull()
        expect(frontmatterData('a: 1\na: 2')).toBeNull()
    })
})

describe('renderFrontmatter', () => {
    it('writes a block in the EtherPK style, quoting only what needs it', () => {
        expect(renderFrontmatter({ title: 'Meeting: Notes', aliases: ['x', 'y'], public: true, flag: 'true' })).toBe(
            '---\ntitle: "Meeting: Notes"\naliases:\n  - x\n  - y\npublic: true\nflag: "true"\n---\n',
        )
    })

    it('writes an empty value bare, and nothing at all for no keys', () => {
        expect(renderFrontmatter({ slug: null, publications: [] })).toBe('---\nslug:\npublications:\n---\n')
        expect(renderFrontmatter({})).toBe('')
    })

    it('never folds a long value', () => {
        const long = 'word '.repeat(40).trim()
        expect(renderFrontmatter({ description: long })).toBe(`---\ndescription: ${long}\n---\n`)
    })
})

describe('tidyFrontmatter', () => {
    it('restyles indentation, inline lists, quotes and blank lines, keeping comments and key order', () => {
        const text = [
            '---  ',
            '# my labels',
            'status: "draft"',
            'tags: [a, b]',
            '',
            'nested:',
            '    id: docs',
            '    list: [x]',
            'empty: []',
            'slug:',
            '---',
            '- body stays [[as is]]  ',
            '',
        ].join('\n')
        expect(tidyFrontmatter(text)).toBe(
            [
                '---',
                '# my labels',
                'status: draft',
                'tags:',
                '  - a',
                '  - b',
                'nested:',
                '  id: docs',
                '  list:',
                '    - x',
                'empty: []',
                'slug:',
                '---',
                '- body stays [[as is]]  ',
                '',
            ].join('\n'),
        )
    })

    it('keeps a quote a value needs, and a multi-line value as written', () => {
        const text = "---\nflag: 'true'\nnum: '42'\ndesc: |\n  one\n  two\n---\n"
        expect(tidyFrontmatter(text)).toBe('---\nflag: "true"\nnum: "42"\ndesc: |\n  one\n  two\n---\n')
    })

    it('returns the same string for a block already in the style', () => {
        const text = '---\ntitle: A\naliases:\n  - b\n---\nbody\n'
        expect(tidyFrontmatter(text)).toBe(text)
    })

    it('leaves text with no block, an unterminated block, or YAML that does not parse alone', () => {
        for (const text of ['- body\n', '---\ntitle: A\n', '---\na: [\n---\n', '---\n\ttitle: A\n---\n', '---\n- a\n---\n']) {
            expect(tidyFrontmatter(text)).toBe(text)
        }
    })

    it('keeps CRLF line endings in the block', () => {
        expect(tidyFrontmatter('---\r\ntags: [a]\r\n---\r\nbody\r\n')).toBe('---\r\ntags:\r\n  - a\r\n---\r\nbody\r\n')
    })

    it('writes an empty list bare on a key EtherPK reads, where empty means not set', () => {
        // `publications: []` and `publications:` say the same thing to EtherPK (ADR 0108), and the
        // style writes every empty value bare. A key EtherPK does not read keeps its `[]`: to
        // another tool an empty list and no value may differ.
        expect(tidyFrontmatter('---\ntitle: T\npublications: []\naliases: []\ntags: []\n---\nbody\n')).toBe(
            '---\ntitle: T\npublications:\naliases:\ntags: []\n---\nbody\n',
        )
        expect(tidyFrontmatter('---\ntags: []\n---\n')).toBe('---\ntags: []\n---\n')
    })

    it('never changes what the block says', () => {
        const samples = [
            'a: &x 1\nb: *x',
            'when: 2026-09-28',
            'n: 0x1F',
            'k: ~',
            'odd key: "tab\\there"',
            'q: "a # not a comment"',
            'dash: "- x"',
            'folded: >\n  one\n  two',
        ]
        for (const body of samples) {
            const text = `---\n${body}\n---\n`
            const before = frontmatterData(body)
            const after = tidyFrontmatter(text)
            expect(frontmatterData(after.slice(4, after.lastIndexOf('---')))).toEqual(before)
        }
    })
})

describe('editFrontmatter', () => {
    const text = '---\n# keep me\ntitle: A\ntags: [x]  # labels\nb: 2\n---\nbody\n'

    it('sets an existing key in place and a new one last, keeping comments', () => {
        const out = editFrontmatter(text, (block) => {
            block.set('b', 3)
            block.set('slug', 'a-page')
        })
        expect(out).toBe('---\n# keep me\ntitle: A\ntags:\n  - x\n  # labels\nb: 3\nslug: a-page\n---\nbody\n')
    })

    it('puts a key first when asked, and deletes', () => {
        const out = editFrontmatter('---\nb: 2\n---\n', (block) => {
            block.set('title', 'T', 'first')
            block.delete('b')
        })
        expect(out).toBe('---\ntitle: T\n---\n')
    })

    it('writes an empty value when set to null', () => {
        expect(editFrontmatter('---\na: 1\n---\n', (block) => block.set('slug', null))).toBe('---\na: 1\nslug:\n---\n')
    })

    it('returns the same string when nothing changes, however the block is formatted', () => {
        expect(editFrontmatter(text, (block) => block.set('b', 2))).toBe(text)
        expect(editFrontmatter(text, (block) => block.delete('missing'))).toBe(text)
    })

    it('reads values through the editor', () => {
        editFrontmatter(text, (block) => {
            expect(block.has('tags')).toBe(true)
            expect(block.get('tags')).toEqual(['x'])
            expect(block.keys()).toEqual(['title', 'tags', 'b'])
        })
    })

    it('adds a block only when asked, and leaves a malformed one alone', () => {
        expect(editFrontmatter('body\n', (block) => block.set('a', 1))).toBe('body\n')
        expect(editFrontmatter('body\n', (block) => block.set('a', 1), { addBlock: true })).toBe('---\na: 1\n---\nbody\n')
        const bad = '---\na: [\n---\n'
        expect(editFrontmatter(bad, (block) => block.set('a', 1))).toBe(bad)
    })

    it('removes a block emptied of every key', () => {
        expect(editFrontmatter('---\na: 1\n---\nbody\n', (block) => block.delete('a'))).toBe('body\n')
    })
})

describe('isEmptyValue', () => {
    it('is true for nothing, a blank string, an empty list and a mapping of empty values', () => {
        for (const value of [null, undefined, '', '   ', [], {}, { id: null, kind: '' }, { nested: { a: null } }]) {
            expect(isEmptyValue(value)).toBe(true)
        }
        for (const value of [false, 0, 'x', ['a'], { id: 'docs' }, { a: null, b: 'x' }]) {
            expect(isEmptyValue(value)).toBe(false)
        }
    })
})
