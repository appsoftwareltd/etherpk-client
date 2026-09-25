import { describe, expect, it } from 'vitest'

import { parseFrontmatter } from './frontmatter'

describe('parseFrontmatter', () => {
    it('parses a leading --- block into data and returns the body after it', () => {
        const { data, body } = parseFrontmatter('---\ntitle: Physics\n---\n# Heading\n\nBody.')
        expect(data).toEqual({ title: 'Physics' })
        expect(body).toBe('# Heading\n\nBody.')
    })

    it('returns empty data and the whole text when there is no frontmatter', () => {
        const text = '# Just a heading\n\nNo frontmatter.'
        const { data, body } = parseFrontmatter(text)
        expect(data).toEqual({})
        expect(body).toBe(text)
    })

    it('preserves arbitrary keys and array values', () => {
        const { data } = parseFrontmatter('---\ntitle: QM\naliases:\n  - Quanta\n  - QM\npublic: true\n---\n')
        expect(data).toEqual({ title: 'QM', aliases: ['Quanta', 'QM'], public: true })
    })

    it('treats an unterminated fence as body, never throwing', () => {
        const text = '---\ntitle: oops\nno closing fence'
        const { data, body } = parseFrontmatter(text)
        expect(data).toEqual({})
        expect(body).toBe(text)
    })

    it('treats malformed YAML as empty data with original text as body', () => {
        const text = '---\n: : : not yaml : :\n---\nbody'
        const { data } = parseFrontmatter(text)
        expect(data).toEqual({})
    })

    it('tolerates CRLF line endings', () => {
        const { data, body } = parseFrontmatter('---\r\ntitle: Physics\r\n---\r\nBody')
        expect(data).toEqual({ title: 'Physics' })
        expect(body).toBe('Body')
    })

    it('only matches a fence at the very start of the file', () => {
        const text = 'intro\n---\ntitle: nope\n---\n'
        const { data, body } = parseFrontmatter(text)
        expect(data).toEqual({})
        expect(body).toBe(text)
    })
})
