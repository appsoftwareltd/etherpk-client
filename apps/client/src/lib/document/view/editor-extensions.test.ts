/**
 * The feature stack is data, so its order and presence are tested rather than commented. Each
 * assertion here is a constraint one feature places on another; when a constraint stops being
 * true, the code that depended on it has changed and this file should change with it.
 */

import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { editorAnalysis } from './analysis/editor-analysis'
import { editorDocument } from './editor-document'
import { editorExtensions, editorFeatures, type EditorExtensionServices } from './editor-extensions'

const services: EditorExtensionServices = {
    assetStore: () => null,
    graphIndex: () => null,
    conceptIsMissing: () => false,
    openConcept: () => {},
    onFocus: () => {},
    onUpdate: () => {},
}

function names(): string[] {
    return editorFeatures(services).map((f) => f.name)
}

function before(a: string, b: string): void {
    const order = names()
    expect(order).toContain(a)
    expect(order).toContain(b)
    expect(order.indexOf(a)).toBeLessThan(order.indexOf(b))
}

describe('editor feature stack', () => {
    it('loads every feature exactly once', () => {
        const order = names()
        expect(new Set(order).size).toBe(order.length)
        expect(order).toEqual([
            'block-selection',
            'caret-clamp',
            'fence-pad',
            'frontmatter-boundary',
            'wrap-selection',
            'spell-check',
            'markdown-format',
            'bullet-marker',
            'task-checkbox',
            'outline-guides',
            'content-clamp',
            'code-scroll',
            'selection-layer',
            'markdown-table',
            'frontmatter',
            'frontmatter-assist',
            'protected-fence',
            'fence-render',
            'math-inline',
            'image-embed',
            'asset-link',
            'markdown-link',
            'asset-drop',
            'asset-paste',
            'rich-paste',
            'wikilink',
            'link-cursor',
            'wikilink-completion',
            'task-tag-completion',
            'slash-completion',
            'frontmatter-completion',
            'date-calendar',
            'table-size-picker',
            'concept-picker',
            'frontmatter-keys',
            'placeholder',
            'edit-refusal',
            'editor-document',
            'line-anchor',
            'view-hooks',
        ])
    })

    it('names the document the editor shows, when the host says which', () => {
        const build = (host: EditorExtensionServices) => EditorState.create({ extensions: [editorAnalysis(), ...editorExtensions(host)] })
        expect(build({ ...services, document: { concept: 'Acme', panelId: 'p1' } }).facet(editorDocument)).toEqual({ concept: 'Acme', panelId: 'p1' })
        expect(build(services).facet(editorDocument)).toBeNull()
    })

    it('runs the transaction filters before anything that decorates', () => {
        before('block-selection', 'markdown-format')
        before('caret-clamp', 'markdown-format')
        before('fence-pad', 'markdown-format')
        before('frontmatter-boundary', 'markdown-format')
    })

    it('pads a code line short of its fence column before the caret clamp judges the caret', () => {
        // Filters run last-registered first, so the pad registered after the clamp runs before it: the
        // clamp judges the padded line as code. Judged unpadded, a joined `- x` code line took a bullet's
        // clamp and the pad then carried the caret past the `- ` (fence-guard.ts, fencePad).
        before('caret-clamp', 'fence-pad')
    })

    it('nests spell check marks inside every other decoration, so none is split at their edges', () => {
        // CodeMirror nests a later extension's mark outside an earlier one's and splits the inner
        // one (ADR 0094). Split, the clamp's absolute prefix drew the bullet at the line's edge.
        const decorating = names().slice(names().indexOf('markdown-format'))
        for (const name of decorating) before('spell-check', name)
    })

    it('gives a misspelt word touching a link its spelling menu before the link its menu', () => {
        // Both answer Shift+F10 and the Menu key at the caret; spell check excludes link text, so
        // they meet only at a caret between a misspelt word and a link, where the word wins.
        before('spell-check', 'wikilink')
    })

    it('gives every open popover Enter and Tab before the YAML typing keys', () => {
        for (const popover of ['wikilink-completion', 'task-tag-completion', 'slash-completion', 'frontmatter-completion', 'date-calendar', 'table-size-picker', 'concept-picker']) {
            before(popover, 'frontmatter-keys')
        }
    })

    it('lets clipboard files claim a paste before the HTML route sees it', () => {
        before('asset-paste', 'rich-paste')
    })

    it('lets the asset-link augmentation claim asset targets before markdown-link sees them', () => {
        before('asset-link', 'markdown-link')
    })

    it('draws the link cursor after every link kind it covers', () => {
        before('asset-link', 'link-cursor')
        before('markdown-link', 'link-cursor')
        before('wikilink', 'link-cursor')
    })

    it('lays out the content clamp before the selection layer that reads the laid-out lines', () => {
        before('content-clamp', 'selection-layer')
    })

    it('wraps a code line in its scroll container after every mark that sits inside one', () => {
        // CodeMirror nests a later extension's mark OUTSIDE an earlier one's: the container must be
        // the outer span, or a highlight token or remote selection would split it into two boxes.
        // The tokens come from the base editor (cm-document.ts), not a named feature, so this row
        // pins only the stack's order; that one container survives the tokens is proved in the
        // browser (tests-client/fenced-code-scroll.test.ts, "a single scroll container").
        before('content-clamp', 'code-scroll')
    })

    it('reports a refusal after the filters that raise it', () => {
        before('frontmatter-boundary', 'edit-refusal')
        before('protected-fence', 'edit-refusal')
    })

    it('keeps the view hooks last so every feature has registered before focus fires', () => {
        expect(names().at(-1)).toBe('view-hooks')
    })

    it('builds a state without a DOM, with no graph and no asset store', () => {
        // The same base `cm-document.ts` loads under the features: the shared analysis.
        const state = EditorState.create({
            doc: '- a [[B]]\n\n![x](../assets/x.png)',
            extensions: [editorAnalysis(), ...editorExtensions(services)],
        })
        expect(state.doc.lines).toBe(3)
    })
})
