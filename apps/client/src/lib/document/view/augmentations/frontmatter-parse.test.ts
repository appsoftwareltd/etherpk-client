import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { describe, expect, it } from 'vitest'

import { editorMarkdownExtensions } from './scheme-url-autolink'

/**
 * Parsed against the editor's own markdown configuration, not a hand-built one — the point is
 * that [[Frontmatter]] wins over the constructs that used to claim those lines, and that only a
 * real parse can show.
 */
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

/** Just the node names, which is usually the whole question. */
const names = (doc: string) => nodes(doc).map((n) => n.split(':')[0])

describe('the Frontmatter block parser', () => {
    it('claims the whole block, with a mark for each delimiter', () => {
        const found = nodes('---\ntitle: Kanban\n---\n')

        expect(found[0]).toBe('Frontmatter:"---\\ntitle: Kanban\\n---"')
        // Two delimiters, and nothing between them that markdown would style.
        expect(found.filter((n) => n.startsWith('FrontmatterMark'))).toEqual([
            'FrontmatterMark:"---"',
            'FrontmatterMark:"---"',
        ])
    })

    it('leaves no HeaderMark for markdown-format to hide — the reported bug', () => {
        // The closing --- used to be a SetextHeading2's underline, and markdown-format hides
        // HeaderMark off-line by design, so it vanished the moment the caret left.
        const found = names('---\ntitle: Kanban\n---\n\nbody')
        expect(found).not.toContain('HeaderMark')
        expect(found).not.toContain('SetextHeading2')
        expect(found).not.toContain('HorizontalRule')
    })

    it('stops YAML values being read as markdown', () => {
        // `tags: [a]` used to produce a real Link node inside the metadata.
        const found = names('---\ntags: [a]\ntitle: *draft*\n---\nbody')
        expect(found).not.toContain('Link')
        expect(found).not.toContain('Emphasis')
    })

    it('leaves the body after it to be parsed normally', () => {
        expect(names('---\ntitle: A\n---\n\n# Heading\n')).toContain('ATXHeading1')
    })

    it('handles an empty block, with no content node', () => {
        expect(nodes('---\n---\nbody')).toEqual([
            'Frontmatter:"---\\n---"',
            'FrontmatterMark:"---"',
            'FrontmatterMark:"---"',
            'Paragraph:"body"',
        ])
    })

    it('tolerates trailing whitespace on a delimiter', () => {
        expect(names('--- \ntitle: A\n---\t\nbody')).toContain('Frontmatter')
    })

    it('claims nothing when the opener is not at the very start', () => {
        expect(names('\n---\ntitle: A\n---\n')).not.toContain('Frontmatter')
        // A --- under a paragraph is a setext heading, and stays one.
        expect(names('Some text\n---\nmore')).toContain('SetextHeading2')
    })

    it('claims nothing while the opener is unterminated, so typing --- restyles nothing', () => {
        expect(names('---\ntitle: A\nstill typing')).not.toContain('Frontmatter')
    })

    it('leaves the whole document to the ordinary parser while the opener is unterminated', () => {
        // The scan for a closer must not consume the lines it reads: a parser that walked to the end
        // and then declined left one empty paragraph, and every heading and emphasis below vanished
        // until the closer was typed.
        const found = names('---\ntitle: A\n\n# H\n\n**b**')
        expect(found).toContain('HorizontalRule')
        expect(found).toContain('ATXHeading1')
        expect(found).toContain('StrongEmphasis')
    })

    it('leaves a thematic break alone elsewhere in the document', () => {
        expect(names('---\ntitle: A\n---\n\npara\n\n---\n\nmore')).toContain('HorizontalRule')
    })

    it('highlights the body as YAML rather than as prose', () => {
        // parseMixed mounts the YAML tree in FrontmatterContent's place, so its nodes ARE the
        // body: a key/value pair is a Pair with a Key, not a paragraph of text.
        const found = names('---\ntitle: Kanban\n---\n')

        expect(found).toContain('Pair')
        expect(found).toContain('Key')
        expect(found).not.toContain('Paragraph')
    })
})
