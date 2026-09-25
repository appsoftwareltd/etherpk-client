import { markdown } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { editorMarkdownExtensions } from './scheme-url-autolink'

/** Parsed against the editor's own markdown configuration, as the frontmatter test does. */
function nodes(doc: string): string[] {
    const state = EditorState.create({
        doc,
        extensions: [markdown({ extensions: editorMarkdownExtensions, addKeymap: false })],
    })
    const out: string[] = []
    syntaxTree(state).iterate({
        enter(node) {
            if (node.name !== 'Document') out.push(`${node.name}:${JSON.stringify(doc.slice(node.from, node.to))}`)
        },
    })
    return out
}

describe('the ==highlight== inline parser', () => {
    it('emits a Highlight node with a mark for each delimiter', () => {
        const found = nodes('the ==quick== fox')
        expect(found).toContain('Highlight:"==quick=="')
        expect(found.filter((n) => n.startsWith('HighlightMark'))).toEqual(['HighlightMark:"=="', 'HighlightMark:"=="'])
    })

    it('needs a double equals: a single one is prose', () => {
        expect(nodes('a =b= c').some((n) => n.startsWith('Highlight'))).toBe(false)
    })

    it('follows the flanking rule, so a spaced pair is prose', () => {
        expect(nodes('a == b == c').some((n) => n.startsWith('Highlight'))).toBe(false)
    })

    it('nests with the other marks', () => {
        const found = nodes('==**bold** inside==')
        expect(found).toContain('Highlight:"==**bold** inside=="')
        expect(found).toContain('StrongEmphasis:"**bold**"')
    })

    it('is not recognised inside inline code or a fence', () => {
        expect(nodes('`==code==`').some((n) => n.startsWith('Highlight'))).toBe(false)
        expect(nodes('```\n==code==\n```').some((n) => n.startsWith('Highlight'))).toBe(false)
    })

    it('spans a soft line break inside a paragraph, as emphasis does', () => {
        expect(nodes('==one\ntwo==')).toContain('Highlight:"==one\\ntwo=="')
        expect(nodes('**one\ntwo**')).toContain('StrongEmphasis:"**one\\ntwo**"')
    })
})
