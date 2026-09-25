import { describe, expect, it } from 'vitest'

import { frontmatterLines, frontmatterSpan } from './frontmatter-span'

/** The span rendered as what each consumer takes from it, so a change shows up here first. */
const span = (text: string) => {
    const found = frontmatterSpan(text)
    return found && { body: found.body, lines: found.lines, rest: text.slice(found.end) }
}

describe('frontmatterSpan', () => {
    it('finds a closed block and reports its body, height and what follows', () => {
        expect(span('---\ntitle: Kanban\n---\nbody here')).toEqual({
            body: 'title: Kanban',
            lines: 3,
            rest: 'body here',
        })
    })

    it('counts every line of a multi-line block', () => {
        expect(span('---\ntitle: A\naliases:\n  - B\n---\nx')?.lines).toBe(5)
    })

    it('handles an empty block', () => {
        expect(span('---\n---\nx')).toEqual({ body: '', lines: 2, rest: 'x' })
    })

    it('handles a document that is nothing but frontmatter', () => {
        expect(span('---\ntitle: A\n---')).toEqual({ body: 'title: A', lines: 3, rest: '' })
        expect(span('---\ntitle: A\n---\n')).toEqual({ body: 'title: A', lines: 3, rest: '' })
    })

    it('tolerates trailing spaces on either delimiter, which are invisible to whoever typed them', () => {
        expect(span('--- \ntitle: A\n---\t\nx')).toEqual({ body: 'title: A', lines: 3, rest: 'x' })
    })

    it('tolerates CRLF, leaving the terminator out of the YAML', () => {
        expect(span('---\r\ntitle: A\r\n---\r\nx')).toEqual({ body: 'title: A', lines: 3, rest: 'x' })
    })

    it('is not frontmatter when the opener is not at the very start', () => {
        expect(frontmatterSpan('\n---\ntitle: A\n---\n')).toBeNull()
        expect(frontmatterSpan('# Heading\n---\ntitle: A\n---\n')).toBeNull()
    })

    it('is not frontmatter when the opener is unterminated — it is plain text until it balances', () => {
        expect(frontmatterSpan('---\ntitle: A\nstill typing')).toBeNull()
        expect(frontmatterSpan('---\n')).toBeNull()
        expect(frontmatterSpan('---')).toBeNull()
    })

    it('does not accept `...` as a closer, which nothing in this format writes', () => {
        expect(frontmatterSpan('---\ntitle: A\n...\nx')).toBeNull()
    })

    it('does not mistake a delimiter with content on it', () => {
        expect(frontmatterSpan('---x\ntitle: A\n---\n')).toBeNull()
        expect(frontmatterSpan('----\ntitle: A\n----\n')).toBeNull()
    })

    it('closes on the FIRST delimiter, so a later one is body', () => {
        expect(span('---\na: 1\n---\nprose\n---\nmore')).toEqual({
            body: 'a: 1',
            lines: 3,
            rest: 'prose\n---\nmore',
        })
    })
})

describe('frontmatterLines', () => {
    it('counts the block, opener and closer included, from split lines', () => {
        expect(frontmatterLines(['---', 'title: A', 'aliases:', '  - B', '---', 'body'])).toBe(5)
    })

    it('agrees with frontmatterSpan on what is not a block', () => {
        expect(frontmatterLines(['---'])).toBe(0) // a lone opener
        expect(frontmatterLines(['---', 'title: A', 'still typing'])).toBe(0) // unterminated
        expect(frontmatterLines(['body', '---', 'x', '---'])).toBe(0) // not at the start
        expect(frontmatterLines([])).toBe(0)
    })

    it('tolerates CRLF line endings the way the span does', () => {
        expect(frontmatterLines(['---\r', 'title: A\r', '---\r', 'body'])).toBe(3)
    })
})
