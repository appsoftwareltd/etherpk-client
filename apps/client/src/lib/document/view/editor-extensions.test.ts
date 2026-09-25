/**
 * The feature stack is data, so its order and presence are tested rather than commented. Each
 * assertion here is a constraint one feature places on another; when a constraint stops being
 * true, the code that depended on it has changed and this file should change with it.
 */

import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { editorAnalysis } from './analysis/editor-analysis'
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
            'date-calendar',
            'table-size-picker',
            'edit-refusal',
            'view-hooks',
        ])
    })

    it('runs the transaction filters before anything that decorates', () => {
        before('block-selection', 'markdown-format')
        before('caret-clamp', 'markdown-format')
        before('frontmatter-boundary', 'markdown-format')
    })

    it('nests spell check marks inside every other decoration, so none is split at their edges', () => {
        // CodeMirror nests a later extension's mark outside an earlier one's and splits the inner
        // one (ADR 0094). Split, the clamp's absolute prefix drew the bullet at the line's edge.
        const decorating = names().slice(names().indexOf('markdown-format'))
        for (const name of decorating) before('spell-check', name)
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
