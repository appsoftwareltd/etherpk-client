/**
 * The Rich Paste decision in Node (Editor Content Rules → *Rich Paste*; ADR 0090): what a paste whose
 * clipboard carries HTML puts into the document, over the headless fixture and linkedom's parser.
 * The rows paste the plan's text through the fixture so the block-per-line rule lands it as it would
 * in the browser.
 */

import { DOMParser } from 'linkedom'
import { describe, expect, it } from 'vitest'

import { planRichPaste } from './rich-paste'
import { editorFixture } from './testing/editor-state-fixture'

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html') as unknown as Document

/** The fixture after a Rich Paste of `html` at the caret, or the fixture untouched when the plan yields. */
function richPaste(before: string, html: string, displaySize?: string): { after: string; plan: ReturnType<typeof planRichPaste> } {
    const editor = editorFixture(before)
    const plan = planRichPaste(editor.state, html, parse, displaySize)
    if (plan) editor.paste(plan.text)
    return { after: editor.fixture(), plan }
}

const ARTICLE = '<h2>Embedding</h2><p>You add a <a href="https://x.test/p">prompt</a>.</p><figure><img src="https://x.test/e.png" alt="Layer"><figcaption>Figure 1.</figcaption></figure><ul><li>one</li><li>two</li></ul>'

describe('planRichPaste: where the HTML lands', () => {
    it('into an empty bullet, the outline takes the line', () => {
        expect(richPaste('- |', ARTICLE).after).toBe(
            '- ## Embedding\n  - You add a [prompt](https://x.test/p).\n  - ![Layer](https://x.test/e.png)\n    Figure 1.\n    - one\n    - two|',
        )
    })

    it('into a bullet with text, the outline nests under the block, as a copied tree does', () => {
        expect(richPaste('- Notes|', '<p>a</p><p>b</p>').after).toBe('- Notes\n  - a\n  - b|')
    })

    it('into a bullet with children, the outline becomes its first children', () => {
        expect(richPaste('- Notes|\n  - c', '<p>a</p>').after).toBe('- Notes\n  - a|\n  - c')
    })

    it('on a continuation line, under the owner', () => {
        expect(richPaste('- a\n  soft|', '<p>x</p>').after).toBe('- a\n  soft\n  - x|')
    })

    it('over selected blocks, the outline replaces them', () => {
        expect(richPaste('«- a\n- b»\n- c', '<p>x</p><p>y</p>').after).toBe('- x\n- y|\n- c')
    })

    it('into prose, flat markdown: headings, paragraphs apart, lists bulleted', () => {
        expect(richPaste('|', ARTICLE).after).toBe(
            '## Embedding\n\nYou add a [prompt](https://x.test/p).\n\n![Layer](https://x.test/e.png)\nFigure 1.\n\n- one\n- two|',
        )
        expect(richPaste('p|', '<p>a</p><ul><li>x</li></ul>').after).toBe('pa\n\n- x|')
    })

    it('carries the graph’s display-size hint on every image', () => {
        const editor = editorFixture('- ¦', { caret: '¦' })
        editor.paste(planRichPaste(editor.state, '<img src="https://x.test/e.png" alt="L">', parse, '300')!.text)
        expect(editor.fixture()).toBe('- ![L|300](https://x.test/e.png)¦')
    })

    it('reports every image the text carries, once each', () => {
        const { plan } = richPaste('- |', ARTICLE)
        expect(plan?.images).toEqual([{ src: 'https://x.test/e.png', alt: 'Layer' }])
    })
})

describe('planRichPaste: when the plain text is pasted instead', () => {
    it('inside a fenced block and in the frontmatter', () => {
        expect(richPaste('- ```\n  |\n  ```', '<p>code</p>').plan).toBeNull()
        expect(richPaste('---\ntitle: x\n|\n---\n- a', '<p>yaml</p>').plan).toBeNull()
    })

    it('when the HTML holds nothing to paste', () => {
        expect(richPaste('- |', '<style>p{}</style><script>x()</script>').plan).toBeNull()
        expect(richPaste('- |', '   ').plan).toBeNull()
    })

    it('is one undo step, caret restored', () => {
        const editor = editorFixture('- a|\n- b')
        const plan = planRichPaste(editor.state, '<p>one</p><ul><li>two</li></ul>', parse)!
        editor.paste(plan.text)
        expect(editor.fixture()).toBe('- a\n  - one\n    - two|\n- b')
        editor.key('Mod-z')
        expect(editor.fixture()).toBe('- a|\n- b')
    })
})
