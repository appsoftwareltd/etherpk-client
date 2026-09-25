import { Text } from '@codemirror/state'
import { parser } from '@lezer/markdown'
import { describe, expect, it } from 'vitest'

import { blockquoteLines } from './blockquote-core'
import { editorMarkdownExtensions } from './scheme-url-autolink'

/** The same parser configuration the editor mounts (code-highlight.ts → markdownWithCodeHighlight). */
const markdown = parser.configure(editorMarkdownExtensions)

/** The quoted lines of `doc` as `n:first|middle|last`, in document order. */
function quoted(doc: string, range?: [number, number]): string[] {
    const text = Text.of(doc.split('\n'))
    const lines = blockquoteLines(markdown.parse(doc), text, range?.[0], range?.[1])
    return [...lines.entries()]
        .sort(([a], [b]) => a - b)
        .map(([n, q]) => `${n}:${q.first && q.last ? 'only' : q.first ? 'first' : q.last ? 'last' : 'middle'}`)
}

describe('blockquoteLines', () => {
    it('reports a one-line prose quote as first and last', () => {
        expect(quoted('> Test\n\nnext')).toEqual(['1:only'])
    })

    it('reports a quote that is a bullet\'s content, and not its sibling bullets', () => {
        expect(quoted('- above\n- > Test\n- below')).toEqual(['2:only'])
    })

    it('spans every line the parser places in the quote, marking the ends', () => {
        expect(quoted('> a\n> b\n> c\n\nafter')).toEqual(['1:first', '2:middle', '3:last'])
        expect(quoted('- > a\n  > b\n- next')).toEqual(['1:first', '2:last'])
    })

    it('includes a lazy continuation line, as CommonMark does (only a blank line or a bullet ends a quote)', () => {
        expect(quoted('> a\nlazy\n\nprose')).toEqual(['1:first', '2:last'])
        expect(quoted('> a\n- bullet')).toEqual(['1:only'])
    })

    it('ends the quote at a blank line', () => {
        expect(quoted('> a\n\n> b')).toEqual(['1:only', '3:only'])
    })

    it('reports one panel for a nested quote', () => {
        expect(quoted('> > nested\n> outer')).toEqual(['1:first', '2:last'])
    })

    it('quotes a bullet\'s continuation line without touching the bullet line', () => {
        expect(quoted('- x\n  > quoted child\n- y')).toEqual(['2:only'])
    })

    it('reports only the lines intersecting the range, keeping their place in the whole quote', () => {
        const doc = '> a\n> b\n> c'
        expect(quoted(doc, [5, 6])).toEqual(['2:middle'])
        expect(quoted(doc, [0, 3])).toEqual(['1:first'])
    })

    it('is empty for prose without a quote, and for a fence holding a `>` line', () => {
        expect(quoted('plain\n- bullet')).toEqual([])
        expect(quoted('```\n> not a quote\n```')).toEqual([])
    })
})
