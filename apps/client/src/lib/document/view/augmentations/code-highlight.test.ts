import { ensureSyntaxTree, LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { describe, expect, it } from 'vitest'

import { markdownWithCodeHighlight } from './code-highlight'

const stateOf = (doc: string) => EditorState.create({ doc, extensions: [markdownWithCodeHighlight()] })

/**
 * The named nodes at `pos`, innermost first, mounted grammars included. (`Tree.iterate` never
 * descends into an overlay mount, which is how both the fence and the HTML grammars are attached;
 * `resolveInner` does.)
 */
function chainAt(doc: string, pos: number): string[] {
    const tree = ensureSyntaxTree(stateOf(doc), doc.length, 5_000)!
    const names: string[] = []
    for (let node: SyntaxNode | null = tree.resolveInner(pos, 1); node; node = node.parent) {
        if (node.name) names.push(node.name)
    }
    return names
}

/** The nodes lang-html's grammar produces for an element or a comment: none may appear over raw HTML. */
const HTML_GRAMMAR_NODES = ['Element', 'OpenTag', 'CloseTag', 'TagName', 'StartTag', 'EndTag', 'Comment']
const fromHtmlGrammar = (chain: string[]) => chain.filter((name) => HTML_GRAMMAR_NODES.includes(name))

// The browser rows (token spans, the `>` keystroke) are in tests-client/fenced-code-highlight.test.ts.
describe('raw HTML is prose (Editor Content Rules → Standard prose; Logseq)', () => {
    const doc = '<p>Test</p>\n\nprose <b>bold</b> here\n\n<!-- note -->\n'

    it('leaves an HTML block as the markdown node alone', () => {
        const chain = chainAt(doc, doc.indexOf('p>Test'))
        expect(fromHtmlGrammar(chain)).toEqual([])
        // The mount stays an overlay under the markdown node, so every `iterate`-based reader in the
        // editor keeps seeing HTMLBlock, as it did with the HTML grammar mounted.
        expect(chain).toContain('HTMLBlock')
    })

    it('loads no support with the language: no tag auto-close handler, no tag completion source', () => {
        const state = stateOf(doc)
        // lang-html's `autoCloseTags` is an input handler; with it mounted this facet had one entry.
        expect(state.facet(EditorView.inputHandler)).toEqual([])
        // `completeHTMLTags` registers a completion source as markdown language data.
        expect(state.languageDataAt('autocomplete', doc.indexOf('p>Test'))).toEqual([])
    })

    it('leaves an inline tag as the markdown node alone', () => {
        const chain = chainAt(doc, doc.indexOf('b>bold'))
        expect(fromHtmlGrammar(chain)).toEqual([])
        expect(chain).toContain('HTMLTag')
    })

    it('leaves a comment as the markdown node alone', () => {
        const chain = chainAt(doc, doc.indexOf('note'))
        expect(fromHtmlGrammar(chain)).toEqual([])
        expect(chain).toContain('CommentBlock')
    })

    it('still parses a fenced html block through its info-string', async () => {
        // The fence grammar lazy-loads; resolve it first so the nested parse is synchronous here.
        await LanguageDescription.matchLanguageName(languages, 'html', true)!.load()
        const fenced = '```html\n<p>fenced</p>\n```\n'
        expect(chainAt(fenced, fenced.indexOf('p>fenced'))).toContain('TagName')
    })
})
