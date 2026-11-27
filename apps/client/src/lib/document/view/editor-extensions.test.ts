/**
 * The feature stack is data, so its order and presence are tested rather than commented. Each
 * assertion here is a constraint one feature places on another; when a constraint stops being
 * true, the code that depended on it has changed and this file should change with it.
 */

import { readFileSync } from 'node:fs'
import { undoDepth } from '@codemirror/commands'
import { EditorState, type Transaction } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { createContributionRegistry, setActiveContributionRegistry } from '#lib/surface/index.js'

import { editorAnalysis } from './analysis/editor-analysis'
import { registerInteractiveFence } from './augmentations/interactive-fence-contract'
import { revealFocus, revealedLines } from './augmentations/reveal-policy'
import { editorDocument } from './editor-document'
import { editorIsOnScreen, setEditorOnScreen } from './editor-on-screen'
import { localHistoryExtension } from './editor-history'
import { CELL_FEATURES, cellEditorExtensions, editorExtensions, editorFeatures, type EditorExtensionServices } from './editor-extensions'
import { startAtEnd } from './end-of-document'
import { anchorLine } from './line-anchor'
import { shownRangeIn } from './shown-range'
import { taskPartRange } from './task-part-range'

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
            'shown-range',
            'block-selection',
            'caret-clamp',
            'fence-pad',
            'fence-deletes',
            'frontmatter-boundary',
            'wrap-selection',
            'spell-check',
            'find-matches',
            'markdown-format',
            'template-variables',
            'bullet-marker',
            'task-checkbox',
            'outline-guides',
            'fold-controls',
            'content-clamp',
            'code-scroll',
            'selection-layer',
            'markdown-table',
            'frontmatter',
            'frontmatter-assist',
            'protected-fence',
            'fence-render',
            'interactive-fence',
            'inline-panels',
            'end-of-document',
            'math-inline',
            'image-embed',
            'asset-link',
            'media-embed',
            'markdown-link',
            'asset-drop',
            'plain-paste',
            'asset-paste',
            'paste-to-fence',
            'rich-paste',
            'wikilink',
            'link-cursor',
            'wikilink-completion',
            'path-completion',
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
            'on-screen',
            'line-anchor',
            'fold-persistence',
            'bookmarks',
            'line-numbers',
            'keep-caret-visible',
            'column-shift',
            'selection-order',
            'view-hooks',
        ])
    })

    it('puts the backwards-range filter after every other filter, so it runs before them', () => {
        // Filters run in reverse order of registration, and the caret clamp, the block snap and the
        // fence guards all read the selection an edit leaves. Only the view hooks, which filter
        // nothing, come after it.
        expect(names().at(-2)).toBe('selection-order')
    })

    it('shows part of the document only when the host gives the part (the Task Editor, ADR 0170)', () => {
        const shown = (extra: Partial<typeof services>) => editorFeatures({ ...services, ...extra }).find((f) => f.name === 'shown-range')!.extension
        expect(shown({})).toEqual([])
        expect(shown({ shownRange: () => null })).not.toEqual([])
        // First, so its Prec.highest filter runs after the Extension Fence's and its hidden lines are
        // drawn over every widget a later feature puts on a hidden line.
        before('shown-range', 'interactive-fence')
        before('shown-range', 'image-embed')
        before('shown-range', 'media-embed')
        before('shown-range', 'fence-render')
    })

    it('a part of a document shows the caret’s line as markdown only while it has the keyboard; a tab always does', () => {
        const doc = '- [ ] Build the shed\n  - **Garden**'
        const from = doc.indexOf('  - ')
        const description = () => ({ from, to: doc.length, nestedUnder: 1 })
        /** The lines revealed with the caret on the description's line, before focus or after `focused`. */
        const revealed = (host: EditorExtensionServices, focused?: boolean) => {
            let state = EditorState.create({ doc, selection: { anchor: doc.length - 2 }, extensions: [editorAnalysis(), ...editorExtensions(host)] })
            if (focused !== undefined) state = state.update({ effects: revealFocus.of(focused) }).state
            return [...revealedLines(state)]
        }
        expect(revealed(services)).toEqual([2])
        expect(revealed(services, false)).toEqual([2])
        expect(revealed({ ...services, partOfDocument: true })).toEqual([])
        expect(revealed({ ...services, partOfDocument: true }, true)).toEqual([2])
        expect(revealed({ ...services, shownRange: description })).toEqual([])
        expect(revealed({ ...services, shownRange: description }, true)).toEqual([2])
    })

    it('names the document the editor shows, when the host says which', () => {
        const build = (host: EditorExtensionServices) => EditorState.create({ extensions: [editorAnalysis(), ...editorExtensions(host)] })
        expect(build({ ...services, document: { concept: 'Acme', panelId: 'p1' } }).facet(editorDocument)).toEqual({ concept: 'Acme', panelId: 'p1' })
        expect(build(services).facet(editorDocument)).toBeNull()
    })

    it('starts on screen, or not, as the host says', () => {
        const build = (host: EditorExtensionServices) => EditorState.create({ extensions: [editorAnalysis(), ...editorExtensions(host)] })
        expect(editorIsOnScreen(build({ ...services, onScreen: () => false }))).toBe(false)
        expect(editorIsOnScreen(build(services))).toBe(true)
    })

    // Sent on every tab switch: whatever the stack does with it, the text, the caret and the undo
    // history stay exactly as they were.
    it('changes nothing in the document when told the editor went behind another tab and came back', () => {
        const doc = ['- Garden', '  - ```map', '    Kitchen @ 50.7, -1.0', '    ```', '- water the beans'].join('\n')
        let state = EditorState.create({ doc, selection: { anchor: 4 }, extensions: [localHistoryExtension(), editorAnalysis(), ...editorExtensions(services)] })
        state = state.update({ changes: { from: 4, insert: 's' }, selection: { anchor: 5 }, userEvent: 'input.type' }).state
        const before = { text: state.doc.toString(), selection: state.selection.toJSON(), undo: undoDepth(state) }
        expect(before.undo).toBe(1)
        for (const onScreen of [false, true, false]) {
            state = state.update({ effects: setEditorOnScreen.of(onScreen) }).state
            expect({ text: state.doc.toString(), selection: state.selection.toJSON(), undo: undoDepth(state) }).toEqual(before)
        }
        expect(editorIsOnScreen(state)).toBe(false)
    })

    // CodeMirror nests a later extension's mark outside an earlier one's and splits the inner one
    // at the outer's edges. A match's wash can be split freely, as a spelling underline can, where
    // a highlight's padded wash and a code line's scroll container cannot.
    it("draws find's matches inside every mark but spell check's", () => {
        before('spell-check', 'find-matches')
        before('find-matches', 'markdown-format')
        before('find-matches', 'code-scroll')
    })

    it('runs the transaction filters before anything that decorates', () => {
        before('block-selection', 'markdown-format')
        before('caret-clamp', 'markdown-format')
        before('fence-pad', 'markdown-format')
        before('frontmatter-boundary', 'markdown-format')
        before('fence-deletes', 'markdown-format')
    })

    it('judges a delete against the fences before the pad changes anything', () => {
        // Registered after the pad, the fence delete guard runs before it, so it sees the delete as
        // typed: a refused delete changes nothing, padding included (fence-guard.ts, fenceDeleteGuard).
        before('fence-pad', 'fence-deletes')
    })

    it('lets the frontmatter boundary refuse first, so a delete at the closing delimiter says why', () => {
        // Filters run last-registered first: the boundary, registered after the fence delete guard, sees
        // the delete before it and refuses with its notice (edit-refused.ts); the guard's own refusal is
        // silent, as a consumed key is.
        before('fence-deletes', 'frontmatter-boundary')
    })

    it('takes an untouched end-of-document line back after the guards have judged the caret move', () => {
        // At high precedence the take-back filter runs after every default filter, so the frontmatter
        // boundary judges the caret move alone and not the take-back riding on it, which it refuses as
        // a closer that ends the document losing the line after it (end-of-document.ts).
        let state = EditorState.create({ doc: '---\ntitle: Garden\n---', selection: { anchor: 8 }, extensions: [localHistoryExtension(), editorAnalysis(), ...editorExtensions(services)] })
        const editor = {
            get state() {
                return state
            },
            dispatch: (tr: Transaction) => {
                state = tr.state
            },
        }
        startAtEnd(editor, 'bullet')
        expect(state.doc.toString()).toBe('---\ntitle: Garden\n---\n- ')
        state = state.update({ selection: { anchor: 5 }, userEvent: 'select' }).state
        expect(state.doc.toString()).toBe('---\ntitle: Garden\n---')
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

    it('opens the line menu only where no link, asset or misspelling menu claimed the right-click', () => {
        for (const claimant of ['wikilink', 'asset-link', 'spell-check']) before(claimant, 'bookmarks')
    })

    it('gives an image line its asset menu from the keyboard, and a misspelt word in its markdown its spelling menu first', () => {
        // Shift+F10 and the Menu key. Against the line menu the precedence decides, its binding being
        // Prec.low (asserted below); the order here keeps the two in the same order as the right-click
        // claimants above. A misspelt word in the alt text is the one place the spelling menu and the
        // image's meet, and there the stack order decides.
        before('image-embed', 'bookmarks')
        before('spell-check', 'image-embed')
        const bookmarks = readFileSync(new URL('./augmentations/bookmarks.ts', import.meta.url), 'utf8')
        expect(bookmarks).toMatch(/Prec\.low\(\s*keymap\.of\(\[\s*\{ key: 'Shift-F10'/)
    })

    it('gives every open popover Enter and Tab before the YAML typing keys', () => {
        for (const popover of ['wikilink-completion', 'path-completion', 'task-tag-completion', 'slash-completion', 'frontmatter-completion', 'date-calendar', 'table-size-picker', 'concept-picker']) {
            before(popover, 'frontmatter-keys')
        }
    })

    it('reads a Plain Paste before any other paste route can reshape it', () => {
        for (const route of ['asset-paste', 'paste-to-fence', 'rich-paste']) before('plain-paste', route)
    })

    it('lets clipboard files claim a paste before the HTML route sees it', () => {
        before('asset-paste', 'rich-paste')
    })

    it('lets pasted text become an extension’s fence before the HTML beside it is pasted as rich text', () => {
        before('asset-paste', 'paste-to-fence')
        before('paste-to-fence', 'rich-paste')
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
        before('template-variables', 'code-scroll')
    })

    it('runs the Extension Fence caret filter after the caret clamp, so no clamp move leaves the caret on a fence', () => {
        // Its filters are at the highest precedence, which CodeMirror runs last, rather than placed
        // by this list. ArrowLeft at the wall is the clamp's move onto the line above, here a fence.
        const registry = createContributionRegistry()
        registerInteractiveFence(registry, 'garden.plan', { height: () => 100, mount: () => ({ update: () => {}, destroy: () => {} }) })
        setActiveContributionRegistry(registry)
        try {
            const doc = '- Intro\n- ```garden.plan\n  {"id":"k1"}\n  ```\n- After'
            const wall = doc.indexOf('After')
            const state = EditorState.create({ doc, selection: { anchor: wall }, extensions: [editorAnalysis(), ...editorExtensions(services)] })
            const moved = state.update({ selection: { anchor: wall - 1 }, userEvent: 'select' }).state
            expect(moved.selection.main.head).toBe('- Intro'.length)
        } finally {
            setActiveContributionRegistry(null)
        }
    })

    it("keeps a caret in a part shown when the Extension Fence's caret would move it onto a hidden line", () => {
        // The description ends in an Extension Fence; a move onto the fence is moved off it, onto the
        // line below, the hidden Comments bullet. The shown range's filter runs after, and keeps the
        // caret in the description (ADR 0170).
        const registry = createContributionRegistry()
        registerInteractiveFence(registry, 'garden.plan', { height: () => 100, mount: () => ({ update: () => {}, destroy: () => {} }) })
        setActiveContributionRegistry(registry)
        try {
            const doc = '- [ ] Build the shed\n  - measure\n  - ```garden.plan\n    {"id":"k1"}\n    ```\n  - Comments\n    - level'
            const measure = doc.indexOf('measure')
            const extensions = [editorAnalysis(), ...editorExtensions({ ...services, shownRange: taskPartRange('description') })]
            const state = EditorState.create({ doc, selection: { anchor: measure }, extensions }).update({ effects: anchorLine.of(0) }).state
            const moved = state.update({ selection: { anchor: doc.indexOf('{"id"') }, userEvent: 'select' }).state
            const range = shownRangeIn(moved)!
            expect(moved.selection.main.head).toBeGreaterThanOrEqual(range.from)
            expect(moved.selection.main.head).toBeLessThanOrEqual(range.to)
        } finally {
            setActiveContributionRegistry(null)
        }
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

describe("the editor of a table's cell (ADR 0205)", () => {
    const names = editorFeatures(services).map((feature) => feature.name)

    it('keeps only features the document editor has, so a renamed one is not left behind', () => {
        for (const name of CELL_FEATURES) expect(names, name).toContain(name)
    })

    it('draws no grid of its own, and leaves blocks, the outline and the document as a whole to the document editor', () => {
        for (const name of ['markdown-table', 'bullet-marker', 'content-clamp', 'fence-render', 'image-embed', 'frontmatter', 'bookmarks', 'view-hooks', 'placeholder', 'rich-paste']) {
            expect(CELL_FEATURES.has(name), name).toBe(false)
        }
    })

    it('has what a line has at the caret: links, their completion, the Command Menu, the Date Picker and spelling', () => {
        for (const name of ['wikilink', 'wikilink-completion', 'markdown-link', 'markdown-format', 'slash-completion', 'date-calendar', 'spell-check']) {
            expect(CELL_FEATURES.has(name), name).toBe(true)
        }
    })

    it('is built from the document editor\'s services, one extension for each feature it keeps', () => {
        expect(cellEditorExtensions(services)).toHaveLength(CELL_FEATURES.size)
    })
})

describe('the plain profile, for a file of a Plain Folder', () => {
    const plainServices: EditorExtensionServices = {
        ...services,
        document: { concept: 'guide/watering.md' },
        plain: {
            openLink: () => {},
            resolveMedia: async () => null,
            readOnly: () => false,
            suggestPaths: () => [],
            textOnly: (path) => path.endsWith('.txt'),
            assets: () => ({ save: async () => ({ ref: '', name: '', stem: '', isImage: false }), resolve: async () => null, readBytes: async () => null, dispose: () => {} }),
            remoteImages: { allowed: () => false, allow: () => {}, onChange: () => () => {} },
        },
    }
    const contributes = (feature: { extension: unknown }) => !(Array.isArray(feature.extension) && feature.extension.length === 0)
    const offIn = (list: ReturnType<typeof editorFeatures>) => list.filter((feature) => !contributes(feature)).map((feature) => feature.name)

    it('is the same list of features in the same order, so one order test covers both profiles', () => {
        expect(editorFeatures(plainServices).map((feature) => feature.name)).toEqual(names())
    })

    it('leaves out exactly the features that read the graph or write its syntax', () => {
        const graph = offIn(editorFeatures({ ...services, document: { concept: 'Garden' } }))
        const plain = offIn(editorFeatures(plainServices))
        expect(plain.filter((name) => !graph.includes(name))).toEqual([
            'frontmatter-boundary',
            'template-variables',
            'frontmatter',
            'frontmatter-assist',
            'protected-fence',
            'inline-panels',
            'asset-link',
            'wikilink',
            'wikilink-completion',
            'task-tag-completion',
            'frontmatter-completion',
            'date-calendar',
            'concept-picker',
        ])
    })

    it('keeps folds and bookmarks in a Plain Folder, by the file’s path', () => {
        const lineMenu = () => {}
        const withBookmarks = { ...plainServices, bookmarks: { lineMenu, draft: false, reveal: () => {} } }
        const on = editorFeatures(withBookmarks).filter(contributes).map((feature) => feature.name)
        expect(on).toContain('fold-persistence')
        expect(on).toContain('bookmarks')
    })

    it('adds only path completion, in the place wikilink completion has in a graph', () => {
        const graph = offIn(editorFeatures({ ...services, document: { concept: 'Garden' } }))
        const plain = offIn(editorFeatures(plainServices))
        expect(graph.filter((name) => !plain.includes(name))).toEqual(['path-completion'])
    })

    it('for a text file that is not markdown, keeps only what any text needs, under the same names', () => {
        const text = editorFeatures({ ...plainServices, document: { concept: 'notes/list.txt' } })
        expect(text.map((feature) => feature.name)).toEqual(names())
        const kept = text.filter(contributes).map((feature) => feature.name)
        const allowed = ['find-matches', 'selection-layer', 'placeholder', 'edit-refusal', 'editor-document', 'on-screen', 'line-anchor', 'line-numbers', 'keep-caret-visible', 'column-shift', 'selection-order', 'view-hooks']
        expect(kept.filter((name) => !allowed.includes(name))).toEqual([])
        // What reads markdown is gone, and what any text needs is there.
        for (const name of ['markdown-format', 'bullet-marker', 'task-checkbox', 'outline-guides', 'wrap-selection', 'markdown-link', 'image-embed', 'caret-clamp']) expect(kept).not.toContain(name)
        for (const name of ['find-matches', 'selection-layer', 'editor-document', 'line-numbers', 'view-hooks']) expect(kept).toContain(name)
    })

    it('opens a markdown file as text when the profile says so: the same features as any other text', () => {
        const asText = { ...plainServices, plain: { ...plainServices.plain!, textOnly: () => true } }
        const markdown = editorFeatures({ ...asText, document: { concept: 'guide/watering.md' } }).filter(contributes)
        const script = editorFeatures({ ...asText, document: { concept: 'water.sh' } }).filter(contributes)
        expect(markdown.map((feature) => feature.name)).toEqual(script.map((feature) => feature.name))
    })

    it('bookmarks the lines of a text file, in a column before its line numbers', () => {
        const withBookmarks = { ...plainServices, document: { concept: 'notes/list.txt' }, bookmarks: { lineMenu: () => {}, draft: false, reveal: () => {} } }
        const on = editorFeatures(withBookmarks).filter(contributes).map((feature) => feature.name)
        // CodeMirror puts an earlier extension's gutter before a later one's.
        expect(on.indexOf('bookmarks')).toBeGreaterThanOrEqual(0)
        expect(on.indexOf('line-numbers')).toBeGreaterThan(on.indexOf('bookmarks'))
    })

    it('numbers no lines in the Markdown Editor, in a Plain Folder or a graph', () => {
        expect(offIn(editorFeatures(plainServices))).toContain('line-numbers')
        expect(offIn(editorFeatures({ ...services, document: { concept: 'Garden' } }))).toContain('line-numbers')
    })

    it('builds an editor state with no graph, no store and no DOM', () => {
        const state = EditorState.create({ doc: '- water the [[beans]]\n', extensions: [editorAnalysis(), ...editorFeatures(plainServices).map((f) => f.extension)] })
        expect(state.doc.toString()).toBe('- water the [[beans]]\n')
    })
})
