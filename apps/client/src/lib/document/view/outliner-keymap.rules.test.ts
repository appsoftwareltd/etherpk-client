/**
 * The keyboard rule tables from Editor Content Rules.md, executable.
 *
 * Each row is one rule: the fixture before the key, the key, the fixture after, and the precedent
 * the behaviour is modelled on. The doc and this file share the fixture notation
 * (`testing/editor-state-fixture.ts`), so a rule that exists in one and not the other is a visible
 * gap, and a behaviour change edits both. Rows run in Node against a real `EditorState`; the
 * browser specs under `tests-client/outliner*` and `fenced-code*` keep the geometry and the
 * real-keyboard paths.
 *
 * Reading a row: `- a|` is a caret after "a"; `«…»` is a selection.
 *
 * Presentation rows (the `shows` tables) have no key: the fixture and what the formatting pass
 * displays for it, the caret deciding which lines reveal their source, as in the editor.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { undoDepth } from '@codemirror/commands'
import { type Transaction, type TransactionSpec } from '@codemirror/state'
import { EditorView, keymap, showTooltip, type WidgetType } from '@codemirror/view'

import { createContributionRegistry, setActiveContributionRegistry } from '$lib/surface'

import { hiddenSyntax, type HiddenSyntaxSpec, hiddenSyntaxPieces } from './augmentations/base-renderer'
import { followFenceRegistrations, interactiveFenceAugmentation } from './augmentations/interactive-fence'
import { addInlinePanel, inlinePanelsField, panelCaretBlocks, planPanelInsert, removeInlinePanel } from './augmentations/inline-panels'
import { endOfDocument, type EndKind, startAtEnd, takeBackIfLeft } from './end-of-document'
import { type InteractiveFence, registerInteractiveFence } from './augmentations/interactive-fence-contract'
import { pasteAsFence } from './augmentations/paste-to-fence'
import { markdownWithCodeHighlight } from './augmentations/code-highlight'
import { markdownFormatSpec, RULE_LINE_CLASS } from './augmentations/markdown-format'
import { markdownLinkSpec } from './augmentations/markdown-link'
import { markdownTableAugmentation } from './augmentations/markdown-table'
import { guideThreadsFor } from './augmentations/outline-guides'
import { wikilinkCompletion } from './augmentations/wikilink-complete'
import { refreshWikilinks, wikilinkAugmentation } from './augmentations/wikilink'
import { displayNameForRef } from '../../storage/fs/asset-store'
import { collaborative, isEdit } from './cm-document'
import { bookmarkMarks, bookmarkedLines, syncBookmarkMarks } from './augmentations/bookmark-marks'
import { captureAnchor } from '../bookmarks/anchor'
import { outdentBranch, toggleBullet } from './outliner-keymap'
import { PLAIN_PASTE_USER_EVENT } from './paste-clamp'
import { analysisFor } from './analysis/editor-analysis'
import { bulletToggleable, taskToggleable } from './task-toggleable'
import { checkboxClick } from './augmentations/task-checkbox'
import { lineIndent } from '../outliner'
import { editorFixture, type FixtureOptions, press } from './testing/editor-state-fixture'
import { FIND_REPLACE_EVENT, FIND_SELECT_EVENT } from '../find/find-edit'
import { wikilinkButtonSpec } from './wrap-selection'
import { insertTemplate } from './template-insert'
import { renderTemplate } from '../templates/template-variables'

interface Rule {
    rule: string
    /** Which editor the behaviour is borrowed from, so a reviewer has a reference to check against. */
    precedent: 'Logseq' | 'Obsidian' | 'VS Code' | 'CommonMark' | 'EtherPK' | 'AS Notes'
    before: string
    key: string
    after: string
}

function table(name: string, rows: Rule[], options: FixtureOptions = {}) {
    describe(name, () => {
        for (const row of rows) {
            it(`${row.key}: ${row.rule} (${row.precedent})`, () => {
                expect(press(row.before, row.key, options)).toBe(row.after)
            })
        }
    })
}

// The position is a state rule; wrapping and pane bounds need the browser regression in
// tests-client/wikilink-complete.test.ts (Editor Content Rules → Completion popovers).
describe('completion popovers (EtherPK)', () => {
    for (const row of [
        { rule: 'an open query anchors at the caret, including after typing', before: '- [[A long concept name|' },
        { rule: 'entering an existing link anchors at the caret', before: '- [[A long |concept name]]' },
    ]) {
        it(row.rule, () => {
            const editor = editorFixture(row.before, {
                extensions: [wikilinkCompletion({ concepts: () => [] })],
            })
            expect(editor.state.facet(showTooltip).filter(Boolean).map((tooltip) => tooltip!.pos))
                .toEqual([editor.head()])
            editor.dispatch(editor.state.update(editor.state.replaceSelection('more ')))
            expect(editor.state.facet(showTooltip).filter(Boolean).map((tooltip) => tooltip!.pos))
                .toEqual([editor.head()])
        })
    }
})

// Find and Replace (ADR 0153) puts the selection on a match and replaces text, and neither is the
// user typing in a link: a popover either opened would sit over the text while focus is in the find
// box (Editor Content Rules → Find and Replace).
describe('find and replace open no popover (VS Code)', () => {
    const concepts = [{ display: 'Garden', key: 'garden', kind: 'page' as const }]
    const editor = () => editorFixture('- [[Garden]] notes|', { extensions: [wikilinkCompletion({ concepts: () => concepts })] })
    const tooltips = (e: ReturnType<typeof editor>) => e.state.facet(showTooltip).filter(Boolean)

    it('a selection the user makes on a link name offers completion, as it does today', () => {
        const e = editor()
        e.dispatch(e.state.update({ selection: { anchor: 4, head: 10 }, userEvent: 'select' }))
        expect(tooltips(e)).toHaveLength(1)
    })

    it('a match find selects inside a link opens no completion', () => {
        const e = editor()
        e.dispatch(e.state.update({ selection: { anchor: 4, head: 10 }, userEvent: FIND_SELECT_EVENT }))
        expect(tooltips(e)).toEqual([])
    })

    it('a replace inside a link opens no completion', () => {
        const e = editor()
        e.dispatch(e.state.update({ selection: { anchor: 10 } }))
        e.dispatch(e.state.update({ changes: { from: 4, to: 10, insert: 'Yard' }, selection: { anchor: 8 }, userEvent: FIND_REPLACE_EVENT }))
        expect(tooltips(e)).toEqual([])
    })
})

// Accepting a completion closes the link being completed and no other (Editor Content Rules →
// Completion popovers). Text alone cannot say whose a `]]` is in `[[A [[B|]]`: a link typed into A,
// or an existing B inside an A not yet closed. What decides is whether a `[` was typed inside a
// link whose `]]` it is.
describe('accepting a completion inside another link (EtherPK)', () => {
    const concepts = [
        { display: 'Quantum', key: 'quantum', kind: 'page' as const },
        { display: 'Physics', key: 'physics', kind: 'page' as const },
    ]
    /** Type `typed` a key at a time at the fixture's caret, then press the popover's Enter. */
    function accept(before: string, typed = ''): string {
        const editor = editorFixture(before, { extensions: [wikilinkCompletion({ concepts: () => concepts })] })
        for (const key of typed) editor.type(key)
        // The popover dispatches a spec, as a view takes one, and reads the state back after it.
        const view = {
            get state() {
                return editor.state
            },
            dispatch: (spec: TransactionSpec) => editor.dispatch(editor.state.update(spec)),
        }
        // The popover's own Enter, which sits above the outliner's in the keymap.
        const bindings = editor.state.facet(keymap).flat().filter((binding) => binding.key === 'Enter')
        expect(bindings.some((binding) => binding.run?.(view as never) ?? false)).toBe(true)
        return editor.fixture()
    }

    for (const row of [
        { rule: 'a link typed inside another leaves the outer link its ]]', before: '- [[Physics |]] now', typed: '[[Quan', after: '- [[Physics [[Quantum]]|]] now' },
        { rule: '…typed in the middle of its text too', before: '- [[Physics | theory]] now', typed: '[[Quan', after: '- [[Physics [[Quantum]]| theory]] now' },
        { rule: 'an existing inner link is completed over its own ]]', before: '- [[Physics [[Qu|an]]]] now', after: '- [[Physics [[Quantum]]|]] now' },
        { rule: '…and so is one inside an outer link not yet closed', before: '- [[[[Phy|sics]] Quantum', after: '- [[[[Physics]]| Quantum' },
        { rule: 'a stray [[ earlier on the line takes no ]] from the link after it', before: '- a [[ b, see [[Phy|sics]] now', after: '- a [[ b, see [[Physics]]| now' },
        { rule: 'nor does a [[ in inline code', before: '- tap the `[[` button ([[Phy|sics]]).', after: '- tap the `[[` button ([[Physics]]|).' },
        { rule: 'a link on its own is completed over its ]]', before: '- see [[Qu|an]] now', after: '- see [[Quantum]]| now' },
        { rule: 'an unclosed link is closed', before: '- see [[Quan| now', after: '- see [[Quantum]]| now' },
    ]) {
        it(`Enter: ${row.rule}`, () => {
            expect(accept(row.before, row.typed)).toBe(row.after)
        })
    }
})

/**
 * Press `key` with the caret as `before` puts it, recording both ways a link opens: `opened` in
 * place (Alt+Enter), `openedRight` in the Pane to the right (Mod+Alt+Enter). `toTheRight: false`
 * leaves the second callback out, as a host with no Layout does.
 */
function pressOnLink(key: string, before: string, options: { typeFirst?: string; toTheRight?: boolean } = {}) {
    const opened: string[] = []
    const openedRight: string[] = []
    const editor = editorFixture(before, {
        extensions: [
            wikilinkAugmentation({
                onOpen: (concept) => opened.push(concept),
                ...(options.toTheRight === false ? {} : { onOpenToTheRight: (concept: string) => openedRight.push(concept) }),
            }),
        ],
    })
    // Typing first takes the analysis down its incremental path, as live editing does.
    if (options.typeFirst) editor.type(options.typeFirst)
    const bindings = editor.state.facet(keymap).flat().filter((binding) => binding.key === key)
    const handled = bindings.some((binding) => binding.run?.(editor as never) ?? false)
    return { opened, openedRight, handled, after: editor.fixture() }
}

// Following a link is a read: the key never edits, and outside a link it is not handled, so the
// keys under it keep their meaning (Editor Content Rules → Following a link).
describe('Alt+Enter follows the link at the caret (Obsidian)', () => {
    const follow = (before: string, typeFirst?: string) => pressOnLink('Alt-Enter', before, { typeFirst })

    for (const row of [
        { rule: 'inside the link text', before: '- see [[Phys|ics]] now', opens: ['Physics'] },
        { rule: 'on its brackets', before: '- see [|[Physics]] now', opens: ['Physics'] },
        { rule: 'just before its opening brackets', before: '- see |[[Physics]] now', opens: ['Physics'] },
        { rule: 'just after its closing brackets', before: '- see [[Physics]]| now', opens: ['Physics'] },
        { rule: 'the innermost of nested links', before: '- [[Types of [[Pl|ant]]]]', opens: ['Plant'] },
        { rule: 'the outer link, outside the inner one', before: '- [[Ty|pes of [[Plant]]]]', opens: ['Types of [[Plant]]'] },
        { rule: 'nothing outside a link', before: '- se|e [[Physics]] now', opens: [] },
        { rule: 'nothing for a link inside code', before: '- `[[Phys|ics]]`', opens: [] },
        { rule: 'nothing with a selection', before: '- see [[«Phys»ics]] now', opens: [] },
        { rule: 'the link it touches from the left, between two touching links', before: '- [[A]]|[[B]]', opens: ['B'] },
    ]) {
        it(row.rule, () => {
            const result = follow(row.before)
            expect(result.opened).toEqual(row.opens)
            expect(result.openedRight).toEqual([])
            expect(result.handled).toBe(row.opens.length > 0)
            expect(result.after).toBe(row.before)
        })
    }

    it('nothing for a link in the frontmatter block, after typing on its line', () => {
        const result = follow('---\nrelated: "[[Phys|ics]]"\n---\n- body', 'x')
        expect(result.opened).toEqual([])
        expect(result.handled).toBe(false)
    })
})

// The same link, opened in the Pane to the right (ADR 0155): Obsidian's "Open link under cursor to
// the right", on its chord. The key finds the link by Alt+Enter's rule and is a read in the same way
// (Editor Content Rules → Following a link).
describe('Mod+Alt+Enter opens the link at the caret in the Pane to the right (Obsidian)', () => {
    const follow = (before: string) => pressOnLink('Mod-Alt-Enter', before)

    for (const row of [
        { rule: 'inside the link text', before: '- see [[Gar|den]] now', opens: ['Garden'] },
        { rule: 'just after its closing brackets', before: '- see [[Garden]]| now', opens: ['Garden'] },
        { rule: 'the innermost of nested links', before: '- [[Beds of [[Ro|ses]]]]', opens: ['Roses'] },
        { rule: 'nothing outside a link', before: '- se|e [[Garden]] now', opens: [] },
        { rule: 'nothing for a link inside code', before: '- `[[Gar|den]]`', opens: [] },
        { rule: 'nothing with a selection', before: '- see [[«Gar»den]] now', opens: [] },
    ]) {
        it(row.rule, () => {
            const result = follow(row.before)
            expect(result.openedRight).toEqual(row.opens)
            expect(result.opened).toEqual([])
            expect(result.handled).toBe(row.opens.length > 0)
            expect(result.after).toBe(row.before)
        })
    }

    it('nothing where the host cannot open beside the editor', () => {
        const result = pressOnLink('Mod-Alt-Enter', '- see [[Gar|den]] now', { toTheRight: false })
        expect(result.handled).toBe(false)
        expect(result.opened).toEqual([])
    })
})

describe('completion over a wrapped word (EtherPK, ADR 0077)', () => {
    const physics = { display: 'Physics', key: 'physics', kind: 'page' as const }
    const tooltips = (editor: ReturnType<typeof editorFixture>) =>
        editor.state.facet(showTooltip).filter(Boolean).map((tooltip) => tooltip!.pos)

    it('opens on the word a second [ has just enclosed, with the word as the query', () => {
        const editor = editorFixture('- read [«Physics»] today', { extensions: [wikilinkCompletion({ concepts: () => [physics] })] })
        editor.type('[')
        expect(editor.fixture()).toBe('- read [[«Physics»]] today')
        expect(tooltips(editor)).toEqual([editor.head()])
    })

    it('opens on the word the Command Bar [[ button has just enclosed, and closes when ]] finishes the link', () => {
        const editor = editorFixture('- read «Physics» today', { extensions: [wikilinkCompletion({ concepts: () => [physics] })] })
        editor.dispatch(editor.state.update(wikilinkButtonSpec(editor.state, '[[')))
        expect(editor.fixture()).toBe('- read [[«Physics»]] today')
        expect(tooltips(editor)).toEqual([editor.head()])
        editor.dispatch(editor.state.update(wikilinkButtonSpec(editor.state, ']]')))
        expect(editor.fixture()).toBe('- read [[Physics]]| today')
        expect(tooltips(editor)).toEqual([])
    })

    it('stays closed for a selection that reaches past the [[', () => {
        const editor = editorFixture('- read «[[Physics»]] today', { extensions: [wikilinkCompletion({ concepts: () => [physics] })] })
        expect(tooltips(editor)).toEqual([])
    })

    it('stays closed for a selection made right to left', () => {
        const editor = editorFixture('- read [[Physics|]] today', { extensions: [wikilinkCompletion({ concepts: () => [physics] })] })
        editor.select(16, 9)
        expect(tooltips(editor)).toEqual([])
    })
})

// ── Editor Content Rules → Standard prose ────────────────────────────────────────────────────

// A table off the caret renders its cells as the editor renders a line off the caret: a link is a
// link, marks are styled, syntax is hidden (Editor Content Rules → Standard prose). Rendered with
// just enough DOM for the widget to build into; the browser suite keeps the click and the layout.
describe('a table cell renders its inline markdown (Obsidian)', () => {
    class FakeElement {
        className = ''
        style: Record<string, string> = {}
        attrs = new Map<string, string>()
        children: Array<FakeElement | { text: string }> = []
        constructor(readonly tag: string) {}
        set textContent(text: string) {
            this.children = [{ text }]
        }
        setAttribute(name: string, value: string) {
            this.attrs.set(name, value)
        }
        appendChild<T extends FakeElement | { text: string }>(child: T): T {
            this.children.push(child)
            return child
        }
    }
    const textOf = (node: FakeElement | { text: string }): string =>
        'text' in node ? node.text : node.children.map(textOf).join('')
    const all = (node: FakeElement): FakeElement[] =>
        [node, ...node.children.flatMap((child) => (child instanceof FakeElement ? all(child) : []))]
    const classes = (node: FakeElement) => all(node).map((el) => el.className).filter(Boolean)

    afterEach(() => vi.unstubAllGlobals())

    /** The table widget over the fixture, the caret being off it. */
    function tableWidget(editor: ReturnType<typeof editorFixture>): WidgetType {
        const widgets: WidgetType[] = []
        for (const set of editor.state.facet(EditorView.decorations)) {
            if (typeof set === 'function') continue
            for (const cursor = set.iter(); cursor.value; cursor.next()) {
                const widget = cursor.value.spec.widget as WidgetType | undefined
                if (widget) widgets.push(widget)
            }
        }
        return widgets[0]
    }

    function render(doc: string, options: Parameters<typeof markdownTableAugmentation>[0] = {}) {
        vi.stubGlobal('document', {
            createElement: (tag: string) => new FakeElement(tag),
            createTextNode: (text: string) => ({ text }),
        })
        const editor = editorFixture(doc, { caret: '¦', extensions: [markdownTableAugmentation(options)] })
        /** The rows of cells, header first, as the grid draws them. */
        const rows = (widget = tableWidget(editor)) => {
            const table = widget.toDOM(null as never) as unknown as FakeElement
            return all(table).filter((el) => el.tag === 'tr').map((tr) => tr.children as FakeElement[])
        }
        return { editor, rows }
    }

    const TABLE = [
        '| **Plant** | Kind | Link |',
        '| --- | --- | --- |',
        '| [[Fern]] | **leafy** and `green` | [docs](https://example.com/ferns) |',
        '| ![](../assets/pic.11111111-1111-4111-8111-111111111111.png) | $x^2$ | plain |',
        '',
        'after¦',
    ].join('\n')

    it('a wikilink in a cell is a link to its page', () => {
        const [, [fern]] = render(TABLE).rows()
        const link = all(fern).find((el) => el.className.split(' ').includes('cm-wikilink'))
        expect(link?.attrs.get('data-concept')).toBe('Fern')
        expect(textOf(link!)).toBe('[[Fern]]')
    })

    it('marks style their text and hide their syntax, in a header cell too', () => {
        const [[plant], [, kind]] = render(TABLE).rows()
        expect(textOf(plant)).toBe('Plant')
        expect(classes(plant)).toEqual(['cm-md-strong'])
        expect(textOf(kind)).toBe('leafy and green')
        expect(classes(kind)).toEqual(['cm-md-strong', 'cm-md-code'])
    })

    it('a hyperlink carries the address the link handler opens', () => {
        const [, [, , docs]] = render(TABLE).rows()
        const link = all(docs).find((el) => el.className === 'cm-md-link')
        expect(link?.attrs.get('data-href')).toBe('https://example.com/ferns')
        expect(textOf(link!)).toBe('docs')
    })

    it('an image with no alt text shows its file name, and maths its source', () => {
        const [, , [image, maths]] = render(TABLE).rows()
        expect(textOf(image)).toBe(displayNameForRef('../assets/pic.11111111-1111-4111-8111-111111111111.png'))
        expect(textOf(image)).not.toBe('')
        expect(textOf(maths)).toBe('$x^2$')
    })

    it('a link to a page that does not exist is dashed until the index says it does', () => {
        const pages = new Set<string>()
        const { editor, rows } = render(TABLE, { isMissing: (concept) => !pages.has(concept) })
        const before = tableWidget(editor)
        const fernClasses = (widget: WidgetType) => classes(rows(widget)[1][0])
        expect(fernClasses(before)).toEqual(['cm-wikilink cm-wikilink--missing'])

        pages.add('Fern')
        editor.dispatch(editor.state.update({ effects: refreshWikilinks.of(null) }))

        const after = tableWidget(editor)
        expect(after.eq(before)).toBe(false)
        expect(fernClasses(after)).toEqual(['cm-wikilink'])
    })
})

table('prose is deliberately boring', [
    { rule: 'Enter is a plain newline', precedent: 'VS Code', before: 'text|', key: 'Enter', after: 'text\n|' },
    { rule: 'Tab makes the line a block at column 0, caret on the same character', precedent: 'EtherPK', before: 'te|xt', key: 'Tab', after: '- te|xt' },
    { rule: 'Tab on an empty line opens an empty bullet', precedent: 'EtherPK', before: '|', key: 'Tab', after: '- |' },
    { rule: 'Tab on a heading is refused', precedent: 'EtherPK', before: '# h|', key: 'Tab', after: '# h|' },
    { rule: 'Tab on a continuation makes it a child of its bullet', precedent: 'EtherPK', before: '- a\n  te|xt', key: 'Tab', after: '- a\n  - te|xt' },
    { rule: '…with a range selected inside it too, the caret kept at the range’s head', precedent: 'EtherPK', before: '- a\n  «so»ft\n  - child', key: 'Tab', after: '- a\n  - so|ft\n  - child' },
    { rule: 'Tab on an unterminated fence line is refused: as a bullet it would take the next block’s fence for its closer', precedent: 'EtherPK', before: '```py|\n- b\n  ```\n  code\n  ```', key: 'Tab', after: '```py|\n- b\n  ```\n  code\n  ```' },
    // Only a continuation nests: any other prose line enters the list at column 0, whatever its spaces.
    // Kept, they would make an indented bullet under nothing, or one off the grid.
    { rule: 'Tab on indented prose with no bullet above makes a block at column 0', precedent: 'EtherPK', before: 'para\n  te|xt', key: 'Tab', after: 'para\n- te|xt' },
    { rule: 'Tab on a line one space in under a list makes a block at column 0: it is prose', precedent: 'EtherPK', before: '- a\n te|xt', key: 'Tab', after: '- a\n- te|xt' },
    { rule: 'Tab on a line after a blank line in a list makes a block at column 0: it is in no block', precedent: 'EtherPK', before: '- a\n  - b\n\n    te|xt', key: 'Tab', after: '- a\n  - b\n\n- te|xt' },
    { rule: 'Tab heals the bullets below a prose line it joins to the list: one level under the new block at most', precedent: 'EtherPK', before: '- a\n  - b\n te|xt\n    - c', key: 'Tab', after: '- a\n  - b\n- te|xt\n  - c' },
    { rule: '…past a blank soft line, a code block after it staying the new block’s', precedent: 'EtherPK', before: 'Sho|pping\n      - eggs\n  \n  ```py\n  if x:\n      y\n  ```', key: 'Tab', after: '- Sho|pping\n  - eggs\n  \n  ```py\n  if x:\n      y\n  ```' },
    { rule: '…and under a continuation it makes a child, measured from there', precedent: 'EtherPK', before: '- a\n  te|xt\n      - c', key: 'Tab', after: '- a\n  - te|xt\n    - c' },
    { rule: 'Tab on a line nested under a soft line makes it a child of the bullet the outline gives it', precedent: 'EtherPK', before: '- a\n  cont\n    dee|per', key: 'Tab', after: '- a\n  cont\n  - dee|per' },
    { rule: 'Alt+Up is the ordinary line move', precedent: 'VS Code', before: 'one\ntwo|', key: 'Alt-ArrowUp', after: 'two|\none' },
    { rule: 'Alt+Down is the ordinary line move', precedent: 'VS Code', before: 'one|\ntwo', key: 'Alt-ArrowDown', after: 'two\none|' },
    { rule: 'a heading edits as a plain line', precedent: 'Obsidian', before: '# Title|', key: 'Enter', after: '# Title\n|' },
])

// A space typed at column 0 goes where it is typed. Under a list, a line short of the bullet's content
// column is still prose, so the caret stays after the space; the space that reaches the column makes
// the line the bullet's continuation. (The typed table splits its key on spaces, hence the rows.)
describe('prose is deliberately boring: leading spaces', () => {
    const spaces = (before: string, count: number) => {
        const editor = editorFixture(before)
        for (let k = 0; k < count; k++) editor.type(' ')
        return editor.fixture()
    }
    it('a space typed at column 0 of prose stays where it is typed (Obsidian)', () => {
        expect(spaces('|text', 1)).toBe(' |text')
    })
    it('…and under a list, short of the bullet’s content column (Obsidian)', () => {
        expect(spaces('- a\n|text', 1)).toBe('- a\n |text')
        expect(spaces('- a\n\n|text', 1)).toBe('- a\n\n |text')
    })
    it('the space that reaches the content column makes the line the bullet’s continuation, the caret after it (EtherPK)', () => {
        expect(spaces('- a\n|text', 2)).toBe('- a\n  |text')
    })
})

// ── Editor Content Rules → Standard prose → Rules and heading underlines ─────────────────────

/** The tag a decoration's class is shown as in {@link presented}, or null for one it leaves out. */
function shownAs(cls: string): string | null {
    const heading = /cm-md-(h\d)/.exec(cls)
    if (heading) return heading[1]
    if (cls.includes('cm-md-code')) return 'code'
    if (cls.includes('cm-md-strike')) return 's'
    if (cls.includes('cm-md-highlight')) return 'mark'
    if (cls.includes('cm-md-link')) return 'a'
    return null
}

/**
 * A document as an inline augmentation presents it, in text: hidden syntax removed, a line drawn as
 * a rule shown as `────` after whatever of the line stays visible (a bullet's marker), heading text
 * wrapped in `<hN>…</hN>`, and inline code, strikethrough, highlight and links in `<code>`, `<s>`,
 * `<mark>` and `<a>`. The pieces are the ones the plugin draws (`hiddenSyntaxPieces`, which clips
 * them), from the inline formatting unless another declaration is named. The caret in the fixture
 * decides which lines reveal their source, exactly as in the editor. Presentation, not a key: rows
 * here have `shows` instead of `key`/`after`.
 */
function presented(fixture: string, caret?: string, spec: HiddenSyntaxSpec = markdownFormatSpec): string {
    const { state } = editorFixture(fixture, { extensions: [markdownWithCodeHighlight()], caret })
    const decorations = hiddenSyntaxPieces(spec, state, [{ from: 0, to: state.doc.length }])
    const hidden = decorations.filter((d) => d.value === hiddenSyntax)
    const classOf = (d: (typeof decorations)[number]) => (d.value.spec as { class?: string }).class ?? ''
    const ruleLines = new Set(decorations.filter((d) => d.from === d.to && classOf(d).includes(RULE_LINE_CLASS)).map((d) => state.doc.lineAt(d.from).number))
    // In decoration order, which is the tree's: an outer construct's mark before an inner one's.
    const marks = decorations.flatMap((d) => {
        const tag = d.from < d.to ? shownAs(classOf(d)) : null
        return tag ? [{ from: d.from, to: d.to, tag }] : []
    })
    const out: string[] = []
    for (let n = 1; n <= state.doc.lines; n++) {
        const line = state.doc.line(n)
        let text = ''
        let open: string[] = []
        for (let pos = line.from; pos < line.to; pos++) {
            if (hidden.some((h) => h.from <= pos && pos < h.to)) continue
            const tags = marks.filter((m) => m.from <= pos && pos < m.to).map((m) => m.tag)
            let kept = 0
            while (kept < open.length && open[kept] === tags[kept]) kept++
            for (let k = open.length - 1; k >= kept; k--) text += `</${open[k]}>`
            for (let k = kept; k < tags.length; k++) text += `<${tags[k]}>`
            open = tags
            text += state.doc.sliceString(pos, pos + 1)
        }
        for (let k = open.length - 1; k >= 0; k--) text += `</${open[k]}>`
        out.push(ruleLines.has(n) ? `${text}────` : text)
    }
    return out.join('\n')
}

interface PresentationRow {
    rule: string
    precedent: Rule['precedent']
    before: string
    shows: string
    /** Where the caret is written, when the fixture needs a `|` of its own. */
    caret?: string
    /** The declaration presented, when it is not the inline formatting. */
    spec?: HiddenSyntaxSpec
}

function presentationTable(name: string, rows: PresentationRow[]) {
    describe(name, () => {
        for (const row of rows) {
            it(`${row.rule} (${row.precedent})`, () => {
                expect(presented(row.before, row.caret, row.spec)).toBe(row.shows)
            })
        }
    })
}

presentationTable('a --- in the body is a rule, or a heading’s underline where markdown says so', [
    { rule: 'a --- on its own after a blank line is drawn as a rule', precedent: 'CommonMark', before: 'a\n\n---\n\nb|', shows: 'a\n\n────\n\nb' },
    { rule: '*** and ___ are rules too', precedent: 'CommonMark', before: '***\n\n___\n\nx|', shows: '────\n\n────\n\nx' },
    { rule: 'the caret’s line shows the rule’s source', precedent: 'Obsidian', before: 'a\n\n---|', shows: 'a\n\n---' },
    { rule: 'a --- at column 0 under a bullet is a rule, not part of the bullet', precedent: 'CommonMark', before: '- a\n---\n- b|', shows: '- a\n────\n- b' },
    { rule: 'a bullet whose text is --- keeps its marker and draws the rule after it', precedent: 'Logseq', before: '- a\n- ---\n- b|', shows: '- a\n- ────\n- b' },
    { rule: 'a nested bullet’s rule starts at its content column', precedent: 'Logseq', before: '- a\n  - ---\n- b|', shows: '- a\n  - ────\n- b' },
    { rule: 'a rule in a quote is drawn inside the quote', precedent: 'CommonMark', before: '> ---\n\nx|', shows: '────\n\nx' },
    { rule: 'a --- after an ATX heading is a rule; the heading keeps its own level', precedent: 'CommonMark', before: '# H\n---\n\nx|', shows: '<h1>H</h1>\n────\n\nx' },
    { rule: 'the frontmatter’s delimiters are never rules', precedent: 'EtherPK', before: '---\ntitle: A\n---\nbody|', shows: '---\ntitle: A\n---\nbody' },
    { rule: 'a frontmatter opener still being typed is not a rule either', precedent: 'EtherPK', before: '---\ntitle: A|', shows: '---\ntitle: A' },
    { rule: 'a --- directly under a line of text underlines it as a level-two heading', precedent: 'CommonMark', before: 'Title\n---\n\nx|', shows: '<h2>Title</h2>\n\n\nx' },
    { rule: 'a === underline makes a level-one heading', precedent: 'CommonMark', before: 'Title\n===\n\nx|', shows: '<h1>Title</h1>\n\n\nx' },
    { rule: 'the underline shows while the caret is on any line of its heading', precedent: 'EtherPK', before: 'Ti|tle\n---\n\nx', shows: '<h2>Title</h2>\n---\n\nx' },
    { rule: 'a soft line of --- under a bullet’s text makes that text a heading', precedent: 'CommonMark', before: '- a\n  ---\n- b|', shows: '- <h2>a</h2>\n  \n- b' },
    { rule: 'a quoted heading’s underline hides its > with the ---', precedent: 'EtherPK', before: '> Title\n> ---\n\nx|', shows: '<h2>Title</h2>\n\n\nx' },
    // CommonMark also reads these as underlines, but the outliner reads them otherwise: an empty
    // bullet (Tab on an empty line under prose makes one), and the first one or two keystrokes of
    // a bullet, a rule or an ==highlight==. Styling the line above would move everything below.
    { rule: 'an empty bullet under prose is a bullet, not an underline', precedent: 'EtherPK', before: 'Some text\n- |', shows: 'Some text\n- ' },
    { rule: 'with the caret elsewhere the empty bullet stays visible and the text above stays prose', precedent: 'EtherPK', before: 'x|\n\nSome text\n- ', shows: 'x\n\nSome text\n- ' },
    { rule: 'a lone - or -- typed under prose restyles nothing', precedent: 'EtherPK', before: 'Some text\n--|', shows: 'Some text\n--' },
    { rule: 'a lone = typed under prose restyles nothing: the start of ==highlight==', precedent: 'EtherPK', before: 'Some text\n=|', shows: 'Some text\n=' },
    { rule: 'a --- under a GFM table is a rule after the table, as GFM renderers draw it', precedent: 'CommonMark', before: '| a | b |\n| - | - |\n| 1 | 2 |\n---\n\nx§', caret: '§', shows: '| a | b |\n| - | - |\n| 1 | 2 |\n────\n\nx' },
    { rule: 'a rule after another list marker is kept as typed, like the marker', precedent: 'EtherPK', before: '* ---\n\n1. ---\n\nx|', shows: '* ---\n\n1. ---\n\nx' },
    { rule: 'a --- the editor’s fence scan places inside a code block stays code', precedent: 'EtherPK', before: '```\n ```\n---\n```\n\nx|', shows: '```\n ```\n---\n```\n\nx' },
    { rule: 'the body keeps its formatting while a frontmatter opener is still being typed', precedent: 'EtherPK', before: '---\ntitle: A|\n\n# H', shows: '---\ntitle: A\n\n<h1>H</h1>' },
])

// ── Editor Content Rules → Standard prose → A mark across a line break ───────────────────────

// A paragraph's later lines lose their leading whitespace (CommonMark: the paragraph's raw content
// is its lines with initial spaces removed), and a quote's `>` is its container, not its text. So a
// mark over a soft line break starts the next line at its text. Over the indent it was drawn inside
// the prefix the content clamp lifts out of the flow, painted over the start of the text.
presentationTable('a mark that runs onto the next line starts that line at its text', [
    { rule: 'inline code over a bullet’s soft line break starts the continuation at its text, not its indent', precedent: 'CommonMark', before: '- a `b\n  c` d\n- x|', shows: '- a <code>b</code>\n  <code>c</code> d\n- x' },
    { rule: 'the same for a continuation indented past the content column', precedent: 'CommonMark', before: '   - a `b\n      c` d\n- x|', shows: '   - a <code>b</code>\n      <code>c</code> d\n- x' },
    { rule: 'the same for an indented line of a prose paragraph', precedent: 'CommonMark', before: 'Some `code\n   more` text\n\nx|', shows: 'Some <code>code</code>\n   <code>more</code> text\n\nx' },
    { rule: 'a line in the middle is covered from its text to its end', precedent: 'CommonMark', before: '- a `b\n  c\n  d` e\n- x|', shows: '- a <code>b</code>\n  <code>c</code>\n  <code>d</code> e\n- x' },
    { rule: 'strikethrough does the same', precedent: 'CommonMark', before: '- a ~~b\n  c~~ d\n- x|', shows: '- a <s>b</s>\n  <s>c</s> d\n- x' },
    { rule: 'highlight does the same', precedent: 'CommonMark', before: '- a ==b\n  c== d\n- x|', shows: '- a <mark>b</mark>\n  <mark>c</mark> d\n- x' },
    { rule: 'a link’s label does the same', precedent: 'CommonMark', before: '- see [a long\n  label](https://example.com) here\n- x|', shows: '- see <a>a long</a>\n  <a>label</a> here\n- x', spec: markdownLinkSpec },
    { rule: 'a quoted line starts after its >', precedent: 'CommonMark', before: '> a `b\n> c` d|', shows: 'a <code>b</code>\n> <code>c`</code> d' },
    // Four spaces in, a `>` cannot open a quote inside a paragraph: it is the paragraph's text.
    { rule: 'a > the parser reads as text is covered as text', precedent: 'CommonMark', before: 'Some `code\n    > more` text\n\nx|', shows: 'Some <code>code</code>\n    <code>> more</code> text\n\nx' },
    // CommonMark reads the line as the paragraph's text; the outline reads a bullet, whose marker the
    // content clamp lifts with its indent, so the mark starts after the marker.
    { rule: 'a later line the outline reads as a bullet starts after its marker', precedent: 'EtherPK', before: '- a `b\n        - c` d\n- x|', shows: '- a <code>b</code>\n        - <code>c</code> d\n- x' },
])

// ── Editor Content Rules → Fenced Code Blocks → Presentation ─────────────────────────────────

// The markdown parser reads the text as CommonMark, the outline and the fence scan read it as EtherPK
// does (ADR 0067), and on foreign text they can disagree: a child bullet indented four columns or more
// past its parent's content column is, to CommonMark, a lazy continuation of the parent's paragraph,
// and its fences the delimiters of a code span. The editor shows the block, so the parser's inline
// reading draws nothing inside it.
presentationTable('a code block the editor shows takes no inline formatting from the parser', [
    { rule: 'a bullet indented past its parent’s content column keeps its code block: fences shown, nothing inline code', precedent: 'EtherPK', before: '- a\n  - b\n        - ```\n          code\n          ```\n- x|', shows: '- a\n  - b\n        - ```\n          code\n          ```\n- x' },
    // The parser pairs the opener with the run inside the line and reads what follows as prose.
    { rule: 'a mark the parser finds after a backtick run inside such a block is code too', precedent: 'EtherPK', before: '- a\n        - ```\n          x ``` ~~y~~\n          ```\n- x|', shows: '- a\n        - ```\n          x ``` ~~y~~\n          ```\n- x' },
    { rule: 'the same block on the grid, which the parser reads as a fence as well', precedent: 'CommonMark', before: '- a\n  - b\n    - ```\n      code\n      ```\n- x|', shows: '- a\n  - b\n    - ```\n      code\n      ```\n- x' },
    // The panel's reading (outliner-context.ts, visibleFencedBlocks): a bare fence under the caret in an
    // unbalanced document is a half-typed opener, so the lines after it pair among themselves.
    { rule: 'a half-typed fence under the caret is text, and the block the panel draws below it takes no marks', precedent: 'EtherPK', before: '```|\na ~~b~~ c\n```\nd ~~e~~ f\n```', shows: '```\na ~~b~~ c\n```\nd ~~e~~ f\n```' },
])

// ── Editor Content Rules → Outliner Block Groups → Guide threads ─────────────────────────────

/**
 * The guide threads for a document, as `parent→last`, 0-based lines, with ` panel` where the thread
 * runs on to the bottom of a quote's panel rather than stopping at the text of its last line.
 */
function guides(fixture: string): string[] {
    const { state } = editorFixture(fixture, { extensions: [markdownWithCodeHighlight()] })
    return guideThreadsFor(state).map((thread) => `${thread.parent}→${thread.last}${thread.toPanel() ? ' panel' : ''}`)
}

describe('a guide thread reaches the bottom of a quote that ends its tree', () => {
    const rows: { rule: string; precedent: Rule['precedent']; before: string; threads: string[] }[] = [
        { rule: 'a tree ending in a quote bullet runs its threads to the panel’s bottom', precedent: 'Logseq', before: '- Test\n  - Test\n    - > Test|', threads: ['0→2 panel', '1→2 panel'] },
        { rule: 'a multiline quote too', precedent: 'Logseq', before: '- Test\n  - Test\n    - > one\n      > two|', threads: ['0→3 panel', '1→3 panel'] },
        { rule: 'a quote in the last child’s soft lines too', precedent: 'Logseq', before: '- a\n  - b\n    > quoted|', threads: ['0→2 panel'] },
        { rule: 'a quote in the middle of a tree changes nothing', precedent: 'Logseq', before: '- Test\n  - Test\n    - Test\n    - > Test\n    - Test\n  - Test|', threads: ['0→5', '1→4'] },
        { rule: 'a top-level quote bullet, last in its group, gets its own thread down the panel', precedent: 'EtherPK', before: '- Test\n  - Test\n- > Test\n  > Test multiline|', threads: ['0→1', '2→3 panel'] },
        { rule: 'a one-line top-level quote bullet too', precedent: 'EtherPK', before: '- Test\n  - Test\n- > Test|', threads: ['0→1', '2→2 panel'] },
        { rule: 'a top-level bullet whose soft lines end in a quote too', precedent: 'EtherPK', before: '- note\n  > quoted|', threads: ['0→1 panel'] },
        { rule: 'the last in its group, a blank line below it', precedent: 'EtherPK', before: '- a\n- > q\n\n- b|', threads: ['1→1 panel'] },
        { rule: 'a top-level quote bullet with a sibling below gets none: the thread would run to the sibling’s dot', precedent: 'EtherPK', before: '- > Test\n- next|', threads: [] },
        { rule: 'a top-level bullet ending in plain text gets none', precedent: 'Logseq', before: '- a\n  more|', threads: [] },
        { rule: 'a tree ending in a quote with a sibling tree below it still reaches the panel', precedent: 'Logseq', before: '- a\n  - > q\n- b|', threads: ['0→1 panel'] },
        { rule: 'an indented soft blank keeps the sibling below in the same group', precedent: 'EtherPK', before: '- > q\n  \n- b|', threads: [] },
        { rule: 'a quote that is not the block’s last content gets none', precedent: 'EtherPK', before: '- > q\n  \n  plain|', threads: [] },
        { rule: 'a heading below ends the group, so the quote bullet is its last', precedent: 'EtherPK', before: '- > q\n# H\n- b|', threads: ['0→0 panel'] },
        { rule: 'a quote bullet under a heading has no parent thread either, so it gets its own', precedent: 'EtherPK', before: '# Title\n- > q|', threads: ['1→1 panel'] },
        { rule: 'an indented bullet with no parent bullet (under prose) too', precedent: 'EtherPK', before: 'Para\n\n  - > q|', threads: ['2→2 panel'] },
    ]
    for (const row of rows) {
        it(`${row.rule} (${row.precedent})`, () => {
            expect(guides(row.before)).toEqual(row.threads)
        })
    }
})

describe('a guide thread runs beside a soft line at the end of its branch', () => {
    const rows: { rule: string; precedent: Rule['precedent']; before: string; threads: string[] }[] = [
        { rule: 'Shift+Enter at the end of the last child: the parent’s thread reaches the new soft line', precedent: 'Logseq', before: '- p\n  - c1\n    |', threads: ['0→2'] },
        { rule: 'with another tree below it too', precedent: 'Logseq', before: '- p\n  - c1\n    |\n- q', threads: ['0→2'] },
        { rule: 'a Ctrl+Enter split, a bare empty line, still cuts it', precedent: 'EtherPK', before: '- p\n  - c1\n|\n- q', threads: ['0→1'] },
        { rule: 'a whitespace line short of the content column is prose and gets no thread beside it', precedent: 'EtherPK', before: '- p\n  - c1\n   |\n- q', threads: ['0→1'] },
        { rule: 'after a quote, the threads run on past its panel to the soft line', precedent: 'Logseq', before: '- Test\n  - Test\n    - > Test\n      |', threads: ['0→3', '1→3'] },
        // That thread is drawn for the panel alone: a childless bullet draws no thread beside its soft lines.
        { rule: 'a top-level quote bullet’s own thread stays beside its panel', precedent: 'EtherPK', before: '- note\n  > quoted\n  |', threads: ['0→1 panel'] },
    ]
    for (const row of rows) {
        it(`${row.rule} (${row.precedent})`, () => {
            expect(guides(row.before)).toEqual(row.threads)
        })
    }
})

// ── Editor Content Rules → Outliner Block Groups → Keyboard rules ─────────────────────────────

table('Enter creates, never escapes (ADR 0019)', [
    { rule: 'a sibling at the same indent', precedent: 'Logseq', before: '- a|', key: 'Enter', after: '- a\n- |' },
    { rule: 'a sibling even on an empty bullet', precedent: 'EtherPK', before: '- |', key: 'Enter', after: '- \n- |' },
    { rule: 'a sibling keeps the nesting indent', precedent: 'Logseq', before: '- a\n  - b|', key: 'Enter', after: '- a\n  - b\n  - |' },
    { rule: 'at the end of a bullet with children, a new first child', precedent: 'Logseq', before: '- a|\n  - b', key: 'Enter', after: '- a\n  - |\n  - b' },
    { rule: 'mid-line splits the text onto the new sibling', precedent: 'Logseq', before: '- a|b', key: 'Enter', after: '- a\n- |b' },
    { rule: 'a task begets an unchecked task', precedent: 'Logseq', before: '- [ ] a|', key: 'Enter', after: '- [ ] a\n- [ ] |' },
    { rule: 'a done task begets an unchecked task', precedent: 'Logseq', before: '- [x] a|', key: 'Enter', after: '- [x] a\n- [ ] |' },
])

table('Enter on a Continuation Line splits the block there', [
    { rule: 'the caret’s line and everything after it become a new sibling block', precedent: 'Logseq', before: '- a\n  so|ft', key: 'Enter', after: '- a\n  so\n- |ft' },
    { rule: 'at the start of the line the whole line becomes the new block', precedent: 'Logseq', before: '- a\n  |soft', key: 'Enter', after: '- a\n- |soft' },
    { rule: 'a blank continuation becomes a new empty block', precedent: 'EtherPK', before: '- a\n  |', key: 'Enter', after: '- a\n- |' },
    { rule: 'at the end of the last continuation a new empty sibling opens', precedent: 'Logseq', before: '- a\n  soft|', key: 'Enter', after: '- a\n  soft\n- |' },
    { rule: 'with children the split-off block is the first child (ADR 0019)', precedent: 'Logseq', before: '- a\n  so|ft\n  - c', key: 'Enter', after: '- a\n  so\n  - |ft\n  - c' },
    { rule: 'at the end of the last continuation with children, a new first child', precedent: 'Logseq', before: '- a\n  soft|\n  - c', key: 'Enter', after: '- a\n  soft\n  - |\n  - c' },
    { rule: 'trailing continuation lines travel with the new block', precedent: 'EtherPK', before: '- a\n  so|ft\n  more', key: 'Enter', after: '- a\n  so\n- |ft\n  more' },
    { rule: 'travelling lines re-clamp when the new block sits deeper, fences as a unit', precedent: 'EtherPK', before: '- a\n  so|ft\n  ```\n  x\n  ```\n  - c', key: 'Enter', after: '- a\n  so\n  - |ft\n    ```\n    x\n    ```\n  - c' },
    { rule: 'the new block inherits the kind, unchecked', precedent: 'Logseq', before: '- [x] a\n  so|ft', key: 'Enter', after: '- [x] a\n  so\n- [ ] |ft' },
    { rule: 'a nested block splits at its own depth', precedent: 'Logseq', before: '- a\n  - b\n    so|ft', key: 'Enter', after: '- a\n  - b\n    so\n  - |ft' },
    { rule: 'the first child follows the existing children’s indent, on foreign text too', precedent: 'Logseq', before: '- a\n  so|ft\n    - c', key: 'Enter', after: '- a\n  so\n    - |ft\n    - c' },
    { rule: 'a caret parked in extra indent splits the whole line off', precedent: 'EtherPK', before: '- a\n    |soft', key: 'Enter', after: '- a\n- |soft' },
    // A continuation after the block's children (a paragraph after a sublist, as CommonMark and other
    // tools write it) belongs to the block whose content column it sits at, not to the child above it.
    { rule: 'after the children, the new block is the next sibling of the owner', precedent: 'CommonMark', before: '- a\n  - b\n  trailing|', key: 'Enter', after: '- a\n  - b\n  trailing\n- |' },
    { rule: 'after the children, the split carries the rest of the branch', precedent: 'EtherPK', before: '- a\n  - b\n  trai|ling\n  more', key: 'Enter', after: '- a\n  - b\n  trai\n- |ling\n  more' },
])

table('Shift+Enter is the soft line', [
    { rule: 'on a continuation line it is another continuation at the floor, not the line’s own indent', precedent: 'Logseq', before: '- a\n    so|ft', key: 'Shift-Enter', after: '- a\n    so\n  |ft' },

    { rule: 'a continuation at the content column', precedent: 'Logseq', before: '- a|', key: 'Shift-Enter', after: '- a\n  |' },
    { rule: 'the content column follows the nesting', precedent: 'Logseq', before: '  - a|', key: 'Shift-Enter', after: '  - a\n    |' },
    { rule: 'a task continuation clamps to the fixed marker width, not the checkbox (ADR 0020)', precedent: 'EtherPK', before: '- [ ] a|', key: 'Shift-Enter', after: '- [ ] a\n  |' },
    { rule: 'a continuation after the children gets another at the owner’s floor', precedent: 'EtherPK', before: '- a\n  - b\n  trailing|', key: 'Shift-Enter', after: '- a\n  - b\n  trailing\n  |' },
])

// A line under a bullet is its continuation only once its indent reaches the bullet's content
// column, and then whether the bullet is directly above it or the outline reaches it across a soft
// line or a `*` item (continuationColumn, outliner.ts). The caret clamp, the highlight and the
// drawing read it so, and the joining, outdenting and moving keys read it the same way.
table('a line under a bullet is its continuation once it reaches the content column', [
    { rule: 'Backspace at a bullet below a line short of the column is refused, as below prose', precedent: 'EtherPK', before: '- a\n x\n- |b', key: 'Backspace', after: '- a\n x\n- |b' },
    { rule: 'Delete never pulls a line short of the column up into the bullet', precedent: 'EtherPK', before: '- a|\n x', key: 'Delete', after: '- a|\n x' },
    { rule: 'Shift+Tab on a line short of the column outdents it like prose', precedent: 'VS Code', before: '- a\n |x', key: 'Shift-Tab', after: '- a\n|x' },
    { rule: 'Alt+Up moves a prose line past a line short of the column, which is prose too', precedent: 'VS Code', before: '- a\n x\ny|', key: 'Alt-ArrowUp', after: '- a\ny|\n x' },
    { rule: 'a line nested under a soft line is the bullet’s continuation: Backspace merges onto it', precedent: 'Logseq', before: '- a\n  cont\n    deeper\n- |b', key: 'Backspace', after: '- a\n  cont\n    deeper|b' },
    { rule: '…Delete pulls it up like any continuation', precedent: 'Logseq', before: '- a\n  cont|\n    deeper', key: 'Delete', after: '- a\n  cont|deeper' },
    { rule: '…Enter splits the block there', precedent: 'Logseq', before: '- a\n  cont\n    dee|per', key: 'Enter', after: '- a\n  cont\n    dee\n- |per' },
    { rule: '…as it does under a `*` item', precedent: 'Logseq', before: '- a\n  * one\n    * t|wo', key: 'Enter', after: '- a\n  * one\n    * t\n- |wo' },
    { rule: '…Mod+Enter leaves from it as from any continuation', precedent: 'EtherPK', before: '- a\n  cont\n    dee|per', key: 'Mod-Enter', after: '- a\n  cont\n    dee\n|per' },
    { rule: '…and Alt+Up never moves a prose line in beside it', precedent: 'EtherPK', before: '- a\n  cont\n    deeper\ny|', key: 'Alt-ArrowUp', after: '- a\n  cont\n    deeper\ny|' },
])

// A block whose fence opens on the bullet line (form 1, `- ```py`) owns the lines after its closer
// exactly as a block whose fence opens below the bullet (form 2) does, and every row here is its
// form-2 twin's result. The keys measure merges, splits and moves against the form-1 bullet, which
// owns those lines, never against its parent.
table('a form-1 block owns the lines after its closer, as a form-2 block does', [
    { rule: 'Backspace at a bullet below its continuation is refused when a child would be stranded', precedent: 'EtherPK', before: '- ```py\n  code\n  ```\n    after\n  - |b\n    - c', key: 'Backspace', after: '- ```py\n  code\n  ```\n    after\n  - |b\n    - c' },
    { rule: '…at the content column too', precedent: 'EtherPK', before: '- ```py\n  code\n  ```\n  after\n  - |b\n    - c', key: 'Backspace', after: '- ```py\n  code\n  ```\n  after\n  - |b\n    - c' },
    { rule: '…and at an empty bullet with a child', precedent: 'EtherPK', before: '- ```py\n  code\n  ```\n    after\n  - |\n    - c', key: 'Backspace', after: '- ```py\n  code\n  ```\n    after\n  - |\n    - c' },
    { rule: 'Delete at the end of its soft line never splices the next bullet in', precedent: 'EtherPK', before: '- ```py\n  code\n  ```\n  after|\n  - b\n    - c', key: 'Delete', after: '- ```py\n  code\n  ```\n  after|\n  - b\n    - c' },
    { rule: 'Enter on its continuation splits the block at the form-1 bullet’s level', precedent: 'Logseq', before: '- p\n  - ```py\n    code\n    ```\n      af|ter\n  - q\n    - r', key: 'Enter', after: '- p\n  - ```py\n    code\n    ```\n      af\n  - |ter\n  - q\n    - r' },
    { rule: 'a block merged onto its continuation keeps its soft lines at the content column', precedent: 'Logseq', before: '- ```py\n  code\n  ```\n    after\n- |b\n  soft', key: 'Backspace', after: '- ```py\n  code\n  ```\n    after|b\n  soft' },
    { rule: 'Alt+Up from its soft line moves the form-1 bullet’s branch, not its parent’s', precedent: 'Logseq', before: '- o\n- p\n  - ```py\n    code\n    ```\n    after|', key: 'Alt-ArrowUp', after: '- o\n- ```py\n  code\n  ```\n  after|\n- p' },
    // The form-1 bullet is a sibling like any other: a move over it carries its whole code block.
    { rule: 'Alt+Up past a form-1 sibling jumps its whole block and never deletes it', precedent: 'Logseq', before: '- a\n- ```py\n  code\n  ```\n- |c', key: 'Alt-ArrowUp', after: '- a\n- |c\n- ```py\n  code\n  ```' },
    { rule: '…with its soft lines', precedent: 'Logseq', before: '- a\n- ```py\n  ```\n  soft\n- |c', key: 'Alt-ArrowUp', after: '- a\n- |c\n- ```py\n  ```\n  soft' },
    { rule: 'Tab nests a bullet under a form-1 sibling', precedent: 'Logseq', before: '- a\n  - ```py\n    code\n    ```\n  - |c', key: 'Tab', after: '- a\n  - ```py\n    code\n    ```\n    - |c' },
    { rule: 'deleting the blocks after it lands the caret at the end of its line, as for any previous sibling', precedent: 'Logseq', before: '- a\n- ```py\n  x\n  ```\n«- b\n- c»', key: 'Backspace', after: '- a\n- ```py|\n  x\n  ```' },
    { rule: 'Tab on the opener nests the form-1 branch under its previous sibling, fence and all', precedent: 'Logseq', before: '- a\n- |```py\n  x\n  ```', key: 'Tab', after: '- a\n  - |```py\n    x\n    ```' },
    { rule: 'Mod+Shift+Enter over a range from the opener into its code is refused too', precedent: 'EtherPK', before: '- «```py\n  co»de\n  ```', key: 'Mod-Shift-Enter', after: '- «```py\n  co»de\n  ```' },
    // A task marker moves the fence off the content column, where its closer no longer pairs with it.
    { rule: 'Mod+Shift+Enter on the form-1 opener is refused: a task’s fence cannot open on its line', precedent: 'EtherPK', before: '- |```py\n  code\n  ```', key: 'Mod-Shift-Enter', after: '- |```py\n  code\n  ```' },
    { rule: 'Mod+Shift+Enter makes its soft line a task one level under the form-1 bullet', precedent: 'Logseq', before: '- a\n  - ```py\n    code\n    ```\n    aft|er', key: 'Mod-Shift-Enter', after: '- a\n  - ```py\n    code\n    ```\n    - [ ] aft|er' },
])

// A fence written inside the frontmatter is YAML text, whatever it looks like: never a form-1 bullet
// the body's first bullets could take for a parent or a sibling.
table('a bullet-shaped fence in the frontmatter is YAML, never a bullet', [
    { rule: 'Alt+Up on the body’s first bullet is consumed: the frontmatter holds no sibling', precedent: 'EtherPK', before: '---\n- ```\n  ```\n---\n- b|', key: 'Alt-ArrowUp', after: '---\n- ```\n  ```\n---\n- b|' },
    { rule: '…and Tab is refused: nothing to nest under', precedent: 'EtherPK', before: '---\n- ```\n  ```\n---\n- b|', key: 'Tab', after: '---\n- ```\n  ```\n---\n- b|' },
])

// A fence-like line in the frontmatter is YAML text, so its indent is the YAML's to edit. A block
// scalar's `|` is the fixture's caret marker, so these rows take another.
table('a fence-like line in the frontmatter is YAML text', [
    { rule: 'Delete in its indent removes a space', precedent: 'EtherPK', before: '---\ndesc: |\n¦  ```\n  x\n  ```\n---\nbody', key: 'Delete', after: '---\ndesc: |\n¦ ```\n  x\n  ```\n---\nbody' },
    { rule: 'Delete at the end of the closing delimiter never pulls the body’s first fence up', precedent: 'EtherPK', before: '---\na: 1\n---¦\n```\nx\n```', key: 'Delete', after: '---\na: 1\n---¦\n```\nx\n```' },
], { caret: '¦' })

// A block scalar's `|` is the fixture's caret marker, so this row takes another.
it('Alt-ArrowUp: …nor when the fence sits in a block scalar (EtherPK)', () => {
    const before = '---\nsnippet: |\n  - ```js\n    x\n    ```\n---\n    - b¦'
    const editor = editorFixture(before, { caret: '¦' })
    editor.key('Alt-ArrowUp')
    expect(editor.fixture()).toBe(before)
})

// A `- item` in the frontmatter is a YAML list entry: Shift+Tab stripping its marker broke the list.
// The frontmatter's own keys take Shift+Tab there (frontmatter-keys.rules.test.ts): indentation only.
table('Shift+Tab in the frontmatter never strips a list marker', [
    { rule: 'on a flush YAML list entry it has nothing to take', precedent: 'EtherPK', before: '---\ntags:\n- fo|o\n---\nbody', key: 'Shift-Tab', after: '---\ntags:\n- fo|o\n---\nbody' },
    { rule: 'on an indented one it takes two spaces of indent, the marker kept', precedent: 'EtherPK', before: '---\naliases:\n  - fo|o\n---\nbody', key: 'Shift-Tab', after: '---\naliases:\n- fo|o\n---\nbody' },
])

// A blank line reads as the line it becomes with text typed in it. Under a prose line short of the
// bullet's column, text there is prose, nested under that line; so the blank line is prose too, and
// never the bullet's continuation that the join could merge the next bullet onto.
table('a blank line under a prose line short of the content column is prose', [
    { rule: 'Backspace at the bullet below it is refused, as below any prose', precedent: 'EtherPK', before: '- a\n p\n   \n- |b', key: 'Backspace', after: '- a\n p\n   \n- |b' },
])

table('Mod+Enter is the one deliberate exit', [
    { rule: 'a prose line at column 0 after the whole tree', precedent: 'EtherPK', before: '- a|\n  - b', key: 'Mod-Enter', after: '- a\n  - b\n|' },
    { rule: 'from a nested block the exit is after its top-level ancestor’s tree, never splitting it', precedent: 'EtherPK', before: '- a\n  - b|\n  - c', key: 'Mod-Enter', after: '- a\n  - b\n  - c\n|' },
    { rule: 'the following top-level tree stays where it is', precedent: 'EtherPK', before: '- a\n  - b\n    - c|\n  - d\n- e', key: 'Mod-Enter', after: '- a\n  - b\n    - c\n  - d\n|\n- e' },
    { rule: 'the tail rides out past the whole tree', precedent: 'EtherPK', before: '- a\n  - b|x\n  - c', key: 'Mod-Enter', after: '- a\n  - b\n  - c\n|x' },
    { rule: 'a nested continuation leaves after the whole tree too', precedent: 'EtherPK', before: '- a\n  - b\n    so|ft\n  - c', key: 'Mod-Enter', after: '- a\n  - b\n    so\n  - c\n|ft' },
    { rule: 'text right of the caret rides out to the prose line', precedent: 'EtherPK', before: '- a|b\n  - c', key: 'Mod-Enter', after: '- a\n  - c\n|b' },
    { rule: 'in prose it is the default blank line', precedent: 'VS Code', before: 'x|', key: 'Mod-Enter', after: 'x\n|' },
    { rule: 'on a continuation line it exits too, caret at column 0', precedent: 'EtherPK', before: '- a\n  soft|', key: 'Mod-Enter', after: '- a\n  soft\n|' },
    { rule: 'everything from the caret on leaves as prose after the branch', precedent: 'EtherPK', before: '- a\n  so|ft\n  more\n  - c', key: 'Mod-Enter', after: '- a\n  so\n  - c\n|ft\nmore' },
    { rule: 'at the start of a continuation the whole line leaves', precedent: 'EtherPK', before: '- a\n  |soft', key: 'Mod-Enter', after: '- a\n|soft' },
    { rule: 'a blank continuation leaves as an empty prose line', precedent: 'EtherPK', before: '- a\n  |', key: 'Mod-Enter', after: '- a\n|' },
    { rule: 'a blank continuation with children leaves after them', precedent: 'EtherPK', before: '- a\n  |\n  - c', key: 'Mod-Enter', after: '- a\n  - c\n|' },
    { rule: 'a trailing fence leaves dedented as a unit', precedent: 'EtherPK', before: '- a\n  so|ft\n  ```\n  x\n  ```', key: 'Mod-Enter', after: '- a\n  so\n|ft\n```\nx\n```' },
    { rule: 'from a continuation after the children the text leaves after the tree', precedent: 'EtherPK', before: '- a\n  - b\n  trai|ling', key: 'Mod-Enter', after: '- a\n  - b\n  trai\n|ling' },
    // The line carried out starts at its first character. Under the tree an indented line is the
    // tree's own (indent decides, ADR 0021): spaces carried out with it made a whitespace-only soft
    // line, which tidy on leave took back the moment the caret left, or turned the text into a
    // continuation of the block above.
    { rule: 'spaces right of the caret do not ride out: the new line is empty', precedent: 'EtherPK', before: '- a|  \n- c', key: 'Mod-Enter', after: '- a\n|\n- c' },
    { rule: '…from a continuation too', precedent: 'EtherPK', before: '- a\n  - b\n    so|  \n- c', key: 'Mod-Enter', after: '- a\n  - b\n    so\n|\n- c' },
    { rule: 'the text right of the caret leaves without the spaces before it', precedent: 'EtherPK', before: '- a|  b\n- c', key: 'Mod-Enter', after: '- a\n|b\n- c' },
    { rule: '…past the children when the bullet has them', precedent: 'EtherPK', before: '- a|  b\n  - c\n- d', key: 'Mod-Enter', after: '- a\n  - c\n|b\n- d' },
    { rule: '…from a continuation too', precedent: 'EtherPK', before: '- a\n  so|  ft\n- c', key: 'Mod-Enter', after: '- a\n  so\n|ft\n- c' },
    { rule: 'at the floor of an over-indented continuation the whole line leaves, at the margin', precedent: 'EtherPK', before: '- a\n  |  soft\n- c', key: 'Mod-Enter', after: '- a\n|soft\n- c' },
    { rule: 'a blank over-indented continuation leaves as an empty prose line', precedent: 'EtherPK', before: '- a\n  |  \n- c', key: 'Mod-Enter', after: '- a\n|\n- c' },
    // The text carried out is at the margin, where a fence pairs with another fence there and a `---`
    // can close a frontmatter block. The exit is refused where it would change which lines are code
    // or frontmatter, as leaving the list is.
    { rule: 'refused where the fence it carries out would pair with another fence at the margin', precedent: 'EtherPK', before: '- |```py\ntext\n```\ncode\n```', key: 'Mod-Enter', after: '- |```py\ntext\n```\ncode\n```' },
    { rule: 'refused where the rule it carries out would close a frontmatter block', precedent: 'EtherPK', before: '---\ntitle: T\n- |---\nbody', key: 'Mod-Enter', after: '---\ntitle: T\n- |---\nbody' },
    { rule: '…from a continuation too', precedent: 'EtherPK', before: '---\ntitle: T\n- a\n  |---\nbody', key: 'Mod-Enter', after: '---\ntitle: T\n- a\n  |---\nbody' },
    // Spaces before the carried fence or rule are dropped, so it reaches the margin and is judged there.
    { rule: 'refused for a fence after spaces right of the caret', precedent: 'EtherPK', before: '- a|  ```\n\n```\ncode\n```', key: 'Mod-Enter', after: '- a|  ```\n\n```\ncode\n```' },
    { rule: 'refused for a rule after spaces right of the caret', precedent: 'EtherPK', before: '---\ntitle: T\n- a|  ---\nbody', key: 'Mod-Enter', after: '---\ntitle: T\n- a|  ---\nbody' },
])

table('Tab and Shift+Tab move whole branches', [
    { rule: 'nest under the previous sibling', precedent: 'Logseq', before: '- a\n- b|', key: 'Tab', after: '- a\n  - b|' },
    { rule: 'descendants and continuations travel with the block', precedent: 'Logseq', before: '- a\n- b|\n  - c\n  text', key: 'Tab', after: '- a\n  - b|\n    - c\n    text' },
    { rule: 'refused when there is no previous sibling (never an orphan)', precedent: 'Logseq', before: '- a|', key: 'Tab', after: '- a|' },
    { rule: 'refused for the first child too', precedent: 'Logseq', before: '- a\n  - b|', key: 'Tab', after: '- a\n  - b|' },
    { rule: 'Tab lands one Indent Unit under the previous sibling, on any grid: a four-space sibling’s child sits at six', precedent: 'EtherPK', before: '- a\n    - b\n    - c|', key: 'Tab', after: '- a\n    - b\n      - c|' },
    { rule: 'a foreign branch moves as a unit: its descendants keep their own offsets', precedent: 'EtherPK', before: '- a\n    - b\n    - c|\n          - d', key: 'Tab', after: '- a\n    - b\n      - c|\n            - d' },
    { rule: 'over-nested siblings share a parent: Tab nests under the deeper sibling, one unit below it', precedent: 'EtherPK', before: '- a\n      - b\n    - c|', key: 'Tab', after: '- a\n      - b\n        - c|' },
    { rule: 'on a tab-indented file the editor counts characters: Tab still nests, by two of them', precedent: 'EtherPK', before: '- a\n\t- b\n\t- c|', key: 'Tab', after: '- a\n\t- b\n  \t- c|' },
    { rule: 'a heading-looking comment inside the previous sibling’s fence is code, not a boundary', precedent: 'EtherPK', before: '- a\n  - ```\n    # comment\n    ```\n- b|\n  - c', key: 'Tab', after: '- a\n  - ```\n    # comment\n    ```\n  - b|\n    - c' },
    { rule: 'a bullet-looking line inside the previous sibling’s fence is code, not a sibling', precedent: 'EtherPK', before: '- a\n  ```\n  - x\n  ```\n- b|', key: 'Tab', after: '- a\n  ```\n  - x\n  ```\n  - b|' },
    { rule: 'outdent lifts the branch one level', precedent: 'Logseq', before: '- a\n  - b|\n    - c', key: 'Shift-Tab', after: '- a\n- b|\n  - c' },
    { rule: 'outdent past a sibling whose fence holds a heading-looking comment', precedent: 'EtherPK', before: '- a\n  - x\n    ```\n    # c\n    ```\n  - b|', key: 'Shift-Tab', after: '- a\n  - x\n    ```\n    # c\n    ```\n- b|' },
    { rule: 'Shift+Tab lands on the parent’s indent in one press, on foreign four-space text too', precedent: 'EtherPK', before: '- a\n    - b|\n        - c', key: 'Shift-Tab', after: '- a\n- b|\n    - c' },
    { rule: 'an indented group start (no parent) outdents to column 0', precedent: 'EtherPK', before: '- a\n\n    - b|', key: 'Shift-Tab', after: '- a\n\n- b|' },
    { rule: 'on a tab-indented file Shift+Tab lands on the parent’s character count', precedent: 'EtherPK', before: '- a\n\t- b\n  \t- c|', key: 'Shift-Tab', after: '- a\n\t- b\n\t- c|' },
    { rule: 'outdent past the root makes the line prose, caret on the same character', precedent: 'EtherPK', before: '- te|xt', key: 'Shift-Tab', after: 'te|xt' },
    { rule: 'a task past the root loses its checkbox too', precedent: 'EtherPK', before: '- [ ] te|xt', key: 'Shift-Tab', after: 'te|xt' },
    { rule: 'the root’s children come up one level, never left under prose', precedent: 'EtherPK', before: '- a|\n  - b\n    - c', key: 'Shift-Tab', after: 'a|\n- b\n  - c' },
    { rule: 'the root’s own continuation and fence go to column 0 with it', precedent: 'EtherPK', before: '- a|\n  soft\n  ```\n  x\n  ```\n  - b', key: 'Shift-Tab', after: 'a|\nsoft\n```\nx\n```\n- b' },
    { rule: 'the root’s children come up by their own indent, so a four-space child lands at column 0 too', precedent: 'EtherPK', before: '- a|\n    - b\n        - c', key: 'Shift-Tab', after: 'a|\n- b\n    - c' },
    { rule: 'a caret in the marker lands at the line start', precedent: 'EtherPK', before: '- |a', key: 'Shift-Tab', after: '|a' },
    { rule: 'past the root, a bullet whose text is a fence is refused where at the margin it would pair with another fence', precedent: 'EtherPK', before: '- ```py|\ntext\n```\ncode\n```', key: 'Shift-Tab', after: '- ```py|\ntext\n```\ncode\n```' },
    { rule: 'past the root, a `- ---` is refused where at the margin it would close a frontmatter block', precedent: 'EtherPK', before: '---\ntitle: x\n- ---|\nbody', key: 'Shift-Tab', after: '---\ntitle: x\n- ---|\nbody' },
    { rule: 'past the root, a form-1 bullet becomes a prose code block, its fences moving to column 0 together', precedent: 'EtherPK', before: '- |```py\n  code\n  ```', key: 'Shift-Tab', after: '|```py\ncode\n```' },
    { rule: 'past the root on a ragged grid, each child comes up by its own indent and keeps its own lines', precedent: 'EtherPK', before: '- a|\n      - b\n    - c\n      soft', key: 'Shift-Tab', after: 'a|\n- b\n- c\n  soft' },
    { rule: '…and a code block under a later, shallower child stays that child\'s', precedent: 'EtherPK', before: '- a|\n      - b\n    - c\n      ```\n      x\n      ```', key: 'Shift-Tab', after: 'a|\n- b\n- c\n  ```\n  x\n  ```' },
    { rule: 'a continuation cannot outdent past its content column', precedent: 'EtherPK', before: '- a\n    x|', key: 'Shift-Tab', after: '- a\n  x|' },
    { rule: 'a nested bullet whose text is a fence is refused where outdented it would pair with another fence', precedent: 'EtherPK', before: '- a\n  - ```|\n  ```\n  x\n  ```', key: 'Shift-Tab', after: '- a\n  - ```|\n  ```\n  x\n  ```' },
    { rule: '…where it would take another block’s fence for its closer, even with no code to tell the blocks apart', precedent: 'EtherPK', before: '- a\n  - ```|\n  ```\n  ```', key: 'Shift-Tab', after: '- a\n  - ```|\n  ```\n  ```' },
    { rule: 'a continuation at its floor stays put', precedent: 'EtherPK', before: '- a\n  x|', key: 'Shift-Tab', after: '- a\n  x|' },
])

table('Tab and Shift+Tab move every branch of a block selection together, and a range inside one block moves that block', [
    { rule: 'sibling branches nest together, each with its descendants', precedent: 'Logseq', before: '- a\n«- b\n  - c\n- d»', key: 'Tab', after: '- a\n«  - b\n    - c\n  - d»' },
    { rule: 'descendants below a selection set without the snap travel with their root, and the selection then takes them', precedent: 'Logseq', before: '- a\n«- b\n- c»\n  - d', key: 'Tab', after: '- a\n«  - b\n  - c\n    - d»' },
    { rule: 'branches at different depths each nest under their own previous sibling', precedent: 'Logseq', before: '- a\n  - b\n«  - c\n- d»', key: 'Tab', after: '- a\n  - b\n«    - c\n  - d»' },
    { rule: 'the head’s line does not decide: a first child at the head is no refusal', precedent: 'EtherPK', before: '- a\n«- b\n  - c\n- d\n  - e»', key: 'Tab', after: '- a\n«  - b\n    - c\n  - d\n    - e»' },
    { rule: 'refused as a whole when the first selected branch has no previous sibling', precedent: 'Logseq', before: '«- a\n- b»', key: 'Tab', after: '«- a\n- b»' },
    { rule: 'refused as a whole when any selected branch is a first child', precedent: 'EtherPK', before: '- a\n«  - b\n- c»', key: 'Tab', after: '- a\n«  - b\n- c»' },
    { rule: 'each selected branch lands one unit under its own previous sibling, on any grid', precedent: 'EtherPK', before: '- a\n    - x\n«    - b\n    - c»', key: 'Tab', after: '- a\n    - x\n«      - b\n      - c»' },
    { rule: 'outdent lifts every selected branch one level', precedent: 'Logseq', before: '- a\n«  - b\n    - c\n  - d»', key: 'Shift-Tab', after: '- a\n«- b\n  - c\n- d»' },
    { rule: 'outdent is refused as a whole when a selected branch is at the root', precedent: 'EtherPK', before: '«- a\n  - b\n- c»', key: 'Shift-Tab', after: '«- a\n  - b\n- c»' },
    { rule: 'a block selection whose head reached a fence is still the outliner’s, and takes the block whole', precedent: 'EtherPK', before: '- a\n«- b\n- c\n  ```\n  x»\n  ```', key: 'Tab', after: '- a\n«  - b\n  - c\n    ```\n    x\n    ```»' },
    { rule: 'a range from a block into its own code nests the block, not the code', precedent: 'Logseq', before: '- a\n- «b\n  ```\n  x»\n  ```', key: 'Tab', after: '- a\n  - «b\n    ```\n    x»\n    ```' },
    { rule: 'a range inside one block, across its continuation, nests the block and stays on its text', precedent: 'Logseq', before: '- a\n- «b\n  soft»', key: 'Tab', after: '- a\n  - «b\n    soft»' },
    { rule: 'a range across a block’s continuation lines alone still moves the block, not a line of it', precedent: 'Logseq', before: '- a\n- b\n  «soft\n  more»', key: 'Tab', after: '- a\n  - b\n    «soft\n    more»' },
    { rule: 'outdent of a range inside one block lifts the block', precedent: 'Logseq', before: '- a\n  - «b\n    soft»', key: 'Shift-Tab', after: '- a\n- «b\n  soft»' },
    { rule: 'a range from a block into its own code is refused whole when the block cannot nest', precedent: 'EtherPK', before: '- «a\n  ```\n  x»\n  ```', key: 'Tab', after: '- «a\n  ```\n  x»\n  ```' },
    { rule: 'a selection across a blank line spans two groups: the second group’s first block has no sibling, so Tab is refused whole', precedent: 'EtherPK', before: '- a\n«- b\n\n- c»', key: 'Tab', after: '- a\n«- b\n\n- c»' },
    { rule: 'across a blank line, Shift+Tab lifts the blocks of both groups and leaves the blank alone', precedent: 'EtherPK', before: '- a\n  - b\n«  - c\n\n  - d»', key: 'Shift-Tab', after: '- a\n  - b\n«- c\n\n- d»' },
    { rule: 'a selection from a nested block to a shallower one lifts each; the block after becomes the last one’s child, and is selected with it', precedent: 'Logseq', before: '- a\n  - b\n«    - c\n  - d»\n  - e', key: 'Shift-Tab', after: '- a\n  - b\n«  - c\n- d\n  - e»' },
])

// A block selection is snapped to whole branches (block-select.ts), so a press that shrinks it one line
// would land inside a selected branch and be snapped straight back. Shrinking steps by branch or block.
table('Shift+Up and Shift+Down shrink a block selection a branch or a block at a time', [
    { rule: 'Shift+Up removes the last branch', precedent: 'EtherPK', before: '«- a\n- b\n  - c\n- d»', key: 'Shift-ArrowUp', after: '«- a\n- b\n  - c»\n- d' },
    { rule: 'Shift+Up removes a last branch with children whole', precedent: 'EtherPK', before: '«- a\n- b\n- c\n  - d»', key: 'Shift-ArrowUp', after: '«- a\n- b»\n- c\n  - d' },
    { rule: 'a last block with continuation lines is removed in one press', precedent: 'EtherPK', before: '«- a\n- b\n- c\n  soft»', key: 'Shift-ArrowUp', after: '«- a\n- b»\n- c\n  soft' },
    { rule: 'blank and prose lines between groups go with the branch after them', precedent: 'EtherPK', before: '«- a\n- b\n\n- c»', key: 'Shift-ArrowUp', after: '«- a\n- b»\n\n- c' },
    { rule: 'a start block with children stays a block selection', precedent: 'EtherPK', before: '«- a\n  - b\n- c»', key: 'Shift-ArrowUp', after: '«- a\n  - b»\n- c' },
    { rule: 'with only the start branch left, the start block’s own text is selected', precedent: 'EtherPK', before: '«- a\n  - b»\n- c', key: 'Shift-ArrowUp', after: '- «a»\n  - b\n- c' },
    { rule: 'a start block’s continuation is part of its text', precedent: 'EtherPK', before: '«- a\n  soft\n- b»', key: 'Shift-ArrowUp', after: '- «a\n  soft»\n- b' },
    { rule: 'a start task’s text starts after its checkbox', precedent: 'EtherPK', before: '«- [ ] a\n- b»', key: 'Shift-ArrowUp', after: '- [ ] «a»\n- b' },
    { rule: 'Shift+Down removes the top block only, its children kept', precedent: 'Logseq', before: '»- a\n  - b\n- c«', key: 'Shift-ArrowDown', after: '- a\n«  - b\n- c»' },
    { rule: 'a top block with continuation lines is removed in one press', precedent: 'EtherPK', before: '»- a\n  soft\n- b\n- c«', key: 'Shift-ArrowDown', after: '- a\n  soft\n«- b\n- c»' },
    { rule: 'blank and prose lines between groups go with the block before them', precedent: 'EtherPK', before: '»- a\n\n- b\n- c«', key: 'Shift-ArrowDown', after: '- a\n\n«- b\n- c»' },
    { rule: 'with only the bottom block left, its own text is selected', precedent: 'EtherPK', before: '- a\n»- b\n- c«', key: 'Shift-ArrowDown', after: '- a\n- b\n- «c»' },
    { rule: 'a `- ` line in a code sample is no block for Shift+Down to stop at', precedent: 'EtherPK', before: '»- a\n```\n- x\n```\n- b«', key: 'Shift-ArrowDown', after: '- a\n```\n- x\n```\n- «b»' },
    { rule: 'a `- ` line in a code sample is no branch for Shift+Up to remove', precedent: 'EtherPK', before: '«- a\n```\n- x\n```\n- b»', key: 'Shift-ArrowUp', after: '- «a»\n```\n- x\n```\n- b' },
    { rule: 'a `- ` line in a block’s own code is no block for Shift+Down to stop at', precedent: 'EtherPK', before: '»- a\n  ```\n  - x\n  ```\n- b\n- c«', key: 'Shift-ArrowDown', after: '- a\n  ```\n  - x\n  ```\n«- b\n- c»' },
])

describe('shrinking a block selection (EtherPK)', () => {
    it('keeps the head first when Shift+Down shrinks an upward selection', () => {
        for (const before of ['»- a\n  - b\n- c«', '- a\n»- b\n- c«']) {
            const editor = editorFixture(before)
            editor.key('Shift-ArrowDown')
            expect(editor.state.selection.main.head).toBeLessThan(editor.state.selection.main.anchor)
        }
    })

    it('steps past a line that only looks like a bullet', () => {
        const nbsp = String.fromCharCode(0xa0) // a no-break space before the dash: prose to the outline walk
        const editor = editorFixture(`»- a\n${nbsp}- x\n- b«`)
        editor.key('Shift-ArrowDown')
        expect(editor.fixture()).toBe(`- a\n${nbsp}- x\n- «b»`)
    })

    it('leaves a growing press, a caret and a text range to CodeMirror', () => {
        expect(editorFixture('«- a\n- b»\n- c').key('Shift-ArrowDown')).toBe(false)
        expect(editorFixture('- a\n»- b\n- c«').key('Shift-ArrowUp')).toBe(false)
        expect(editorFixture('- a|\n- b').key('Shift-ArrowUp')).toBe(false)
        expect(editorFixture('- «a\n  soft»').key('Shift-ArrowUp')).toBe(false)
        expect(editorFixture('«prose\n- b»').key('Shift-ArrowUp')).toBe(false)
    })

    it('leaves a press from a blank or prose line after the last branch to CodeMirror, which moves one line', () => {
        // Shift+Down from «- a\n- b» reaches the blank line, and the snap keeps it there: Shift+Up comes
        // back one line at a time, as it went, rather than past the branch above.
        expect(editorFixture('«- a\n- b\n»\n- c').key('Shift-ArrowUp')).toBe(false)
        expect(editorFixture('«- a\n  - b\nprose»').key('Shift-ArrowUp')).toBe(false)
    })
})

table('Alt+Up / Alt+Down is the Logseq move (ADR 0021)', [
    { rule: 'from a continuation after the children the whole branch jumps, paragraph included', precedent: 'EtherPK', before: '- a\n  - b\n  trailing|\n- c', key: 'Alt-ArrowDown', after: '- c\n- a\n  - b\n  trailing|' },
    { rule: 'swap with the previous sibling', precedent: 'Logseq', before: '- a\n- b|', key: 'Alt-ArrowUp', after: '- b|\n- a' },
    { rule: 'jump over a sibling’s entire subtree', precedent: 'Logseq', before: '- a\n  - a1\n- b|', key: 'Alt-ArrowUp', after: '- b|\n- a\n  - a1' },
    { rule: 'the moving branch carries its own subtree', precedent: 'Logseq', before: '- a\n- b|\n  - b1', key: 'Alt-ArrowUp', after: '- b|\n  - b1\n- a' },
    { rule: 'swap with the next sibling', precedent: 'Logseq', before: '- a|\n- b', key: 'Alt-ArrowDown', after: '- b\n- a|' },
    { rule: 'with no sibling above, promote to before the parent', precedent: 'Logseq', before: '- a\n  - b|', key: 'Alt-ArrowUp', after: '- b|\n- a' },
    { rule: 'with no sibling below, promote to after the parent’s subtree', precedent: 'Logseq', before: '- a\n  - b|\n- c', key: 'Alt-ArrowDown', after: '- a\n- b|\n- c' },
    { rule: 'at the group’s top edge the key is consumed', precedent: 'Logseq', before: '- a|\n- b', key: 'Alt-ArrowUp', after: '- a|\n- b' },
    { rule: 'at the group’s bottom edge the key is consumed', precedent: 'Logseq', before: '- a\n- b|', key: 'Alt-ArrowDown', after: '- a\n- b|' },
    { rule: 'a move never crosses a blank line into another group', precedent: 'EtherPK', before: '- a\n\n- b|', key: 'Alt-ArrowUp', after: '- a\n\n- b|' },
    { rule: 'the alias chord behaves the same', precedent: 'Logseq', before: '- a\n- b|', key: 'Alt-Shift-ArrowUp', after: '- b|\n- a' },
    { rule: 'a move jumps over a sibling whose fence holds a heading-looking comment', precedent: 'EtherPK', before: '- a\n  ```\n  # c\n  ```\n- b|', key: 'Alt-ArrowUp', after: '- b|\n- a\n  ```\n  # c\n  ```' },
    // A code block at the margin between two bullets is prose to the outline: it ends the group, so the
    // bullet below has no sibling above it. Read across the block, Alt+Up dropped the block's lines.
    { rule: 'Alt+Up on a bullet below a code block at the margin moves nothing, and never deletes the block', precedent: 'EtherPK', before: '- a\n```\nx\n```\n- b|', key: 'Alt-ArrowUp', after: '- a\n```\nx\n```\n- b|' },
    { rule: '…nor does Alt+Down on the bullet above it', precedent: 'EtherPK', before: '- a|\n```\nx\n```\n- b', key: 'Alt-ArrowDown', after: '- a|\n```\nx\n```\n- b' },
    { rule: 'on a fence line the whole owning branch moves, fence included', precedent: 'EtherPK', before: '- a\n- b\n  ```|\n  x\n  ```', key: 'Alt-ArrowUp', after: '- b\n  ```|\n  x\n  ```\n- a' },
    { rule: 'inside code the default line move reorders code lines', precedent: 'VS Code', before: '```\nx\ny|\n```', key: 'Alt-ArrowUp', after: '```\ny|\nx\n```' },
    { rule: 'inside code a move that would cross a fence is consumed', precedent: 'EtherPK', before: '```\nx|\ny\n```', key: 'Alt-ArrowUp', after: '```\nx|\ny\n```' },
    { rule: 'on a prose fence line the move is consumed', precedent: 'EtherPK', before: 'p\n```|\nx\n```', key: 'Alt-ArrowUp', after: 'p\n```|\nx\n```' },
    { rule: 'a prose line never moves up into the closer above it', precedent: 'EtherPK', before: '- a\n  ```\n  ```\np|', key: 'Alt-ArrowUp', after: '- a\n  ```\n  ```\np|' },
    { rule: 'a prose line never moves up into the tree above it', precedent: 'EtherPK', before: '- a\n  - b\np|', key: 'Alt-ArrowUp', after: '- a\n  - b\np|' },
    { rule: 'a prose line never moves down into the tree below it', precedent: 'EtherPK', before: 'p|\n- a\n  - b', key: 'Alt-ArrowDown', after: 'p|\n- a\n  - b' },
    { rule: 'a prose line never moves down into the opener below it', precedent: 'EtherPK', before: 'p|\n```\nx\n```', key: 'Alt-ArrowDown', after: 'p|\n```\nx\n```' },
    // CodeMirror's line move carries every line a range touches, so the line it swaps with is the one
    // beyond the range, not beside the caret.
    { rule: 'inside code a range moved up never carries its lines above the opener', precedent: 'EtherPK', before: '```\n«a\nb»\n```', key: 'Alt-ArrowUp', after: '```\n«a\nb»\n```' },
    { rule: 'a range of prose moved up never carries the closer above it below its lines', precedent: 'EtherPK', before: '```\nx\n```\n«p1\np2»', key: 'Alt-ArrowUp', after: '```\nx\n```\n«p1\np2»' },
    { rule: 'a range of prose moved up never swaps with the tree above it', precedent: 'EtherPK', before: '- a\n«p1\np2»', key: 'Alt-ArrowUp', after: '- a\n«p1\np2»' },
    { rule: 'a range that holds a fence without its partner never moves', precedent: 'EtherPK', before: '```\nx\n«```\np»\nq', key: 'Alt-ArrowDown', after: '```\nx\n«```\np»\nq' },
    { rule: 'a range from a tree down into prose never moves: the default move would leave its bullets without a parent', precedent: 'EtherPK', before: '- a\n  - b\n«    - c\np»\nq', key: 'Alt-ArrowDown', after: '- a\n  - b\n«    - c\np»\nq' },
    { rule: '…nor one dragged up from a tree into prose', precedent: 'EtherPK', before: 'r\n»p\n- a\n  - b«\n  - c', key: 'Alt-ArrowUp', after: 'r\n«p\n- a\n  - b»\n  - c' },
    { rule: '…nor one from a continuation line down into prose', precedent: 'EtherPK', before: '- a\n  «cont\np»\nq', key: 'Alt-ArrowDown', after: '- a\n  «cont\np»\nq' },
    { rule: '…nor one holding a bullet’s code block without its bullet', precedent: 'EtherPK', before: '- a\n  «```\n  x\n  ```\np»\nq', key: 'Alt-ArrowDown', after: '- a\n  «```\n  x\n  ```\np»\nq' },
    // A line short of the bullet's content column is prose, a blank one included, as it is for the caret.
    { rule: 'a range of prose short of a bullet’s content column moves, a blank line in it included', precedent: 'VS Code', before: '- a\n «p\n   \n q»\nr', key: 'Alt-ArrowDown', after: '- a\nr\n «p\n   \n q»' },
    { rule: '…and a one-space line under a bullet moves with the prose below it', precedent: 'VS Code', before: '- a\n« \np»\nq', key: 'Alt-ArrowDown', after: '- a\nq\n« \np»' },
    { rule: 'inside code a range reorders code lines as a caret does', precedent: 'VS Code', before: '```\na\n«b\nc»\n```', key: 'Alt-ArrowUp', after: '```\n«b\nc»\na\n```' },
])

table('a join is refused where the joined line would pair a fence differently', [
    // A bullet whose text is an unterminated fence, joined to the next bullet's text, becomes an opener
    // with that text for its info string, which takes the next block's opening fence for its closer.
    { rule: 'Delete at the end of a bullet whose text is a fence', precedent: 'EtherPK', before: '- ```p|\n- a\n  ```\n    - y\n  ```', key: 'Delete', after: '- ```p|\n- a\n  ```\n    - y\n  ```' },
    { rule: 'Backspace at the start of the bullet below it', precedent: 'EtherPK', before: '- ```p\n- |a\n  ```\n    - y\n  ```', key: 'Backspace', after: '- ```p\n- |a\n  ```\n    - y\n  ```' },
])

table('Backspace and Delete merge Logseq-style', [
    { rule: 'an empty bullet deletes as a block, caret at the end of the block above', precedent: 'Logseq', before: '- a\n- |', key: 'Backspace', after: '- a|' },
    { rule: 'an empty bullet at the top of the document drops its marker instead of nibbling it', precedent: 'Logseq', before: '- [x] |', key: 'Backspace', after: '|' },
    { rule: 'an empty bullet at the top of the document with a subtree removes itself and promotes the subtree', precedent: 'EtherPK', before: '- |\n  - a\n    - b\n- c', key: 'Backspace', after: '- |a\n  - b\n- c' },
    { rule: 'the promoted subtree keeps its continuation and fence', precedent: 'EtherPK', before: '- |\n  - a\n    soft\n    ```\n    x\n    ```', key: 'Backspace', after: '- |a\n  soft\n  ```\n  x\n  ```' },
    { rule: 'a subtree that is only a fence becomes top-level code', precedent: 'EtherPK', before: '- |\n  ```\n  x\n  ```', key: 'Backspace', after: '|```\nx\n```' },
    { rule: 'an empty top bullet over a lone continuation line becomes that line', precedent: 'EtherPK', before: '- |\n  soft', key: 'Backspace', after: '|soft' },
    { rule: 'an empty top bullet followed by a sibling still drops its marker', precedent: 'EtherPK', before: '- |\n- a', key: 'Backspace', after: '|\n- a' },
    { rule: 'the first body line under the frontmatter is the top: an empty bullet there drops its marker rather than joining the closer', precedent: 'EtherPK', before: '---\ntitle: K\n---\n- |', key: 'Backspace', after: '---\ntitle: K\n---\n|' },
    { rule: 'an empty first body bullet under the frontmatter with a sibling below drops its marker', precedent: 'EtherPK', before: '---\ntitle: K\n---\n- [ ] |\n- a', key: 'Backspace', after: '---\ntitle: K\n---\n|\n- a' },
    { rule: 'an empty first body bullet under the frontmatter with a subtree removes itself and promotes the subtree', precedent: 'EtherPK', before: '---\ntitle: K\n---\n- |\n  - a', key: 'Backspace', after: '---\ntitle: K\n---\n- |a' },
    { rule: 'an empty bullet under a blank line with a subtree removes itself and promotes the subtree', precedent: 'EtherPK', before: 'x\n\n- |\n  - a\n  - b', key: 'Backspace', after: 'x\n\n- |a\n- b' },
    { rule: 'an empty bullet under a heading with a subtree removes itself and promotes the subtree', precedent: 'EtherPK', before: '# H\n- |\n  - a\n    - b\n- c', key: 'Backspace', after: '# H\n- |a\n  - b\n- c' },
    { rule: 'an empty bullet under prose with a subtree removes itself and promotes the subtree', precedent: 'EtherPK', before: 'p\n- |\n  - a', key: 'Backspace', after: 'p\n- |a' },
    { rule: 'an empty bullet under a fence closer with a subtree promotes the subtree beside the fence’s owner', precedent: 'EtherPK', before: '- x\n  ```\n  ```\n- |\n  - a', key: 'Backspace', after: '- x\n  ```\n  ```\n- |a' },
    { rule: 'an empty bullet under a blank line with no subtree joins the blank as before', precedent: 'EtherPK', before: 'x\n\n- |\n- a', key: 'Backspace', after: 'x\n|\n- a' },
    { rule: 'at content start, a non-empty bullet merges onto the line above', precedent: 'Logseq', before: '- a\n- |b', key: 'Backspace', after: '- a|b' },
    { rule: 'the merge target is the visually adjacent block, whatever its depth', precedent: 'Logseq', before: '- a\n  - b\n- |c', key: 'Backspace', after: '- a\n  - b|c' },
    { rule: 'a merge that would strand a child more than one unit down is refused — so a four-space child (foreign text) refuses a merge two-space text allows', precedent: 'EtherPK', before: '- a\n- |b\n    - c', key: 'Backspace', after: '- a\n- |b\n    - c' },
    { rule: 'at the group’s top boundary (a heading) the key is consumed', precedent: 'EtherPK', before: '# H\n- |a', key: 'Backspace', after: '# H\n- |a' },
    { rule: 'at the group’s top boundary (a blank line) the key is consumed', precedent: 'EtherPK', before: 'x\n\n- |a', key: 'Backspace', after: 'x\n\n- |a' },
    { rule: 'a continuation at its floor merges up rather than eating structural indent', precedent: 'EtherPK', before: '- a\n  |x', key: 'Backspace', after: '- a|x' },
    // A continuation after the block's children is the block's (ADR 0089): the joins read it so.
    { rule: 'a continuation after the children merges up onto the last child', precedent: 'EtherPK', before: '- a\n  - b\n  |trailing', key: 'Backspace', after: '- a\n  - b|trailing' },
    { rule: 'Delete at the end of a continuation after the children merges the next block in', precedent: 'EtherPK', before: '- a\n  - b\n  trailing|\n- c\n  - d', key: 'Delete', after: '- a\n  - b\n  trailing|c\n  - d' },
    { rule: 'a merge onto a continuation after the children measures against the owner, so the merged soft line stays at its floor', precedent: 'EtherPK', before: '- a\n  - b\n  trailing\n- |c\n  soft', key: 'Backspace', after: '- a\n  - b\n  trailing|c\n  soft' },
    { rule: 'within content, Backspace deletes a character as usual', precedent: 'VS Code', before: '- ab|', key: 'Backspace', after: '- a|' },
    { rule: 'Delete at the end of a bullet pulls the next block up', precedent: 'Logseq', before: '- a|\n- b', key: 'Delete', after: '- a|b' },
    { rule: 'Delete at the end of a bullet never pulls a fence opener up', precedent: 'EtherPK', before: '- a|\n  ```\n  x\n  ```', key: 'Delete', after: '- a|\n  ```\n  x\n  ```' },
    { rule: 'a merge onto a soft line measures stranding against its owning bullet', precedent: 'EtherPK', before: '- a\n  soft\n  - |b\n    - c', key: 'Backspace', after: '- a\n  soft\n  - |b\n    - c' },
    { rule: 'a merge onto a deeper sibling (foreign text) carries the block’s soft line to the new content column', precedent: 'EtherPK', before: '- a\n    - x\n  - |c\n    soft', key: 'Backspace', after: '- a\n    - x|c\n      soft' },
    { rule: 'Delete at the end of a soft line pulls the next block up too, never splicing its marker', precedent: 'Logseq', before: '- a\n  soft|\n- b', key: 'Delete', after: '- a\n  soft|b' },
    { rule: 'Delete at the group’s bottom edge is consumed', precedent: 'EtherPK', before: '- a|\n\n- b', key: 'Delete', after: '- a|\n\n- b' },
    { rule: 'deleting whole blocks lands the caret at the end of the previous sibling', precedent: 'EtherPK', before: '- a\n«- b\n- c»', key: 'Backspace', after: '- a|' },
    { rule: 'deleting from the first block line lands the caret at the new first block’s content start', precedent: 'EtherPK', before: '«- a\n- b\n»- c', key: 'Delete', after: '- |c' },
    { rule: 'deleting a middle block re-indents a level-jumped survivor', precedent: 'EtherPK', before: '- a\n«  - b\n»    - c', key: 'Backspace', after: '- a|\n  - c' },
    // The heal stays in the deletion's group (ADR 0021). A bare blank line ends every branch, so nothing
    // after one was under the deleted blocks: it is left as it was, as is everything after a heading. An
    // indented soft line is inside its block, so the heal goes on past it, and it moves with its bullet.
    { rule: 'deleting blocks that end at a bare blank line leaves the group after it as it was', precedent: 'EtherPK', before: '- a\n«- b\n  - c»\n\n  p\n    - d', key: 'Backspace', after: '- a|\n\n  p\n    - d' },
    { rule: '…with Delete too', precedent: 'EtherPK', before: '- a\n«- b\n  - c»\n\n  p\n    - d', key: 'Delete', after: '- a|\n\n  p\n    - d' },
    { rule: '…and at the top of the document, with no group left above', precedent: 'EtherPK', before: '«- a\n  - b»\n\n  p\n    - d', key: 'Backspace', after: '|\n  p\n    - d' },
    { rule: '…and the group after a heading is left as it was too', precedent: 'EtherPK', before: '- a\n«- b\n  - c»\n## H\n  - d', key: 'Backspace', after: '- a|\n## H\n  - d' },
    { rule: 'an indented soft line among the survivors does not stop the heal, and moves with its bullet', precedent: 'EtherPK', before: 'p«x\n- a\n  - b»\n    - c\n      \n      q\n    - d', key: 'Backspace', after: 'p|\n  - c\n    \n    q\n  - d' },
    { rule: '…and a code block after it stays with the bullet whose block it is in', precedent: 'EtherPK', before: '- a\n«  - p\n    - q\n»      - b\n  \n  ```\n  x\n  ```', key: 'Backspace', after: '- a|\n  - b\n  \n  ```\n  x\n  ```' },
    // A deletion that starts in a heading leaves that heading at the join, and the blocks after it were
    // under the deleted ones: they are healed as a group of their own, under the heading.
    { rule: 'deleting from the end of a heading into blocks heals the survivors after the heading', precedent: 'EtherPK', before: '# Garden«\n- water the beans\n  every morning»\n  - check the soil', key: 'Backspace', after: '# Garden|\n- check the soil' },
    { rule: '…and from inside a heading', precedent: 'EtherPK', before: '- kitchen\n## Gar«den\n- water the beans\n  - check the soil»\n    - add compost', key: 'Delete', after: '- kitchen|\n## Gar\n- add compost' },
    { rule: 'a within-line selection that takes the top bullet’s marker removes the block and promotes its subtree', precedent: 'EtherPK', before: '«- a»\n  - b\n    - c', key: 'Backspace', after: '- |b\n  - c' },
    { rule: 'a within-line selection that takes a middle bullet’s marker re-flows its children under the block above', precedent: 'EtherPK', before: '- x\n«- a»\n  - b', key: 'Delete', after: '- x\n  - |b' },
    // A selection from prose over a bullet's marker takes the bullet with it: its text joins the prose
    // line, and its children come up a level, as when the bullet button makes a bullet prose. A prose
    // line is never a parent, so they were left indented under it.
    { rule: 'a selection from prose over a bullet’s marker brings its children up a level', precedent: 'EtherPK', before: 'pro«se\n- »a\n  - b', key: 'Delete', after: 'pro|a\n- b' },
    { rule: '…with Backspace too', precedent: 'EtherPK', before: 'pro«se\n- »a\n  - b', key: 'Backspace', after: 'pro|a\n- b' },
    { rule: '…the bullet’s own continuation going to the margin with its text', precedent: 'EtherPK', before: 'pro«se\n- »a\n  cont\n  - b', key: 'Delete', after: 'pro|a\ncont\n- b' },
    { rule: '…grandchildren staying under their parent', precedent: 'EtherPK', before: 'pro«se\n- »a\n  - b\n    - c', key: 'Delete', after: 'pro|a\n- b\n  - c' },
    { rule: 'Enter over such a selection splits the prose and brings the children up a level', precedent: 'EtherPK', before: 'pro«se\n- »a\n  - b', key: 'Enter', after: 'pro\n|a\n- b' },
    { rule: '…the bullet’s own code block going to the margin with it, as the bullet button takes it', precedent: 'EtherPK', before: 'pro«se\n- »a\n  ```\n  x\n  ```\n  - b', key: 'Delete', after: 'pro|a\n```\nx\n```\n- b' },
    { rule: '…and only that bullet’s lines: a list nested under prose above keeps its place', precedent: 'EtherPK', before: 'Todo:\n  - t\npro«se\n- »a\n  - b', key: 'Enter', after: 'Todo:\n  - t\npro\n|a\n- b' },
    { rule: 'Shift+Backspace over such a selection does the same as Backspace', precedent: 'EtherPK', before: 'pro«se\n- »a\n  - b', key: 'Shift-Backspace', after: 'pro|a\n- b' },
    // The deletion that takes a form-1 bullet's marker takes its fence's backticks too, so the block is
    // already gone: its code moved to the margin would pair its old closer with a later block's opener.
    { rule: '…unless its lines at the margin would pair a fence differently: a form-1 bullet’s code stays where it was', precedent: 'EtherPK', before: 'pro«se\n- ``»`py\n  code\n  ```\n\n```\nz\n```', key: 'Delete', after: 'pro|`py\n  code\n  ```\n\n```\nz\n```' },
    { rule: 'Shift+Backspace over a range of blocks deletes them as Backspace does, the caret where Backspace leaves it', precedent: 'EtherPK', before: '- a\n«  - b\n    - c»', key: 'Shift-Backspace', after: '- a|' },
    { rule: '…and Ctrl+Backspace', precedent: 'EtherPK', before: '- a\n«  - b\n    - c»', key: 'Mod-Backspace', after: '- a|' },
    { rule: '…and Ctrl+Delete', precedent: 'EtherPK', before: '- a\n«  - b\n    - c»', key: 'Mod-Delete', after: '- a|' },
    { rule: 'Shift+Backspace over prose lines deletes them as Backspace does', precedent: 'EtherPK', before: 'p\n«q\nr»', key: 'Shift-Backspace', after: 'p|' },
    // A prose line is a node a deeper line may nest under (`Shopping:` over `  - eggs`), so a selection
    // that takes no bullet into prose leaves the lists around it as they are.
    { rule: 'a selection across prose lines leaves a list nested under the prose below as it is', precedent: 'EtherPK', before: 'te«xt\nmo»re\nShopping:\n  - eggs', key: 'Backspace', after: 'te|re\nShopping:\n  - eggs' },
    { rule: 'Enter over a selection across indented prose keeps the indent', precedent: 'VS Code', before: '  pro«se\n  mo»re', key: 'Enter', after: '  pro\n  |re' },
    { rule: 'Enter in a continuation line splits it as before, the lists around it untouched', precedent: 'EtherPK', before: 'Todo:\n  - t\n- a\n  on|e\n  two\nMore:\n  - m', key: 'Enter', after: 'Todo:\n  - t\n- a\n  on\n- |e\n  two\nMore:\n  - m' },
    { rule: 'deleting a block after a prose line nested under a bullet keeps the bullet under it', precedent: 'EtherPK', before: '- a\n p\n   - b\n«- c\n»- d', key: 'Backspace', after: '- a|\n p\n   - b\n- d' },
    { rule: 'clearing a bullet’s content within the line keeps the block (marker and children stay)', precedent: 'VS Code', before: '- «a»\n  - b', key: 'Backspace', after: '- |\n  - b' },
    { rule: 'taking the marker of the only line leaves an empty document', precedent: 'VS Code', before: '«- a»', key: 'Backspace', after: '|' },
    { rule: 'taking only the marker leaves the content as prose and re-parents the children', precedent: 'EtherPK', before: '«- »a\n  - b\n    - c', key: 'Backspace', after: '|a\n- b\n  - c' },
    { rule: 'taking a nested bullet’s marker leaves a soft line of the parent; its children become the parent’s', precedent: 'EtherPK', before: '- p\n  «- »a\n    - b\n- q', key: 'Backspace', after: '- p\n  |a\n  - b\n- q' },
    { rule: 'a bullet-shaped line inside a fence is code: the delete is the delete', precedent: 'CommonMark', before: '```\n«- x»\n```', key: 'Backspace', after: '```\n|\n```' },
    { rule: 'a bullet-shaped line inside a form-2 fence is code too', precedent: 'CommonMark', before: '- a\n  ```\n  «- x»\n  ```\n  - b', key: 'Backspace', after: '- a\n  ```\n  |\n  ```\n  - b' },
    { rule: 'a YAML list entry in the frontmatter is not a bullet', precedent: 'EtherPK', before: '---\ntags:\n  «- a»\n---\n- b', key: 'Backspace', after: '---\ntags:\n  |\n---\n- b' },
])

describe('the survivors of a block delete keep one level under the soft line’s bullet (ADR 0021)', () => {
    it('Backspace over the blocks under a soft line heals their child to the bullet’s level', () => {
        const editor = editorFixture('- a\n  soft\n  «- b\n  - c»\n    - d')
        editor.key('Backspace')
        expect(editor.text()).toBe('- a\n  soft\n  - d')
    })
})

// The Command Bar's Outdent runs the command alone; the keyboard's Shift+Tab reaches code handlers first.
describe('the outdent command on code or YAML (the Command Bar’s Outdent)', () => {
    for (const before of ['```md\n- in fen|ce\n```', '- ```md\n  - in fen|ce\n  ```', '---\ntags:\n- fo|o\n---\nbody']) {
        it(`leaves ${JSON.stringify(before)} as it is`, () => {
            const editor = editorFixture(before)
            outdentBranch(editor as never)
            expect(editor.fixture()).toBe(before)
        })
    }
})

// Past the root the line's text reaches the margin, where a fence pairs with another fence there and a
// `---` can close a frontmatter block. The Outdent button leaves those as they are, as Shift+Tab does.
describe('the outdent command past the root where the margin would re-pair a fence or form frontmatter (the Command Bar’s Outdent)', () => {
    for (const before of ['- ```py|\ntext\n```\ncode\n```', '```js\ntext\n- ```|', '---\ntitle: x\n- ---|\nbody']) {
        it(`leaves ${JSON.stringify(before)} as it is`, () => {
            const editor = editorFixture(before)
            outdentBranch(editor as never)
            expect(editor.fixture()).toBe(before)
        })
    }
})

describe('cutting blocks heals the survivors (ADR 0021)', () => {
    const cut = (before: string) => {
        const editor = editorFixture(before)
        editor.cut()
        return editor.fixture()
    }
    it('heals the survivors of a block selection that starts on a form-1 bullet, as for any bullet', () => {
        expect(cut('- a\n«- ```py\n  x\n  ```\n  - c1»\n    - c2')).toBe(cut('- a\n«- p\n  x\n  - c1»\n    - c2'))
        expect(cut('- a\n«- ```py\n  x\n  ```\n  - c1»\n    - c2')).toBe('- a\n  - |c2')
    })
    it('reads a soft line above the cut as its bullet’s, not as a parent the survivors may hang deeper under', () => {
        expect(cut('- a\n  soft\n  «- b\n  - c»\n    - d').replace('|', '')).toBe('- a\n  soft\n  - d')
    })
    it('pulls the orphaned descendants up to indent 0 when the whole top of the tree went', () => {
        expect(cut('«- a\n  - b\n  - c\n    - d\n»      - e\n    - f\n    - g')).toBe('- |e\n- f\n- g')
    })
    it('a within-line cut that takes the top bullet’s marker removes the block and promotes its subtree', () => {
        expect(cut('«- a»\n  - b\n    - c')).toBe('- |b\n  - c')
    })
    it('pulls them to one level under the nearest surviving ancestor otherwise', () => {
        expect(cut('- a\n«  - b\n    - c\n»      - d\n  - e')).toBe('- a\n  - |d\n  - e')
    })
    it('moves a fenced block with its owner, fences still paired', () => {
        expect(cut('«- a\n  - b\n»    - ```\n      x\n      ```\n    - c')).toBe('- |```\n  x\n  ```\n- c')
    })
    it('leaves a single-line cut alone', () => {
        expect(cut('- a\n  - «b»\n    - c')).toBe('- a\n  - |\n    - c')
    })
    it('stops at a bare blank line: the group after it is left as it was', () => {
        expect(cut('- a\n«- b\n  - c»\n\n  p\n    - d')).toBe('- a\n|\n  p\n    - d')
        expect(cut('- a\n«- b\n  - c»\n## H\n  - d')).toBe('- a\n|## H\n  - d')
    })
    it('leaves a paragraph after a bare blank line, and the list under it, where they were', () => {
        // A block selection runs to the end of its last branch, which a bare blank line ends. Text written
        // by another tool can have a paragraph and a list after that line, deeper than the blocks cut:
        // they were never under them, so they keep their places.
        const after = '\n        four\n          - five\n      *six*\n      - seven\n    - after'
        expect(cut(`- top\n  - head\n    - kept\n    «- one\n      - two\n        - three»\n${after}`)).toBe(`- top\n  - head\n    - kept\n|${after}`)
    })
    it('heals past an indented soft line, which moves with its bullet', () => {
        expect(cut('p«x\n- a\n  - b»\n    - c\n      \n      q\n    - d')).toBe('p|\n  - c\n    \n    q\n  - d')
    })
    it('heals the survivors after a heading the cut started in', () => {
        expect(cut('# Garden«\n- water the beans\n  - check the soil»\n    - add compost')).toBe('# Garden|\n- add compost')
    })
    it('keeps a blank line that followed whole lines cut from line start to line start', () => {
        // No line is joined, so the blank line is the one that was there, not an artifact of the join.
        expect(cut('- a\n«- b\n- c\n»\n  - x')).toBe('- a\n|\n  - x')
    })
})

table('Enter over a block selection leaves one empty block in its place', [
    { rule: 'the blocks go, and an empty block takes the first one’s place', precedent: 'EtherPK', before: '- a\n«  - b\n  - c»\n  - d', key: 'Enter', after: '- a\n  - |\n  - d' },
    { rule: 'a task stays a task, open again', precedent: 'EtherPK', before: '«- [x] a\n- b»\n- c', key: 'Enter', after: '- [ ] |\n- c' },
    // A drag that ends in a block whose last content is code has its head on the closing fence, and one
    // made upwards from a form-1 block has it in the code: the selection is the outliner's, not the code's.
    { rule: 'with the head on a closing fence', precedent: 'EtherPK', before: '«- a\n- b\n  ```\n  code\n  ```»\n- c', key: 'Enter', after: '- |\n- c' },
    { rule: 'with the head in a form-1 block’s code, made upwards', precedent: 'EtherPK', before: '»- ```js\n  x\n  ```\n- b«\n- c', key: 'Enter', after: '- |\n- c' },
    // Shift+Enter is a line break too, so over a block selection it does what Enter does, wherever the head is.
    { rule: 'Shift+Enter does the same, with the head on a bullet', precedent: 'EtherPK', before: '- a\n«  - b\n  - c»\n  - d', key: 'Shift-Enter', after: '- a\n  - |\n  - d' },
    { rule: 'Shift+Enter does the same, with the head on a continuation line', precedent: 'EtherPK', before: '- a\n«  - b\n  - c\n    more»\n  - d', key: 'Shift-Enter', after: '- a\n  - |\n  - d' },
    { rule: 'Shift+Enter does the same, with the head on a closing fence', precedent: 'EtherPK', before: '«- a\n- b\n  ```\n  code\n  ```»\n- c', key: 'Shift-Enter', after: '- |\n- c' },
])

// Logseq's cycle-todos!: every selected block cycles from its own state. Here that is every block the
// selection highlights, its children included (Editor Content Rules → Selection).
table('Mod+Shift+Enter over a block selection cycles every block in it', [
    { rule: 'each block cycles from its own state', precedent: 'Logseq', before: '«- a\n- [ ] b\n- [x] c»', key: 'Mod-Shift-Enter', after: '«- [ ] a\n- [x] b\n- c»' },
    { rule: 'a selected block’s children cycle too', precedent: 'EtherPK', before: '«- a\n  - b»\n- c', key: 'Mod-Shift-Enter', after: '«- [ ] a\n  - [ ] b»\n- c' },
    // A block selection already acts on every block nested under the ones it takes, so a tick there
    // brings nothing more with it: each block still cycles from its own state.
    { rule: '…each from its own state, a ticked parent ticking nothing under it', precedent: 'EtherPK', before: '«- [ ] a\n  - [x] b»\n- c', key: 'Mod-Shift-Enter', after: '«- [x] a\n  - b»\n- c' },
    { rule: 'an empty bullet is left as it is', precedent: 'Logseq', before: '«- a\n- \n- b»', key: 'Mod-Shift-Enter', after: '«- [ ] a\n- \n- [ ] b»' },
    { rule: 'a bullet whose code opens on its line is left as it is, and its code too', precedent: 'EtherPK', before: '«- a\n- ```md\n  - x\n  ```»', key: 'Mod-Shift-Enter', after: '«- [ ] a\n- ```md\n  - x\n  ```»' },
    { rule: 'continuation lines and prose are left as they are', precedent: 'EtherPK', before: '«- a\n  soft\n\nprose»', key: 'Mod-Shift-Enter', after: '«- [ ] a\n  soft\n\nprose»' },
])

table('Mod+Shift+Enter cycles the task state', [
    { rule: 'plain bullet becomes an open task', precedent: 'EtherPK', before: '- a|', key: 'Mod-Shift-Enter', after: '- [ ] a|' },
    { rule: 'open task becomes done', precedent: 'EtherPK', before: '- [ ] a|', key: 'Mod-Shift-Enter', after: '- [x] a|' },
    { rule: 'done task becomes a plain bullet', precedent: 'EtherPK', before: '- [x] a|', key: 'Mod-Shift-Enter', after: '- a|' },
    // Ticking a task ticks every task nested under it, at any depth and through plain bullets, which
    // stay plain (Editor Content Rules → Tasks nested under a task). The other two steps make and
    // remove a task, which is neither a tick nor an untick, so they bring nothing with them.
    { rule: 'an open task made done ticks every task nested under it', precedent: 'EtherPK', before: '- [ ] a|\n  - [ ] b\n    - c\n      - [ ] d\n- [ ] e', key: 'Mod-Shift-Enter', after: '- [x] a|\n  - [x] b\n    - c\n      - [x] d\n- [ ] e' },
    { rule: '…and nothing above it: a nested task ticked leaves its parent open', precedent: 'EtherPK', before: '- [ ] a\n  - [ ] b|\n  - [ ] c', key: 'Mod-Shift-Enter', after: '- [ ] a\n  - [x] b|\n  - [ ] c' },
    { rule: 'a done task made a plain bullet leaves its nested tasks as they are', precedent: 'EtherPK', before: '- [x] a|\n  - [x] b', key: 'Mod-Shift-Enter', after: '- a|\n  - [x] b' },
    { rule: 'a plain bullet made a task leaves its nested tasks as they are', precedent: 'EtherPK', before: '- a|\n  - [x] b', key: 'Mod-Shift-Enter', after: '- [ ] a|\n  - [x] b' },
    { rule: 'a task-shaped line in a code block under the task is code, and stays as it is', precedent: 'EtherPK', before: '- [ ] a|\n  ```md\n  - [ ] x\n  ```\n  - [ ] b', key: 'Mod-Shift-Enter', after: '- [x] a|\n  ```md\n  - [ ] x\n  ```\n  - [x] b' },
    // Fences are read as the derived index reads them: an opener with no closer is no block, so the
    // task under it is a task the Tasks View lists, and it is ticked with its parent.
    { rule: 'a task under a fence with no closer is still a task, and is ticked', precedent: 'EtherPK', before: '- [ ] a|\n  ```\n  - [ ] b', key: 'Mod-Shift-Enter', after: '- [x] a|\n  ```\n  - [x] b' },
    // A prose line enters the list as Tab makes it: at column 0, its spaces dropped (kept, they
    // would make an indented task under nothing, or one off the grid), and the bullets below are
    // healed one level under it at most.
    { rule: 'a prose line becomes a task at column 0, its spaces dropped', precedent: 'EtherPK', before: '  text|', key: 'Mod-Shift-Enter', after: '- [ ] text|' },
    { rule: '…a line one space in under a list too: it is prose', precedent: 'EtherPK', before: '- a\n te|xt', key: 'Mod-Shift-Enter', after: '- a\n- [ ] te|xt' },
    { rule: '…and the bullets below it are healed one level under the new task', precedent: 'EtherPK', before: '  te|xt\n    - c', key: 'Mod-Shift-Enter', after: '- [ ] te|xt\n  - c' },
    { rule: 'a continuation becomes a child task of its bullet', precedent: 'Logseq', before: '- a\n  text|', key: 'Mod-Shift-Enter', after: '- a\n  - [ ] text|' },
    { rule: 'an over-indented continuation still becomes a child, never an orphan', precedent: 'EtherPK', before: '- a\n      te|xt', key: 'Mod-Shift-Enter', after: '- a\n  - [ ] te|xt' },
    { rule: 'an empty indented line under a bullet becomes a child task', precedent: 'EtherPK', before: '- a\n    |', key: 'Mod-Shift-Enter', after: '- a\n  - [ ] |' },
    { rule: 'a range across one block’s lines cycles that block, as Tab nests it', precedent: 'Logseq', before: '- «a\n  so»ft', key: 'Mod-Shift-Enter', after: '- [ ] «a\n  so»ft' },
    // An unterminated fence line is prose; as a bullet or a task it would open a block that pairs with
    // the next fence at its column, taking that block's opener for its closer.
    { rule: 'an unterminated fence line is refused', precedent: 'EtherPK', before: '```py|\n- b\n  ```\n  code\n  ```', key: 'Mod-Shift-Enter', after: '```py|\n- b\n  ```\n  code\n  ```' },
    { rule: 'a heading is refused', precedent: 'EtherPK', before: '# h|', key: 'Mod-Shift-Enter', after: '# h|' },
    { rule: 'a bullet-shaped line inside a fence is code: refused', precedent: 'EtherPK', before: '- ```md\n  - |x\n  ```', key: 'Mod-Shift-Enter', after: '- ```md\n  - |x\n  ```' },
    { rule: 'a YAML list entry in the frontmatter is metadata: refused', precedent: 'EtherPK', before: '---\ntags:\n  - fo|o\n---', key: 'Mod-Shift-Enter', after: '---\ntags:\n  - fo|o\n---' },
    { rule: 'a prose line that split a group re-joins it as a task and the blocks below are healed', precedent: 'EtherPK', before: '- a\n  - b\n|\n    - c', key: 'Mod-Shift-Enter', after: '- a\n  - b\n- [ ] |\n  - c' },
    { rule: 'the heal below a new task goes on past an indented soft line, which moves with its bullet', precedent: 'EtherPK', before: '  te|xt\n    - c\n      \n    - d', key: 'Mod-Shift-Enter', after: '- [ ] te|xt\n  - c\n    \n  - d' },
    { rule: '…and a code block after it stays the new task’s', precedent: 'EtherPK', before: 'Sho|pping\n      - eggs\n  \n  ```py\n  if x:\n      y\n  ```', key: 'Mod-Shift-Enter', after: '- [ ] Sho|pping\n  - eggs\n  \n  ```py\n  if x:\n      y\n  ```' },
])

// A click on a task's checkbox ticks or unticks it, never cycling it to a plain bullet
// (augmentations/task-checkbox.ts), and brings the tasks nested under it along as the task toggle
// does (Editor Content Rules → Tasks nested under a task).
describe('a click on a task’s checkbox (EtherPK)', () => {
    function click(before: string, line: number): string {
        const editor = editorFixture(before)
        const spec = checkboxClick(editor.state, editor.state.doc.line(line).from + lineIndent(editor.state.doc.line(line).text) + 3)
        if (spec) editor.dispatch(editor.state.update(spec))
        return editor.fixture()
    }

    it('ticks the task and every task nested under it, through a plain bullet', () => {
        expect(click('- [ ] a\n  - b\n    - [ ] c\n- [ ] d|', 1)).toBe('- [x] |a\n  - b\n    - [x] c\n- [ ] d')
    })

    it('unticks them, leaving a Cancelled one ticked', () => {
        expect(click('- [x] a\n  - [x] #C b\n  - [x] c|', 1)).toBe('- [ ] |a\n  - [x] #C b\n  - [ ] c')
    })

    it('ticks a nested task alone, its parent left open', () => {
        expect(click('- [ ] a\n  - [ ] b|', 2)).toBe('- [ ] a\n  - [x] |b')
    })

    it('is one undo step', () => {
        const editor = editorFixture('- [ ] a|\n  - [ ] b')
        editor.dispatch(editor.state.update(checkboxClick(editor.state, 3)!))
        editor.key('Mod-z')
        expect(editor.fixture()).toBe('- [ ] a|\n  - [ ] b')
    })
})

// While a fence just typed on its own line is held pending, the editor shows the blocks below as they
// were, and the task toggle reads them so too: the Command Bar's gate and the key agree.
describe('Shift+Tab reads a form-1 block as the editor shows it while a fence is pending (EtherPK)', () => {
    it('outdents a nested form-1 bullet from its opener, with a fence just typed above', () => {
        const editor = editorFixture('|\n- a\n  - ```py\n    code\n    ```\n\n```\nz\n```')
        editor.type('```')
        expect(analysisFor(editor.state).pendingFence).toBe(0)
        editor.select(editor.text().indexOf('  - ```py') + 9)
        editor.key('Shift-Tab')
        expect(editor.text()).toBe('```\n- a\n- ```py\n  code\n  ```\n\n```\nz\n```')
    })
})

describe('Mod+Shift+Enter reads a form-1 block as the editor shows it while a fence is pending (EtherPK)', () => {
    it('refuses a range from a form-1 opener into its code, with a fence just typed above', () => {
        const editor = editorFixture('|\n- a\n- ```py\n  code\n  ```\n\n```\nz\n```')
        editor.type('```')
        expect(analysisFor(editor.state).pendingFence).toBe(0)
        const doc = editor.text()
        editor.select(doc.indexOf('py'), doc.indexOf('code') + 2)
        expect(taskToggleable(editor.state)).toBe(false)
        editor.key('Mod-Shift-Enter')
        expect(editor.text()).toBe(doc)
    })
})

// A code block at or left of a bullet's indent is no part of a sibling's branch: a block at the margin
// is prose that ends the group, and a parent's own block between its children closes the one above.
// The outline walk reads both so, and the boundary normaliser undid a Tab that nested across one.
table('Tab never nests a bullet across a code block at or left of its indent', [
    { rule: 'Tab on a bullet below a code block at the margin is refused: the block ends the group', precedent: 'EtherPK', before: '- a\n```\nx\n```\n- b|', key: 'Tab', after: '- a\n```\nx\n```\n- b|' },
    { rule: 'Tab on a child below its parent’s own code block is refused: the block closes the child above', precedent: 'EtherPK', before: '- p\n  - a\n  ```\n  x\n  ```\n  - b|', key: 'Tab', after: '- p\n  - a\n  ```\n  x\n  ```\n  - b|' },
    { rule: 'Tab on a bullet below its sibling’s own code block nests it, the block going with the sibling', precedent: 'Logseq', before: '- a\n  ```\n  x\n  ```\n- b|', key: 'Tab', after: '- a\n  ```\n  x\n  ```\n  - b|' },
])

// A table row cannot stand alone, because as a block it would leave the table without its header or
// its separator. Tab and the task toggle leave a row as it is, as they leave a heading. The bullet
// line a table opens on is a bullet like any other.
table('Tab and Mod+Shift+Enter leave a table row alone', [
    { rule: 'Tab on a prose table’s header row is consumed', precedent: 'EtherPK', before: '| a¦ | b |\n| --- | --- |\n| 1 | 2 |', key: 'Tab', after: '| a¦ | b |\n| --- | --- |\n| 1 | 2 |' },
    { rule: 'Tab on a body row too', precedent: 'EtherPK', before: '| a | b |\n| --- | --- |\n| 1¦ | 2 |', key: 'Tab', after: '| a | b |\n| --- | --- |\n| 1¦ | 2 |' },
    { rule: 'Tab on a row of a table on a bullet’s continuation lines', precedent: 'EtherPK', before: '- notes\n  | a | b |\n  | --- | --- |\n  | 1¦ | 2 |', key: 'Tab', after: '- notes\n  | a | b |\n  | --- | --- |\n  | 1¦ | 2 |' },
    { rule: 'Mod+Shift+Enter on a table row is refused', precedent: 'EtherPK', before: '| a | b |\n| --- | --- |\n| 1¦ | 2 |', key: 'Mod-Shift-Enter', after: '| a | b |\n| --- | --- |\n| 1¦ | 2 |' },
    { rule: 'Tab on the bullet line a table opens on nests the block, its table with it', precedent: 'Logseq', before: '- x\n- | a¦ | b |\n  | --- | --- |\n  | 1 | 2 |', key: 'Tab', after: '- x\n  - | a¦ | b |\n    | --- | --- |\n    | 1 | 2 |' },
], { caret: '¦' })

/**
 * A row for the Command Bar's bullet toggle (`editor.toggleBullet`, editor-commands.ts), which no key
 * runs: `key` is one `bullet` per tap. A one-tap row also checks the button's gate, which the bar greys
 * on: it is live exactly where the tap changes the text, so a greyed button never hides an edit and a
 * live one never does nothing.
 */
function bulletButtonTable(name: string, rows: Rule[], options: FixtureOptions = {}) {
    describe(name, () => {
        for (const row of rows) {
            it(`${row.key}: ${row.rule} (${row.precedent})`, () => {
                const editor = editorFixture(row.before, options)
                const taps = row.key.split(' ')
                const live = bulletToggleable(editor.state)
                taps.forEach(() => toggleBullet(editor as never))
                expect(editor.fixture()).toBe(row.after)
                if (taps.length === 1) expect(live).toBe(row.after !== row.before)
            })
        }
    })
}

// Prose enters the list as Tab makes it a block, and a top-level bullet leaves it as Shift+Tab past the
// root does. Only a bullet at column 0 becomes prose: a prose line may only land between two top-level
// trees (Editor Content Rules → Splits never orphan), so a nested bullet is refused.
bulletButtonTable('the Command Bar bullet toggle', [
    { rule: 'a prose line becomes a bullet, the caret on its character', precedent: 'Obsidian', before: 'te|xt', key: 'bullet', after: '- te|xt' },
    { rule: 'an empty line becomes an empty bullet', precedent: 'Obsidian', before: '|', key: 'bullet', after: '- |' },
    { rule: 'an empty line after a group becomes its next block', precedent: 'EtherPK', before: '- a\n|', key: 'bullet', after: '- a\n- |' },
    { rule: 'a prose line becomes a bullet at column 0, its spaces dropped', precedent: 'EtherPK', before: '  te|xt', key: 'bullet', after: '- te|xt' },
    { rule: '…a line one space in under a list too: it is prose', precedent: 'EtherPK', before: '- a\n te|xt', key: 'bullet', after: '- a\n- te|xt' },
    { rule: 'a continuation becomes a child of its bullet', precedent: 'Logseq', before: '- a\n  te|xt', key: 'bullet', after: '- a\n  - te|xt' },
    { rule: 'an empty indented line under a bullet becomes an empty child', precedent: 'EtherPK', before: '- a\n    |', key: 'bullet', after: '- a\n  - |' },
    { rule: 'the bullets below a new bullet are healed one level under it', precedent: 'EtherPK', before: '  te|xt\n    - c', key: 'bullet', after: '- te|xt\n  - c' },
    { rule: 'a prose line that split a group re-joins it and the blocks below are healed', precedent: 'EtherPK', before: '- a\n  - b\n|\n    - c', key: 'bullet', after: '- a\n  - b\n- |\n  - c' },
    { rule: 'the heal below a new bullet goes on past an indented soft line, which moves with its bullet', precedent: 'EtherPK', before: '  te|xt\n    - c\n      \n    - d', key: 'bullet', after: '- te|xt\n  - c\n    \n  - d' },
    { rule: 'a top-level bullet becomes prose, the caret on its character', precedent: 'Obsidian', before: '- te|xt', key: 'bullet', after: 'te|xt' },
    { rule: 'an empty top-level bullet becomes an empty line', precedent: 'Obsidian', before: '- |', key: 'bullet', after: '|' },
    { rule: 'a top-level task becomes prose, its checkbox going with the marker', precedent: 'EtherPK', before: '- [ ] te|xt', key: 'bullet', after: 'te|xt' },
    { rule: 'the children of a bullet made prose come up a level, never left under prose', precedent: 'EtherPK', before: '- a|\n  - b\n    - c', key: 'bullet', after: 'a|\n- b\n  - c' },
    { rule: 'its own continuation and fence go to column 0 with it', precedent: 'EtherPK', before: '- a|\n  soft\n  ```\n  x\n  ```\n  - b', key: 'bullet', after: 'a|\nsoft\n```\nx\n```\n- b' },
    { rule: 'between two top-level bullets the prose line splits the group', precedent: 'EtherPK', before: '- a\n- b|\n- c', key: 'bullet', after: '- a\nb|\n- c' },
    { rule: 'on a ragged grid each child comes up by its own indent and keeps its own lines', precedent: 'EtherPK', before: '- a|\n      - b\n    - c\n      soft', key: 'bullet', after: 'a|\n- b\n- c\n  soft' },
    { rule: 'a form-1 bullet at column 0 becomes a prose code block', precedent: 'EtherPK', before: '- |```py\n  code\n  ```', key: 'bullet', after: '|```py\ncode\n```' },
    { rule: 'a top-level bullet whose text is a fence is refused where at the margin it would pair with another fence', precedent: 'EtherPK', before: '- ```py|\ntext\n```\ncode\n```', key: 'bullet', after: '- ```py|\ntext\n```\ncode\n```' },
    { rule: '…a task’s too, whose text is no fence until its marker goes', precedent: 'EtherPK', before: '- [ ] ```py|\ntext\n```\ncode\n```', key: 'bullet', after: '- [ ] ```py|\ntext\n```\ncode\n```' },
    { rule: '…and where it would close an open prose fence above, making the prose between them code', precedent: 'EtherPK', before: '```js\ntext\n- ```|', key: 'bullet', after: '```js\ntext\n- ```|' },
    { rule: 'a top-level bullet whose own code block would close an open prose fence above at the margin is refused', precedent: 'EtherPK', before: '```js\ntext\n- a|\n  ```\n  code\n  ```', key: 'bullet', after: '```js\ntext\n- a|\n  ```\n  code\n  ```' },
    { rule: 'a top-level `- ---` is refused where at the margin it would close a frontmatter block', precedent: 'EtherPK', before: '---\ntitle: x\n- ---|\nbody', key: 'bullet', after: '---\ntitle: x\n- ---|\nbody' },
    { rule: '…and at the top of the document, where it would open one', precedent: 'EtherPK', before: '- ---|\n\ntext\n\n---\nmore', key: 'bullet', after: '- ---|\n\ntext\n\n---\nmore' },
    { rule: 'a `- ---` under a closed frontmatter block toggles: at the margin it is a rule in the body', precedent: 'EtherPK', before: '---\ntitle: x\n---\n- ---|', key: 'bullet', after: '---\ntitle: x\n---\n---|' },
    { rule: 'two taps put a prose line back as it was', precedent: 'EtherPK', before: 'te|xt', key: 'bullet bullet', after: 'te|xt' },
    { rule: 'two taps put a top-level bullet back as it was', precedent: 'EtherPK', before: '- te|xt', key: 'bullet bullet', after: '- te|xt' },
    { rule: 'a nested bullet is refused: as prose it would split its tree', precedent: 'EtherPK', before: '- a\n  - b|', key: 'bullet', after: '- a\n  - b|' },
    { rule: 'a nested task is refused too', precedent: 'EtherPK', before: '- a\n  - [ ] b|', key: 'bullet', after: '- a\n  - [ ] b|' },
    { rule: 'an indented bullet with no parent is refused: only a bullet at column 0 becomes prose', precedent: 'EtherPK', before: '- a\n\n  - b|', key: 'bullet', after: '- a\n\n  - b|' },
    { rule: 'a nested form-1 bullet is refused', precedent: 'EtherPK', before: '- a\n  - |```py\n    code\n    ```', key: 'bullet', after: '- a\n  - |```py\n    code\n    ```' },
    { rule: 'a heading is refused', precedent: 'EtherPK', before: '# h|', key: 'bullet', after: '# h|' },
    { rule: 'a line of a prose fence is code: refused', precedent: 'EtherPK', before: '```\nco|de\n```', key: 'bullet', after: '```\nco|de\n```' },
    { rule: 'a bullet-shaped line inside a fence is code: refused', precedent: 'EtherPK', before: '- ```md\n  - |x\n  ```', key: 'bullet', after: '- ```md\n  - |x\n  ```' },
    { rule: '…in a code sample that holds its own fenced block too', precedent: 'EtherPK', before: '```md\n- a|\n- b\n  ```\n  x\n  ```\n```', key: 'bullet', after: '```md\n- a|\n- b\n  ```\n  x\n  ```\n```' },
    { rule: '…and so is a line of text there', precedent: 'EtherPK', before: '```md\nte|xt\n- b\n  ```\n  x\n  ```\n```', key: 'bullet', after: '```md\nte|xt\n- b\n  ```\n  x\n  ```\n```' },
    { rule: 'an unterminated fence line is refused: as a bullet it would take the next fence for its closer', precedent: 'EtherPK', before: '```py|\n- b\n  ```\n  code\n  ```', key: 'bullet', after: '```py|\n- b\n  ```\n  code\n  ```' },
    { rule: 'a frontmatter line is refused', precedent: 'EtherPK', before: '---\ntitle: x|\n---\nbody', key: 'bullet', after: '---\ntitle: x|\n---\nbody' },
    { rule: 'a YAML list entry in the frontmatter is metadata: refused', precedent: 'EtherPK', before: '---\ntags:\n  - fo|o\n---', key: 'bullet', after: '---\ntags:\n  - fo|o\n---' },
    { rule: 'a range across one top-level block’s lines toggles that block, as Tab nests it', precedent: 'Logseq', before: '- «a\n  so»ft', key: 'bullet', after: '«a\nso»ft' },
    { rule: '…and is refused for a nested block', precedent: 'EtherPK', before: '- a\n  - «b\n    so»ft', key: 'bullet', after: '- a\n  - «b\n    so»ft' },
    { rule: 'a range inside a top-level bullet’s own code toggles the bullet, as Mod+Shift+Enter cycles it (the Tab key indents the code there)', precedent: 'EtherPK', before: '- x\n  ```\n  «a\n  b»\n  ```', key: 'bullet', after: 'x\n```\n«a\nb»\n```' },
    { rule: 'a selection across blocks is refused: the caret is hidden, and one block made prose would split the rest from their group', precedent: 'EtherPK', before: '«- a\n- b»', key: 'bullet', after: '«- a\n- b»' },
    { rule: 'a prose range across lines acts on the line its head is on, as the task toggle does', precedent: 'EtherPK', before: '«one\ntw»o', key: 'bullet', after: 'one\n- tw|o' },
])

// A table row cannot stand alone, because as a bullet it would leave the table without its header or
// its separator. Only the bullet line a table opens on toggles, and the table travels with it.
bulletButtonTable('the Command Bar bullet toggle in a table', [
    { rule: 'a row of a prose table is refused', precedent: 'EtherPK', before: '| a | b |\n| --- | --- |\n| 1¦ | 2 |', key: 'bullet', after: '| a | b |\n| --- | --- |\n| 1¦ | 2 |' },
    { rule: 'its header row too', precedent: 'EtherPK', before: '| a¦ | b |\n| --- | --- |\n| 1 | 2 |', key: 'bullet', after: '| a¦ | b |\n| --- | --- |\n| 1 | 2 |' },
    { rule: 'a table that is a top-level bullet’s content becomes a prose table', precedent: 'EtherPK', before: '- | a¦ | b |\n  | --- | --- |\n  | 1 | 2 |', key: 'bullet', after: '| a¦ | b |\n| --- | --- |\n| 1 | 2 |' },
    { rule: 'a body row of a bullet’s table is refused', precedent: 'EtherPK', before: '- | a | b |\n  | --- | --- |\n  | 1¦ | 2 |', key: 'bullet', after: '- | a | b |\n  | --- | --- |\n  | 1¦ | 2 |' },
    { rule: 'a row of a table on a bullet’s continuation lines is refused', precedent: 'EtherPK', before: '- notes\n  | a | b |\n  | --- | --- |\n  | 1¦ | 2 |', key: 'bullet', after: '- notes\n  | a | b |\n  | --- | --- |\n  | 1¦ | 2 |' },
], { caret: '¦' })

// ── Editor Content Rules → Fenced Code Blocks ─────────────────────────────────────────────────

table('fence creation and completion (ADR 0018)', [
    { rule: 'Enter at the end of an opener completes a balanced block, caret on the middle line', precedent: 'Obsidian', before: '```|', key: 'Enter', after: '```\n|\n```' },
    { rule: 'inside a bullet the fence is clamped to the content column', precedent: 'EtherPK', before: '- ```|', key: 'Enter', after: '- ```\n  |\n  ```' },
    { rule: 'a four-backtick opener gets a four-backtick closer', precedent: 'CommonMark', before: '````|', key: 'Enter', after: '````\n|\n````' },
    { rule: 'an info-string is kept on the opener', precedent: 'Obsidian', before: '```js|', key: 'Enter', after: '```js\n|\n```' },
    { rule: 'Enter inside an opener’s backticks acts as Enter at its end, never splitting the fence', precedent: 'EtherPK', before: '- ``|`\n  x\n  ```', key: 'Enter', after: '- ```\n  |\n  x\n  ```' },
    { rule: 'Enter on a real closer never generates another pair', precedent: 'EtherPK', before: '```\nx\n```|', key: 'Enter', after: '```\nx\n```\n|' },
    { rule: 'Enter at the end of the opener of a block holding content opens its first content line, never a second closer', precedent: 'EtherPK', before: '```|\nx\n```', key: 'Enter', after: '```\n|\nx\n```' },
    { rule: 'an info-string opener with content below is complete too', precedent: 'EtherPK', before: '```js|\nx\n```', key: 'Enter', after: '```js\n|\nx\n```' },
    { rule: 'a four-backtick opener with content below is complete too', precedent: 'EtherPK', before: '````|\nx\n````', key: 'Enter', after: '````\n|\nx\n````' },
    { rule: 'inside a bullet, the opener of a block holding content is complete too', precedent: 'EtherPK', before: '- ```|\n  x\n  ```', key: 'Enter', after: '- ```\n  |\n  x\n  ```' },
    { rule: 'Enter on the opener of an already-completed empty block adds a code line, not a third fence', precedent: 'EtherPK', before: '```|\n\n```', key: 'Enter', after: '```\n|\n\n```' },
    { rule: 'a new opener above an existing bare block completes on its own; the block below keeps its fences', precedent: 'EtherPK', before: '```|\n\n```\nx\n```', key: 'Enter', after: '```\n|\n```\n\n```\nx\n```' },
    { rule: 'a new info-string opener above an existing bare block completes on its own too', precedent: 'EtherPK', before: '```js|\n\n```\nx\n```', key: 'Enter', after: '```js\n|\n```\n\n```\nx\n```' },
    { rule: 'a new bullet opener above a sibling’s block completes on its own', precedent: 'EtherPK', before: '- ```|\n- ```\n  x\n  ```', key: 'Enter', after: '- ```\n  |\n  ```\n- ```\n  x\n  ```' },
    { rule: 'a stray unterminated fence above never makes a complete block’s opener look fresh', precedent: 'EtherPK', before: '```\np\n```js|\nx\n```', key: 'Enter', after: '```\np\n```js\n|\nx\n```' },
    { rule: 'a shorter fence line inside a longer block is content: Enter is the in-block newline', precedent: 'CommonMark', before: '````\n```|\nx\n````', key: 'Enter', after: '````\n```\n|\nx\n````' },
    { rule: 'a longer fence never closes a shorter opener: the opener above a ```` block still completes on its own', precedent: 'EtherPK', before: '```|\n````\nx\n````', key: 'Enter', after: '```\n|\n```\n````\nx\n````' },
    { rule: 'Enter on the opener of a ``` block followed by a ```` block opens its first content line, never a second closer', precedent: 'EtherPK', before: '```|\nx\n```\n\n````\ny\n````', key: 'Enter', after: '```\n|\nx\n```\n\n````\ny\n````' },
])

table('keys inside a block', [
    { rule: 'Enter in content is a newline clamped to the fence column', precedent: 'EtherPK', before: '- ```\n  foo|\n  ```', key: 'Enter', after: '- ```\n  foo\n  |\n  ```' },
    { rule: 'Enter on an empty last row stays in the block: only Mod+Enter leaves', precedent: 'Obsidian', before: '```\nfoo\n|\n```', key: 'Enter', after: '```\nfoo\n\n|\n```' },
    { rule: 'Enter at the clamp of the last code line adds a line above it, still inside', precedent: 'Obsidian', before: '- ```\n  foo\n  |bar\n  ```', key: 'Enter', after: '- ```\n  foo\n  \n  |bar\n  ```' },
    { rule: 'Enter on the empty row of a fresh block keeps adding rows', precedent: 'EtherPK', before: '```\n|\n```', key: 'Enter', after: '```\n\n|\n```' },
    { rule: 'Enter at the end of the closer opens a prose line below', precedent: 'EtherPK', before: '```\nfoo\n```|', key: 'Enter', after: '```\nfoo\n```\n|' },
    { rule: 'a prose block below a bullet is nobody’s: Enter after its closer is a prose line, not a copied bullet', precedent: 'EtherPK', before: '- x\n\np\n```\nfoo\n```|', key: 'Enter', after: '- x\n\np\n```\nfoo\n```\n|' },
    { rule: '…nor a copied task checkbox, however far above the task stands', precedent: 'EtherPK', before: '- \n  - [ ] t\n\np\n```\n\n```|', key: 'Enter', after: '- \n  - [ ] t\n\np\n```\n\n```\n|' },
    { rule: 'a deeper bullet above a form-2 fence is skipped; the fence’s own bullet is the owner', precedent: 'EtherPK', before: '- x\n  - y\n  ```\n  foo\n  ```|', key: 'Enter', after: '- x\n  - y\n  ```\n  foo\n  ```\n- |' },
    { rule: 'a nested bullet’s closer opens a sibling at the same depth', precedent: 'EtherPK', before: '- x\n  - ```\n    foo\n    ```|', key: 'Enter', after: '- x\n  - ```\n    foo\n    ```\n  - |' },
    { rule: 'Enter at the end of a bullet’s closer opens a sibling bullet', precedent: 'EtherPK', before: '- ```\n  foo\n  ```|', key: 'Enter', after: '- ```\n  foo\n  ```\n- |' },
    { rule: 'Shift+Enter is the continuation clamped to the fence column', precedent: 'EtherPK', before: '- ```\n  foo|\n  ```', key: 'Shift-Enter', after: '- ```\n  foo\n  |\n  ```' },
    { rule: 'Shift+Enter after the closer is a soft line of the same bullet', precedent: 'EtherPK', before: '- ```\n  foo\n  ```|', key: 'Shift-Enter', after: '- ```\n  foo\n  ```\n  |' },
    { rule: 'Tab is code indentation', precedent: 'VS Code', before: '```\nfoo|\n```', key: 'Tab', after: '```\nfoo  |\n```' },
    { rule: 'Tab in the middle of a code line inserts the indent at the caret', precedent: 'VS Code', before: '```\nfo|o\n```', key: 'Tab', after: '```\nfo  |o\n```' },
    { rule: 'Tab on a fence line indents the whole block, keeping it paired', precedent: 'EtherPK', before: '|```\nfoo\n```', key: 'Tab', after: '  |```\n  foo\n  ```' },
    { rule: 'Shift+Tab on a fence line outdents the whole block, not past its owner’s content column', precedent: 'EtherPK', before: '- a\n    ```|\n    foo\n    ```', key: 'Shift-Tab', after: '- a\n  ```|\n  foo\n  ```' },
    { rule: 'Shift+Tab on a form-1 fence line outdents the bullet branch', precedent: 'EtherPK', before: '- a\n  - ```|\n    foo\n    ```', key: 'Shift-Tab', after: '- a\n- ```|\n  foo\n  ```' },
    { rule: 'Shift+Tab removes code indentation down to the fence column', precedent: 'VS Code', before: '- ```\n    foo|\n  ```', key: 'Shift-Tab', after: '- ```\n  foo|\n  ```' },
    { rule: 'Shift+Tab never crosses left of the fence column', precedent: 'EtherPK', before: '- ```\n  foo|\n  ```', key: 'Shift-Tab', after: '- ```\n  foo|\n  ```' },
    // A fence line of a bullet's block is the bullet's structure: a block never indents on its own, so
    // Tab and Shift+Tab there act on the owning branch, fence and all (Logseq: the block is the unit).
    { rule: 'Tab on a form-2 fence line nests the owning bullet’s branch, fence and all: a block never indents on its own', precedent: 'Logseq', before: '- z\n- a\n  ```|\n  x\n  ```', key: 'Tab', after: '- z\n  - a\n    ```|\n    x\n    ```' },
    { rule: 'Tab on a closer line is the same branch move', precedent: 'Logseq', before: '- z\n- a\n  ```\n  x\n  ```|', key: 'Tab', after: '- z\n  - a\n    ```\n    x\n    ```|' },
    { rule: 'Tab on a form-2 fence line is refused when the owner has no previous sibling', precedent: 'Logseq', before: '- a\n  ```|\n  x\n  ```', key: 'Tab', after: '- a\n  ```|\n  x\n  ```' },
    { rule: 'Tab on a form-1 opener nests the branch, children included', precedent: 'Logseq', before: '- z\n- ```|\n  x\n  ```\n  - child', key: 'Tab', after: '- z\n  - ```|\n    x\n    ```\n    - child' },
    { rule: 'Shift+Tab on a form-2 fence at its floor outdents the owning branch', precedent: 'Logseq', before: '- a\n  - b\n    ```|\n    x\n    ```', key: 'Shift-Tab', after: '- a\n- b\n  ```|\n  x\n  ```' },
    { rule: 'Shift+Tab on a form-2 fence at the floor of a top-level bullet makes the bullet prose, fence at column 0', precedent: 'EtherPK', before: '- a\n  ```|\n  x\n  ```', key: 'Shift-Tab', after: 'a\n```|\nx\n```' },
    { rule: 'Shift+Tab on the fence line of a prose block at column 0 changes nothing: the block moves only as a unit', precedent: 'EtherPK', before: '|```\n  foo\n```', key: 'Shift-Tab', after: '|```\n  foo\n```' },
    // Tab over selected code lines indents each of them, and never replaces the selection.
    { rule: 'Tab over selected code lines indents each, never replacing them', precedent: 'VS Code', before: '- a\n  ```\n  «x\n  y»\n  ```', key: 'Tab', after: '- a\n  ```\n    «x\n    y»\n  ```' },
    { rule: 'Shift+Tab over selected code lines outdents each, never left of the fence column', precedent: 'VS Code', before: '- a\n  ```\n    «x\n  y»\n  ```', key: 'Shift-Tab', after: '- a\n  ```\n  «x\n  y»\n  ```' },
    { rule: 'Tab over selected lines of a prose block indents each', precedent: 'VS Code', before: '```\n«x\ny»\n```', key: 'Tab', after: '```\n  «x\n  y»\n```' },
    { rule: 'a selection reaching a fence line of a bullet’s block is the bullet’s: Tab nests the branch', precedent: 'Logseq', before: '- z\n- a\n  «```\n  x»\n  ```', key: 'Tab', after: '- z\n  - a\n    «```\n    x»\n    ```' },
    { rule: 'a selection reaching the closer likewise', precedent: 'Logseq', before: '- z\n- a\n  ```\n  «x\n  ```»', key: 'Tab', after: '- z\n  - a\n    ```\n    «x\n    ```»' },
    { rule: 'a selection reaching a fence line of a prose block moves the block as a unit', precedent: 'EtherPK', before: '«```\nx»\n```', key: 'Tab', after: '  «```\n  x»\n  ```' },
    { rule: 'Shift+Tab on a form-1 block’s closer outdents the branch, as on its opener', precedent: 'Logseq', before: '- a\n  - ```\n    foo\n    ```|', key: 'Shift-Tab', after: '- a\n- ```\n  foo\n  ```|' },
    { rule: 'a selection ending at column 0 of the closer has not reached it: the selected lines indent', precedent: 'VS Code', before: '- z\n- a\n  ```\n  «x\n  y\n»  ```', key: 'Tab', after: '- z\n- a\n  ```\n    «x\n    y\n»  ```' },
    { rule: 'Shift+Tab with a selection reaching a top-level owner’s fence keeps the selection as the bullet becomes prose', precedent: 'EtherPK', before: '- a\n  «```\n  x»\n  ```', key: 'Shift-Tab', after: 'a\n«```\nx»\n```' },
    { rule: 'a block off the grid comes back to the owner’s content column, not to a shallower continuation', precedent: 'EtherPK', before: '- a\n  cont\n   ```|\n   y\n   ```', key: 'Shift-Tab', after: '- a\n  cont\n  ```|\n  y\n  ```' },
    // A drag from one block's code into another's is a block selection, snapped to both blocks whole (block-select.ts).
    { rule: 'a selection running from one block’s code into another’s selects both blocks, and both nest', precedent: 'Logseq', before: '- z\n«- a\n  ```\n  x\n  ```\n- b\n  ```\n  y\n  ```»', key: 'Tab', after: '- z\n«  - a\n    ```\n    x\n    ```\n  - b\n    ```\n    y\n    ```»' },
    { rule: 'a selection running from a block’s code up into prose is refused', precedent: 'EtherPK', before: 'pro«se\n- a\n  ```\n  x»\n  ```', key: 'Tab', after: 'pro«se\n- a\n  ```\n  x»\n  ```' },
    { rule: 'Backspace at the fence column merges the line up', precedent: 'EtherPK', before: '- ```\n  foo\n  |bar\n  ```', key: 'Backspace', after: '- ```\n  foo|bar\n  ```' },
    { rule: 'Backspace never merges content onto the opening fence', precedent: 'EtherPK', before: '```\n|foo\n```', key: 'Backspace', after: '```\n|foo\n```' },
    { rule: 'Backspace at the start of a closing fence is consumed', precedent: 'Logseq', before: '```\nfoo\n|```', key: 'Backspace', after: '```\nfoo\n|```' },
    { rule: 'Backspace at the content start of a form-1 fence bullet is consumed', precedent: 'Logseq', before: '- a\n- |```\n  foo\n  ```', key: 'Backspace', after: '- a\n- |```\n  foo\n  ```' },
    { rule: 'Delete at the end of a closing fence never pulls the next block into it', precedent: 'Logseq', before: '- ```\n  foo\n  ```|\n- b', key: 'Delete', after: '- ```\n  foo\n  ```|\n- b' },
    { rule: 'Delete at the end of the last code line never pulls the closer up', precedent: 'Logseq', before: '```\nfoo|\n```', key: 'Delete', after: '```\nfoo|\n```' },
    { rule: 'Delete at the end of the opener never pulls code onto the info string', precedent: 'Logseq', before: '```js|\nfoo\n```', key: 'Delete', after: '```js|\nfoo\n```' },
    { rule: 'Delete at the end of the line before an opener is consumed', precedent: 'Logseq', before: 'p|\n```\nx\n```', key: 'Delete', after: 'p|\n```\nx\n```' },
    // An indented prose block's opener clamps at column 0, so the caret can rest in its indent.
    { rule: 'Delete in the indent of a fence line is consumed, as Backspace there is: it would move that fence alone', precedent: 'EtherPK', before: '|  ```\n  x\n  ```', key: 'Delete', after: '|  ```\n  x\n  ```' },
    { rule: '…in the opener of a bullet’s block left deeper than its content column too', precedent: 'EtherPK', before: '- a\n  |  ```\n    x\n    ```', key: 'Delete', after: '- a\n  |  ```\n    x\n    ```' },
    { rule: '…and Delete over a selection of that indent', precedent: 'EtherPK', before: '- a\n  « » ```\n    x\n    ```', key: 'Delete', after: '- a\n  « » ```\n    x\n    ```' },
    { rule: '…and over a form-1 opener’s marker, whose fence it would move as well', precedent: 'EtherPK', before: '«- »```py\n  code\n  ```', key: 'Delete', after: '«- »```py\n  code\n  ```' },
    { rule: '…with Backspace too', precedent: 'EtherPK', before: '«- »```py\n  code\n  ```', key: 'Backspace', after: '«- »```py\n  code\n  ```' },
    // The word and line deletes, and a selection reaching past one line, are CodeMirror's own or the
    // range heal's, not the fence-edge keys above: the same rule holds for every delete (fence-guard.ts).
    { rule: 'Ctrl+Backspace at the clamp of a bullet’s block never deletes its fence’s indent', precedent: 'EtherPK', before: '- a\n  |```\n  x\n  ```\n- b', key: 'Mod-Backspace', after: '- a\n  |```\n  x\n  ```\n- b' },
    { rule: 'Ctrl+Delete at the end of a closer never joins the next line onto it', precedent: 'Logseq', before: '- a\n  ```\n  x\n  ```|\n- b', key: 'Mod-Delete', after: '- a\n  ```\n  x\n  ```|\n- b' },
    { rule: 'Ctrl+Delete at the end of the last code line never joins the closer up', precedent: 'Logseq', before: '```\nfoo|\n```', key: 'Mod-Delete', after: '```\nfoo|\n```' },
    { rule: 'Ctrl+Backspace inside an info string deletes the word, as in any text', precedent: 'VS Code', before: '```js|\nx\n```', key: 'Mod-Backspace', after: '```|\nx\n```' },
    { rule: 'Ctrl+Backspace after the backticks deletes them, as a block is dissolved on purpose', precedent: 'EtherPK', before: '```|\nx\n```', key: 'Mod-Backspace', after: '|\nx\n```' },
    { rule: 'a selection from the end of a line into the next line’s fence indent is refused', precedent: 'EtherPK', before: 'p«\n » ```\n  x\n  ```', key: 'Delete', after: 'p«\n » ```\n  x\n  ```' },
    { rule: '…with Backspace too', precedent: 'EtherPK', before: 'p«\n » ```\n  x\n  ```', key: 'Backspace', after: 'p«\n » ```\n  x\n  ```' },
    { rule: 'a selection from a code line into the closer’s indent is refused, the closer kept on its own line', precedent: 'EtherPK', before: '- a\n  ```\n  x«\n » ```', key: 'Delete', after: '- a\n  ```\n  x«\n » ```' },
    { rule: 'a selection taking a whole empty line above an opener deletes it', precedent: 'VS Code', before: 'p\n«\n»```\nx\n```', key: 'Delete', after: 'p\n|```\nx\n```' },
    { rule: 'a selection from a closer’s trailing space across its line break is refused: the next line would join it', precedent: 'EtherPK', before: '```\nx\n``` « \np»q', key: 'Delete', after: '```\nx\n``` « \np»q' },
    { rule: '…while a selection reaching the backticks deletes them, as a block is dissolved on purpose', precedent: 'EtherPK', before: '«  `»``\n  x\n  ```', key: 'Delete', after: '|``\n  x\n  ```' },
    { rule: 'Backspace at the start of the line after a closer is consumed', precedent: 'Logseq', before: '```\nx\n```\n|p', key: 'Backspace', after: '```\nx\n```\n|p' },
    { rule: 'an empty bullet after a closer deletes as a block, caret at the closer’s end', precedent: 'Logseq', before: '- a\n  - ```\n    x\n    ```\n- |\n- b', key: 'Backspace', after: '- a\n  - ```\n    x\n    ```|\n- b' },
    { rule: 'Shift+Enter inside a closer’s backticks opens the soft line after it', precedent: 'EtherPK', before: '- ```\n  x\n  ``|`', key: 'Shift-Enter', after: '- ```\n  x\n  ```\n  |' },
    { rule: 'Delete inside code joins code lines as usual', precedent: 'VS Code', before: '```\nfoo|\nbar\nbaz\n```', key: 'Delete', after: '```\nfoo|bar\nbaz\n```' },
    { rule: 'Backspace in extra code indent deletes one space', precedent: 'VS Code', before: '```\n   |foo\n```', key: 'Backspace', after: '```\n  |foo\n```' },
    { rule: 'Mod+Enter in a bullet’s block leaves it as a sibling bullet below', precedent: 'EtherPK', before: '- ```\n  foo|\n  ```', key: 'Mod-Enter', after: '- ```\n  foo\n  ```\n- |' },
    { rule: 'Mod+Enter in a nested bullet’s form-2 block keeps the sibling at that depth', precedent: 'EtherPK', before: '- a\n  - b\n    ```\n    foo|\n    ```\n- c', key: 'Mod-Enter', after: '- a\n  - b\n    ```\n    foo\n    ```\n  - |\n- c' },
    { rule: 'Mod+Enter in a prose block moves to an empty line already below the closer', precedent: 'EtherPK', before: '```\nfoo|\n```\n\nnext', key: 'Mod-Enter', after: '```\nfoo\n```\n|\nnext' },
    { rule: 'Mod+Enter in a prose block inserts a line when content follows the closer', precedent: 'EtherPK', before: '```\nfoo|\n```\nnext', key: 'Mod-Enter', after: '```\nfoo\n```\n|\nnext' },
    { rule: 'Mod+Enter in a prose block at the end of the document opens a new line', precedent: 'EtherPK', before: '```\nfoo|\n```', key: 'Mod-Enter', after: '```\nfoo\n```\n|' },
    // Code never soft-wraps and a long line is clipped (ADR 0094), so the visual-line boundary the
    // default End/Home find with posAtCoords is the clip edge, not the line's end. Inside a block they
    // are the logical ends: End is the end of the line, Home its first non-space character.
    { rule: 'End in code goes to the end of the line, not the visible edge', precedent: 'VS Code', before: '```\nfo|o bar\n```', key: 'End', after: '```\nfoo bar|\n```' },
    { rule: 'Home in code goes to the first non-space character (no second-press toggle to column 0: the clamp holds the caret at the fence column anyway)', precedent: 'VS Code', before: '- ```\n      foo b|ar\n  ```', key: 'Home', after: '- ```\n      |foo bar\n  ```' },
    { rule: 'Home on an unindented code line is the fence column', precedent: 'VS Code', before: '- ```\n  foo b|ar\n  ```', key: 'Home', after: '- ```\n  |foo bar\n  ```' },
    { rule: 'Shift+End in code selects to the end of the line', precedent: 'VS Code', before: '```\nfo|o bar\n```', key: 'Shift-End', after: '```\nfo«o bar»\n```' },
    { rule: 'Shift+Home in code selects back to the first non-space character', precedent: 'VS Code', before: '- ```\n    foo b|ar\n  ```', key: 'Shift-Home', after: '- ```\n    «foo b»ar\n  ```' },
    { rule: 'End on a fence line is the end of the fence', precedent: 'VS Code', before: '```|js\nfoo\n```', key: 'End', after: '```js|\nfoo\n```' },
])

// Another tool, or an agent, writes a bullet's code block with its blank lines empty: none of the
// fence column's spaces. A character typed there lands at the fence column, where Enter starts a
// new code line: left of it, the line would end the block and dissolve it into prose.
typedTable('typing inside a block', [
    { rule: 'a character typed on an empty line of a bullet’s block lands at the fence column', precedent: 'EtherPK', before: '- ```\n  foo\n|\n  bar\n  ```', key: 'x', after: '- ```\n  foo\n  x|\n  bar\n  ```' },
    { rule: '…at any depth', precedent: 'EtherPK', before: '- a\n  - ```\n    foo\n|\n    ```', key: 'x', after: '- a\n  - ```\n    foo\n    x|\n    ```' },
    { rule: '…and on a line of fewer spaces than the fence column', precedent: 'EtherPK', before: '- ```\n  foo\n |\n  ```', key: 'x', after: '- ```\n  foo\n  x|\n  ```' },
    { rule: 'a prose block’s empty line takes the character where it is typed', precedent: 'VS Code', before: '```\nfoo\n|\n```', key: 'x', after: '```\nfoo\nx|\n```' },
    { rule: 'inside nested blocks the character lands at the innermost block’s fence column', precedent: 'EtherPK', before: '- ```md\n  text\n    ```js\n|\n    ```\n  ```', key: 'x', after: '- ```md\n  text\n    ```js\n    x|\n    ```\n  ```' },
    // The re-clamp runs on the padded text: on the unpadded text the typed line had ended the block,
    // and its closer paired with the fence above instead and was dragged to that fence's column.
    { rule: 'an unterminated fence above never takes the block’s closer', precedent: 'EtherPK', before: '```\ntext\n- ```\n  foo\n|\n  bar\n  ```', key: 'x', after: '```\ntext\n- ```\n  foo\n  x|\n  bar\n  ```' },
    { rule: 'a bullet’s block inside a prose block keeps both blocks', precedent: 'EtherPK', before: '```\n- ```\n  foo\n|\n  ```\n```', key: 'x', after: '```\n- ```\n  foo\n  x|\n  ```\n```' },
])

// A code sample can hold a fenced block of its own (a markdown sample of a list with code in it). The
// whole sample is the outer block's code, inside the inner pair or not: no line of it is outline. The
// inner pair is still a block the keys edit in: its fences are structure and its column clamps.
table('a code sample that holds its own fenced block is code throughout', [
    { rule: 'Enter on a bullet-shaped line of it is a newline in code, not a sibling bullet', precedent: 'EtherPK', before: '```md\n- a|\n- b\n  ```\n  x\n  ```\n```', key: 'Enter', after: '```md\n- a\n|\n- b\n  ```\n  x\n  ```\n```' },
    { rule: 'Tab on one is code indentation, not nesting', precedent: 'VS Code', before: '```md\n- a\n- b|\n  ```\n  x\n  ```\n```', key: 'Tab', after: '```md\n- a\n- b  |\n  ```\n  x\n  ```\n```' },
    { rule: 'Shift+Tab on one never crosses left of the fence column, so it never leaves a list', precedent: 'EtherPK', before: '```md\n- a|\n- b\n  ```\n  x\n  ```\n```', key: 'Shift-Tab', after: '```md\n- a|\n- b\n  ```\n  x\n  ```\n```' },
    { rule: 'Mod+Shift+Enter on one is refused', precedent: 'EtherPK', before: '```md\n- a|\n- b\n  ```\n  x\n  ```\n```', key: 'Mod-Shift-Enter', after: '```md\n- a|\n- b\n  ```\n  x\n  ```\n```' },
    { rule: 'Enter on a line of the inner pair is a newline at that pair’s fence column', precedent: 'EtherPK', before: '```md\n- b\n  ```\n  x|\n  ```\n```', key: 'Enter', after: '```md\n- b\n  ```\n  x\n  |\n  ```\n```' },
    { rule: 'Enter on an inner fence line acts at its end, never splitting the fence', precedent: 'EtherPK', before: '```md\n- b\n  |```js\n  x\n  ```\n```', key: 'Enter', after: '```md\n- b\n  ```js\n  |\n  x\n  ```\n```' },
    { rule: '…inside its backticks too', precedent: 'EtherPK', before: '```md\n- b\n  ``|`js\n  x\n  ```\n```', key: 'Enter', after: '```md\n- b\n  ```js\n  |\n  x\n  ```\n```' },
    { rule: 'Enter on the inner closer opens a code line after it, never a bullet', precedent: 'EtherPK', before: '```md\n- b\n  ```\n  x\n  |```\n```', key: 'Enter', after: '```md\n- b\n  ```\n  x\n  ```\n  |\n```' },
    { rule: 'Shift+Enter inside the inner closer’s backticks adds the line after it', precedent: 'EtherPK', before: '```md\n- b\n  ```\n  x\n  `|``\n```', key: 'Shift-Enter', after: '```md\n- b\n  ```\n  x\n  ```\n  |\n```' },
    { rule: 'Backspace at the clamp of the inner opener is consumed', precedent: 'Logseq', before: '```md\n- b\n  |```js\n  x\n  ```\n```', key: 'Backspace', after: '```md\n- b\n  |```js\n  x\n  ```\n```' },
    { rule: '…and of the inner closer', precedent: 'Logseq', before: '```md\n- b\n  ```\n  x\n  |```\n```', key: 'Backspace', after: '```md\n- b\n  ```\n  x\n  |```\n```' },
    // Under a line of the sample that is not bullet-shaped, an inner opener clamps at the sample's
    // column, 0, so a caret can rest in its indent (a range delete above it leaves one there).
    // Deleting a space there would move that fence alone, and it would pair with some other fence.
    { rule: 'Delete in the indent of the inner opener is consumed', precedent: 'EtherPK', before: '```md\ntext\n|  ```js\n  x\n  ```\n```', key: 'Delete', after: '```md\ntext\n|  ```js\n  x\n  ```\n```' },
    { rule: '…and so is Delete or Backspace over a selection in it', precedent: 'EtherPK', before: '```md\ntext\n«  »```js\n  x\n  ```\n```', key: 'Delete', after: '```md\ntext\n«  »```js\n  x\n  ```\n```' },
    { rule: '…Backspace too', precedent: 'EtherPK', before: '```md\ntext\n« » ```js\n  x\n  ```\n```', key: 'Backspace', after: '```md\ntext\n« » ```js\n  x\n  ```\n```' },
    // An inner opener that stops being a fence leaves its closer two columns right of the sample's
    // opener. The source guard's repair of a closer nudged right must not take it for the sample's.
    { rule: 'Ctrl+Delete from column 0 of an inner opener never deletes its indent', precedent: 'EtherPK', before: '```md\ntext\n|  ```js\n  x\n  ```\n```', key: 'Mod-Delete', after: '```md\ntext\n|  ```js\n  x\n  ```\n```' },
    { rule: 'deleting a backtick of an inner opener never closes the sample at the inner closer', precedent: 'EtherPK', before: '```md\ntext\n  |```js\n  x\n  ```\n```', key: 'Delete', after: '```md\ntext\n  |``js\n  x\n  ```\n```' },
    { rule: 'Backspace at the clamp of an inner code line joins it up, as in any block', precedent: 'EtherPK', before: '```md\n- b\n  ```\n  x\n  |y\n  ```\n```', key: 'Backspace', after: '```md\n- b\n  ```\n  x|y\n  ```\n```' },
    { rule: 'Delete at the end of the last inner code line is consumed', precedent: 'Logseq', before: '```md\n- b\n  ```\n  x|\n  ```\n```', key: 'Delete', after: '```md\n- b\n  ```\n  x|\n  ```\n```' },
    { rule: 'Mod+Enter on a line of the sample leaves the whole sample', precedent: 'EtherPK', before: '```md\n- b|\n  ```\n  x\n  ```\n```', key: 'Mod-Enter', after: '```md\n- b\n  ```\n  x\n  ```\n```\n|' },
    { rule: '…from inside the inner pair too', precedent: 'EtherPK', before: '```md\n- b\n  ```\n  x|\n  ```\n```', key: 'Mod-Enter', after: '```md\n- b\n  ```\n  x\n  ```\n```\n|' },
    // The inner pair's fences are code lines of the sample: indenting one would re-pair the fences.
    { rule: 'Shift+Tab never outdents one of the inner pair’s fences into a closer of the sample', precedent: 'EtherPK', before: '```md\n- a\n  ```|\n  x\n  ```\n```', key: 'Shift-Tab', after: '```md\n- a\n  ```|\n  x\n  ```\n```' },
    { rule: 'Tab on one of the inner pair’s fences moves the pair as a unit', precedent: 'EtherPK', before: '```md\n- a\n  ```\n  x\n  |```\n```', key: 'Tab', after: '```md\n- a\n    ```\n    x\n    |```\n```' },
    { rule: 'Shift+Tab on the sample’s opener at column 0 changes nothing: the block moves only as a unit', precedent: 'EtherPK', before: '|```md\n- a\n  ```\n  x\n  ```\n```', key: 'Shift-Tab', after: '|```md\n- a\n  ```\n  x\n  ```\n```' },
    { rule: 'Tab over a range from a line of the sample into an inner fence is refused where it would move that fence alone', precedent: 'EtherPK', before: '```md\n«- b\n  ```js»\n  x\n  ```\n- c\n```', key: 'Tab', after: '```md\n«- b\n  ```js»\n  x\n  ```\n- c\n```' },
    { rule: 'Shift+Tab over a range from an inner closer onto a line of the sample is refused likewise', precedent: 'EtherPK', before: '```md\n- b\n    ```js\n    x\n    «```\n- c»\n```', key: 'Shift-Tab', after: '```md\n- b\n    ```js\n    x\n    «```\n- c»\n```' },
    { rule: 'in a four-backtick sample Shift+Tab never takes the inner pair to the outer fence’s column, where it would be text', precedent: 'EtherPK', before: '````md\n- a\n  ```|\n  x\n  ```\n````', key: 'Shift-Tab', after: '````md\n- a\n  ```|\n  x\n  ```\n````' },
    { rule: 'Backspace on an empty bullet-shaped line of it deletes a character, never the line and its subtree', precedent: 'VS Code', before: '````md\n- |\n  ```\n  ```\n````', key: 'Backspace', after: '````md\n-|\n  ```\n  ```\n````' },
    { rule: 'Alt+Down never carries a line of the sample across an inner fence', precedent: 'EtherPK', before: '```md\n- re|\n  ```\n  kzzp\n  ```\n```', key: 'Alt-ArrowDown', after: '```md\n- re|\n  ```\n  kzzp\n  ```\n```' },
    { rule: '…nor over an inner opener with an info string', precedent: 'EtherPK', before: '```md\n- b|\n  ```js\n  x\n  ```\n- c\n```', key: 'Alt-ArrowDown', after: '```md\n- b|\n  ```js\n  x\n  ```\n- c\n```' },
    { rule: 'Alt+Up never carries one up across an inner closer', precedent: 'EtherPK', before: '```md\n- b\n  ```\n  x\n  ```\n- c|\n```', key: 'Alt-ArrowUp', after: '```md\n- b\n  ```\n  x\n  ```\n- c|\n```' },
    { rule: 'Alt+Up over a range never carries lines of the sample above its opener', precedent: 'EtherPK', before: '```md\n«- a\n  ```\n  a\n  # c»\n  ```\n```', key: 'Alt-ArrowUp', after: '```md\n«- a\n  ```\n  a\n  # c»\n  ```\n```' },
    { rule: '…nor carries an inner fence without its partner', precedent: 'EtherPK', before: '```md\n- a\n«  ```\n  x»\n  y\n  ```\n```', key: 'Alt-ArrowDown', after: '```md\n- a\n«  ```\n  x»\n  y\n  ```\n```' },
    { rule: 'in a sample under a bullet, Tab on an inner fence moves the inner pair, never the bullet', precedent: 'EtherPK', before: '- p\n- a\n  ```md\n  text\n    ```js|\n    x\n    ```\n  ```', key: 'Tab', after: '- p\n- a\n  ```md\n  text\n      ```js|\n      x\n      ```\n  ```' },
    { rule: '…Alt+Up on one moves nothing', precedent: 'EtherPK', before: '- p\n- a\n  ```md\n  text\n    ```js|\n    x\n    ```\n  ```', key: 'Alt-ArrowUp', after: '- p\n- a\n  ```md\n  text\n    ```js|\n    x\n    ```\n  ```' },
    { rule: '…and Shift+Tab over a range across an inner fence never makes the bullet prose', precedent: 'EtherPK', before: '- a\n  ```md\n  «text\n    ```js\n    x»\n    ```\n  ```', key: 'Shift-Tab', after: '- a\n  ```md\n  «text\n    ```js\n    x»\n    ```\n  ```' },
])

// Typing over a selection from prose over a bullet's marker replaces it as Delete would, and heals the same.
typedTable('typing over a selection from prose into a bullet', [
    { rule: 'the bullet’s children come up a level', precedent: 'EtherPK', before: 'pro«se\n- »a\n  - b', key: 'x', after: 'prox|a\n- b' },
    { rule: '…the caret after the typed text, a list nested under prose above kept', precedent: 'EtherPK', before: 'Todo:\n  - t\npro«se\n- »a\n  - b', key: 'x', after: 'Todo:\n  - t\nprox|a\n- b' },
    { rule: 'typing over a selection across indented prose keeps the indent and the caret', precedent: 'VS Code', before: '  a«b\n  c»d\n  e', key: 'x', after: '  ax|d\n  e' },
])

// A fence takes a one-word info string, so a second word typed after it makes the line text, and the
// inner closer, two columns right of the sample's opener, looked to the source guard like that opener's
// closer nudged right.
typedTable('typing on an inner opener of a code sample', [
    { rule: 'a second word after its info string never closes the sample at the inner closer', precedent: 'EtherPK', before: '```md\ntext\n  ```js |\n  x\n  ```\n```', key: 't', after: '```md\ntext\n  ```js t|\n  x\n  ```\n```' },
])

table('keys on an empty code line written without the fence column’s spaces', [
    // The caret clamp ran before the guard padded the joined line, on text where it was not code
    // yet; the pad carries the caret onto the fence column with it.
    { rule: 'Backspace joining a line into the empty line above leaves the caret on the fence column', precedent: 'EtherPK', before: '- ```\n  foo\n\n  |bar\n  ```', key: 'Backspace', after: '- ```\n  foo\n  |bar\n  ```' },
    { rule: 'Delete from the empty line joins the line below the same way', precedent: 'EtherPK', before: '- ```\n  foo\n|\n  bar\n  ```', key: 'Delete', after: '- ```\n  foo\n  |bar\n  ```' },
    // The pad runs before the caret clamp, so the clamp judges the joined line as code: unpadded, a
    // `- x` there is a bullet, and its clamp put the caret after the `- `.
    { rule: '…when the joined code looks like a bullet too', precedent: 'EtherPK', before: '- ```\n  foo\n\n  |- x\n  ```', key: 'Backspace', after: '- ```\n  foo\n  |- x\n  ```' },
    { rule: '…or like a task', precedent: 'EtherPK', before: '- ```\n  foo\n\n  |- [ ] x\n  ```', key: 'Backspace', after: '- ```\n  foo\n  |- [ ] x\n  ```' },
    // The line is drawn from the fence column, so the caret on it already sits at the code's start:
    // Tab indents the code from there, as it would on the padded line, and never presses dead.
    { rule: 'Tab on the empty line indents the code one level, as on a padded line', precedent: 'EtherPK', before: '- ```\n  foo\n|\n  ```', key: 'Tab', after: '- ```\n  foo\n    |\n  ```' },
    { rule: '…in a nested block too, whatever the line holds short of the column', precedent: 'EtherPK', before: '- a\n  - ```\n    foo\n  |\n    ```', key: 'Tab', after: '- a\n  - ```\n    foo\n      |\n    ```' },
    { rule: '…and from its start, where the text is empty', precedent: 'EtherPK', before: '- a\n  - ```\n    foo\n|\n    ```', key: 'Tab', after: '- a\n  - ```\n    foo\n      |\n    ```' },
])

// Rows the typed table cannot hold: its key splits on spaces, and undo is a second step.
describe('typing inside a block: a space, and undo', () => {
    it('a space typed on an empty line leaves it blank, so it stays as typed (EtherPK)', () => {
        const editor = editorFixture('- ```\n  foo\n|\n  ```')
        editor.type(' ')
        expect(editor.fixture()).toBe('- ```\n  foo\n |\n  ```')
    })

    it('one undo takes back the character and the padding together (EtherPK)', () => {
        const editor = editorFixture('- ```\n  foo\n|\n  ```')
        editor.type('x')
        editor.key('Mod-z')
        expect(editor.fixture()).toBe('- ```\n  foo\n|\n  ```')
    })

    it('leaves an IME composition where it was typed: a change beside the composed text can break it (EtherPK)', () => {
        const editor = editorFixture('- ```\n  foo\n|\n  ```')
        editor.dispatch(editor.state.update({ ...editor.state.replaceSelection('x'), userEvent: 'input.type.compose' }))
        expect(editor.text()).toBe('- ```\n  foo\nx\n  ```')
    })

    it('…whole: nothing re-clamps the unpadded text, where the dissolved block’s closer would pair with a fence above (EtherPK)', () => {
        const editor = editorFixture('```\ntext\n- ```\n  foo\n|\n  bar\n  ```')
        editor.dispatch(editor.state.update({ ...editor.state.replaceSelection('x'), userEvent: 'input.type.compose' }))
        expect(editor.text()).toBe('```\ntext\n- ```\n  foo\nx\n  bar\n  ```')
    })

    it('pads this user’s own typing in a shared graph (EtherPK)', () => {
        const editor = editorFixture('- ```\n  foo\n|\n  ```', { extensions: [collaborative.of(true)] })
        editor.type('x')
        expect(editor.text()).toBe('- ```\n  foo\n  x\n  ```')
    })

    it('leaves another member’s change alone in a shared graph, where a correction would never reach the shared text (EtherPK)', () => {
        // A remote member's change, or the shared undo manager's, arrives with no user event.
        const editor = editorFixture('- ```\n  foo\n|\n  ```', { extensions: [collaborative.of(true)] })
        const at = editor.head()
        editor.dispatch(editor.state.update({ changes: { from: at, insert: 'x' } }))
        expect(editor.text()).toBe('- ```\n  foo\nx\n  ```')
    })
})

table('Frontmatter keeps its edges', [
    // Joining body text onto the closing delimiter would make it not a delimiter, and the whole
    // block would then be body text - the title line included. Obsidian lets the delimiters be
    // deleted and Logseq has no such block, so the rule is our own.
    {
        rule: 'Backspace at the start of the first body line is refused: body text never joins onto the closing delimiter',
        precedent: 'EtherPK',
        before: '---\ntitle: K\n---\n|body',
        key: 'Backspace',
        after: '---\ntitle: K\n---\n|body',
    },
    {
        rule: 'Delete at the end of the closing delimiter is refused: the same join from above',
        precedent: 'EtherPK',
        before: '---\ntitle: K\n---|\nbody',
        key: 'Delete',
        after: '---\ntitle: K\n---|\nbody',
    },
    {
        rule: 'a selection spanning the seam is not deleted',
        precedent: 'EtherPK',
        before: '---\ntitle: «K\n---\nbo»dy',
        key: 'Backspace',
        after: '---\ntitle: «K\n---\nbo»dy',
    },
    {
        rule: 'removing the terminator after the block when nothing follows it is a plain edit',
        precedent: 'EtherPK',
        before: '---\ntitle: K\n---\n|',
        key: 'Backspace',
        after: '---\ntitle: K\n---|',
    },
    {
        rule: 'deleting the closing delimiter line above a rule in the body is refused: the block may not swallow body text',
        precedent: 'EtherPK',
        before: '---\ntitle: K\n«---\n»body\n---\nmore',
        key: 'Backspace',
        after: '---\ntitle: K\n«---\n»body\n---\nmore',
    },
    // The block's own edges: a delimiter joined to the line beside it inside the block is no longer a
    // delimiter either, and the block dissolves the same way.
    {
        rule: 'Backspace at the start of the first key is refused: the first line never joins onto the opening delimiter',
        precedent: 'EtherPK',
        before: '---\n|title: K\n---\nbody',
        key: 'Backspace',
        after: '---\n|title: K\n---\nbody',
    },
    {
        rule: 'Delete at the end of the opening delimiter is refused: the same join from above',
        precedent: 'EtherPK',
        before: '---|\ntitle: K\n---\nbody',
        key: 'Delete',
        after: '---|\ntitle: K\n---\nbody',
    },
    {
        rule: 'Backspace at the start of the closing delimiter is refused: it never joins onto the last key',
        precedent: 'EtherPK',
        before: '---\ntitle: K\n|---\nbody',
        key: 'Backspace',
        after: '---\ntitle: K\n|---\nbody',
    },
    {
        rule: 'Delete at the end of the last key is refused: the same join from above',
        precedent: 'EtherPK',
        before: '---\ntitle: K|\n---\nbody',
        key: 'Delete',
        after: '---\ntitle: K|\n---\nbody',
    },
    {
        rule: 'Backspace over the closing line, taken with the line break before it, is refused: the block would dissolve as by a join',
        precedent: 'EtherPK',
        before: '---\ntitle: K«\n---»\nbody',
        key: 'Backspace',
        after: '---\ntitle: K«\n---»\nbody',
    },
    {
        rule: 'Delete over the closing line, taken with the line break after it, is refused the same way',
        precedent: 'EtherPK',
        before: '---\ntitle: K\n«---\n»body',
        key: 'Delete',
        after: '---\ntitle: K\n«---\n»body',
    },
    {
        rule: 'a selection from inside the last key through the closing line is refused, deleted or typed over',
        precedent: 'EtherPK',
        before: '---\ntitle: K«anban\n---»\nbody',
        key: 'Backspace',
        after: '---\ntitle: K«anban\n---»\nbody',
    },
    {
        rule: 'Delete over that selection is refused the same way',
        precedent: 'EtherPK',
        before: '---\ntitle: K«anban\n---»\nbody',
        key: 'Delete',
        after: '---\ntitle: K«anban\n---»\nbody',
    },
    {
        rule: 'on a page with no body the closing line is kept too, though its line break ends the document',
        precedent: 'EtherPK',
        before: '---\ntitle: K«\n---»\n',
        key: 'Backspace',
        after: '---\ntitle: K«\n---»\n',
    },
    {
        rule: 'and the closing line with the line break after it, on that page',
        precedent: 'EtherPK',
        before: '---\ntitle: K\n«---\n»',
        key: 'Delete',
        after: '---\ntitle: K\n«---\n»',
    },
    {
        rule: 'a delimiter’s own dashes can still be deleted, the way to dissolve the block on purpose',
        precedent: 'EtherPK',
        before: '---\ntitle: K\n---|\nbody',
        key: 'Backspace',
        after: '---\ntitle: K\n--|\nbody',
    },
])

// Select all selects the region the caret is in, the body or the frontmatter's lines, and never
// crosses into the other: typing over a whole-document selection took the title with the body.
// Neither Obsidian (whose Properties are a separate panel) nor Logseq (no such block) has the
// case, so the rule is our own. With no block the key is CodeMirror's own select-all.
table('Select all keeps to the body or the frontmatter', [
    { rule: 'in the body it selects the body, from its first line to the end', precedent: 'EtherPK', before: '---\ntitle: K\n---\n- a|\n- b', key: 'Mod-a', after: '---\ntitle: K\n---\n«- a\n- b»' },
    { rule: 'prose in the body the same', precedent: 'EtherPK', before: '---\ntitle: K\n---\nsome |text\nmore', key: 'Mod-a', after: '---\ntitle: K\n---\n«some text\nmore»' },
    { rule: 'in the frontmatter it selects the lines between the delimiters', precedent: 'EtherPK', before: '---\nti|tle: K\ntags: x\n---\n- a', key: 'Mod-a', after: '---\n«title: K\ntags: x»\n---\n- a' },
    { rule: 'on the opening delimiter too', precedent: 'EtherPK', before: '---|\ntitle: K\n---\n- a', key: 'Mod-a', after: '---\n«title: K»\n---\n- a' },
    { rule: 'on the closing delimiter too', precedent: 'EtherPK', before: '---\ntitle: K\n---|\n- a', key: 'Mod-a', after: '---\n«title: K»\n---\n- a' },
    { rule: 'pressed again it does not widen into the other region', precedent: 'EtherPK', before: '---\ntitle: K\n---\n«- a\n- b»', key: 'Mod-a', after: '---\ntitle: K\n---\n«- a\n- b»' },
    { rule: 'a selection across the seam selects the region its head is in', precedent: 'EtherPK', before: '---\ntitle: «K\n---\n- a\n- b»', key: 'Mod-a', after: '---\ntitle: K\n---\n«- a\n- b»' },
    { rule: 'a body of one bullet and no line after it selects its text, as any selection within a bullet line does', precedent: 'EtherPK', before: '---\ntitle: K\n---\n- a|', key: 'Mod-a', after: '---\ntitle: K\n---\n- «a»' },
    { rule: 'a body of one bullet ending in a line break selects the whole block, as a selection across lines does', precedent: 'EtherPK', before: '---\ntitle: K\n---\n- a|\n', key: 'Mod-a', after: '---\ntitle: K\n---\n«- a\n»' },
    { rule: 'a document with no frontmatter is selected whole', precedent: 'VS Code', before: '- a|\n- b', key: 'Mod-a', after: '«- a\n- b»' },
    { rule: 'an empty frontmatter block has nothing to select: the caret stays', precedent: 'EtherPK', before: '---|\n---\n- a', key: 'Mod-a', after: '---|\n---\n- a' },
    { rule: 'an empty body has nothing to select: the caret stays', precedent: 'EtherPK', before: '---\ntitle: K\n---\n|', key: 'Mod-a', after: '---\ntitle: K\n---\n|' },
])

// Select all is for what comes next: an edit over what it selects must change that region and
// leave the other whole, the block's delimiters included.
describe('an edit over what Select all selects changes that region alone', () => {
    function afterSelectAll(before: string, act: (editor: ReturnType<typeof editorFixture>) => void): string {
        const editor = editorFixture(before)
        editor.key('Mod-a')
        act(editor)
        return editor.fixture()
    }
    for (const body of ['- a|\n- b', '- a|\n- b\n', 'some |text\nmore\n']) {
        const before = `---\ntitle: K\n---\n${body}`
        it(`Backspace empties the body and keeps the block (${JSON.stringify(body)})`, () => {
            expect(afterSelectAll(before, (e) => e.key('Backspace'))).toBe('---\ntitle: K\n---\n|')
        })
        it(`Delete does the same (${JSON.stringify(body)})`, () => {
            expect(afterSelectAll(before, (e) => e.key('Delete'))).toBe('---\ntitle: K\n---\n|')
        })
        it(`a cut, then typing, writes below the block (${JSON.stringify(body)})`, () => {
            expect(afterSelectAll(before, (e) => (e.cut(), e.type('N')))).toBe('---\ntitle: K\n---\nN|')
        })
        it(`typing replaces the body (${JSON.stringify(body)})`, () => {
            // An outline body selected whole is a block selection: one block takes its place (Editor
            // Content Rules → Selection). A prose body is replaced as typed.
            const typed = body.startsWith('- ') ? '- N|' : 'N|'
            expect(afterSelectAll(before, (e) => e.type('N'))).toBe(`---\ntitle: K\n---\n${typed}`)
        })
    }
    it('Backspace in the block empties its lines and keeps both delimiters and the body', () => {
        expect(afterSelectAll('---\nti|tle: K\ntags: x\n---\n- a', (e) => e.key('Backspace'))).toBe('---\n|\n---\n- a')
    })
    it('typing in the block replaces its lines and keeps the body', () => {
        expect(afterSelectAll('---\nti|tle: K\ntags: x\n---\n- a', (e) => e.type('title: N'))).toBe('---\ntitle: N|\n---\n- a')
    })
})

describe('Frontmatter does not move', () => {
    // Verbatim metadata is opaque like a fence. Alt+Down used to carry `title:` past the closing
    // delimiter, leaving empty Frontmatter and a stray body line - silently changing which
    // [[Concept]] the document answers to.
    const doc = '---\ntitle: A¦\naliases: []\n---\n\n- item'

    it('refuses to move a Frontmatter line down', () => {
        const editor = editorFixture(doc, { caret: '¦' })
        editor.key('Alt-ArrowDown')
        expect(editor.text()).toBe('---\ntitle: A\naliases: []\n---\n\n- item')
    })

    it('refuses to move a Frontmatter line up', () => {
        const editor = editorFixture(doc, { caret: '¦' })
        editor.key('Alt-ArrowUp')
        expect(editor.text()).toBe('---\ntitle: A\naliases: []\n---\n\n- item')
    })

    it('consumes the key, so the default moveLine cannot do it instead', () => {
        const editor = editorFixture(doc, { caret: '¦' })
        expect(editor.key('Alt-ArrowDown')).toBe(true)
    })

    it('still moves a bullet in the body below it', () => {
        const editor = editorFixture('---\ntitle: A\n---\n\n- one¦\n- two', { caret: '¦' })
        editor.key('Alt-ArrowDown')
        expect(editor.text()).toBe('---\ntitle: A\n---\n\n- two\n- one')
    })
})

// ── Editor Content Rules → Wrapping a selection (ADR 0077) ───────────────────────────────────

/** A row where the key is a typed character, run through the input handler's decision. */
function typedTable(name: string, rows: Rule[]) {
    describe(name, () => {
        for (const row of rows) {
            it(`${row.key}: ${row.rule} (${row.precedent})`, () => {
                const editor = editorFixture(row.before)
                for (const ch of row.key.split(' ')) editor.type(ch)
                expect(editor.fixture()).toBe(row.after)
            })
        }
    })
}

typedTable('wrapping a selection', [
    { rule: 'one press is italic', precedent: 'Logseq', before: '- the «fox» jumped', key: '*', after: '- the *«fox»* jumped' },
    { rule: 'a second press stacks to bold', precedent: 'Logseq', before: '- the *«fox»* jumped', key: '*', after: '- the **«fox»** jumped' },
    { rule: 'underscore the same', precedent: 'Logseq', before: '- the «fox»', key: '_', after: '- the _«fox»_' },
    { rule: 'two presses make a wikilink', precedent: 'Logseq', before: '- the «fox» jumped', key: '[ [', after: '- the [[«fox»]] jumped' },
    { rule: 'parentheses', precedent: 'Logseq', before: '- «fox»', key: '(', after: '- («fox»)' },
    { rule: 'two presses make strikethrough', precedent: 'Logseq', before: '- «fox»', key: '~ ~', after: '- ~~«fox»~~' },
    { rule: 'two presses make a highlight', precedent: 'Logseq', before: '- «fox»', key: '= =', after: '- ==«fox»==' },
    { rule: 'a backtick makes inline code', precedent: 'Logseq', before: '- «fox»', key: '`', after: '- `«fox»`' },
    { rule: 'works in prose too', precedent: 'Logseq', before: 'the «fox»', key: '*', after: 'the *«fox»*' },
    { rule: 'whitespace at the edges stays outside the markers', precedent: 'VS Code', before: '- the« fox »jumped', key: '*', after: '- the *«fox»* jumped' },
    { rule: 'with nothing selected the key is a plain character', precedent: 'EtherPK', before: '- the fox|', key: '[', after: '- the fox[|' },
    { rule: 'a selection across lines is the ordinary replace', precedent: 'EtherPK', before: 'one «two\nthree» four', key: '*', after: 'one *| four' },
    // The replace itself is the block selection's (Editor Content Rules → Selection): the blocks go, and one
    // block takes the first one's place with the typed text.
    { rule: 'a block selection is replaced, not wrapped: one block takes its place', precedent: 'EtherPK', before: '«- a\n- b»', key: '*', after: '- *|' },
    { rule: 'in a fence, brackets wrap', precedent: 'VS Code', before: '- ```js\n  f(«x»)\n  ```', key: '(', after: '- ```js\n  f((«x»))\n  ```' },
    { rule: 'in a fence, a backtick wraps', precedent: 'VS Code', before: '- ```js\n  «x»\n  ```', key: '`', after: '- ```js\n  `«x»`\n  ```' },
    { rule: 'in a fence, an emphasis key is a plain character', precedent: 'VS Code', before: '- ```js\n  a «x» b\n  ```', key: '*', after: '- ```js\n  a *| b\n  ```' },
    { rule: 'in the frontmatter nothing wraps', precedent: 'EtherPK', before: '---\ntitle: «x»\n---\n', key: '[', after: '---\ntitle: [|\n---\n' },
    { rule: 'a wikilink wraps towards a nested one', precedent: 'Logseq', before: '- «[[Test]]»', key: '[ [', after: '- [[«[[Test]]»]]' },
    { rule: 'two wikilinks wrap together towards a scoped one', precedent: 'Logseq', before: '- «[[One]] [[Two]]»', key: '[ [', after: '- [[«[[One]] [[Two]]»]]' },
])

/**
 * A row for the Command Bar's bracket buttons (`[[` / `]]`, editor-commands.ts): the button's own
 * decision over the fixture's selection, `key` naming which button and how many taps.
 */
function bracketButtonTable(name: string, rows: Rule[]) {
    describe(name, () => {
        for (const row of rows) {
            it(`${row.key}: ${row.rule} (${row.precedent})`, () => {
                const editor = editorFixture(row.before)
                for (const text of row.key.split(' ') as ('[[' | ']]')[]) editor.dispatch(editor.state.update(wikilinkButtonSpec(editor.state, text)))
                expect(editor.fixture()).toBe(row.after)
            })
        }
    })
}

bracketButtonTable('the Command Bar bracket buttons over a selection', [
    { rule: 'the button makes the whole wikilink at once, the word left selected', precedent: 'Logseq', before: '- the «fox» jumped', key: '[[', after: '- the [[«fox»]] jumped' },
    { rule: 'the closing button wraps as well: a selection is never replaced by brackets', precedent: 'EtherPK', before: '- the «fox» jumped', key: ']]', after: '- the [[«fox»]] jumped' },
    { rule: 'over the word a [[ tap has just enclosed, ]] finishes the link: the caret steps out past it', precedent: 'EtherPK', before: '- the «fox» jumped', key: '[[ ]]', after: '- the [[fox]]| jumped' },
    { rule: 'the same for a link whose name was selected by hand', precedent: 'EtherPK', before: '- the [[«fox»]] jumped', key: ']]', after: '- the [[fox]]| jumped' },
    { rule: 'in prose too', precedent: 'Logseq', before: 'read «Physics» today', key: '[[', after: 'read [[«Physics»]] today' },
    { rule: 'in a heading', precedent: 'Logseq', before: '## «Physics» notes', key: '[[', after: '## [[«Physics»]] notes' },
    { rule: 'a phrase, not only a word', precedent: 'Logseq', before: '- see «Garden Shed» here', key: '[[', after: '- see [[«Garden Shed»]] here' },
    { rule: 'whitespace at the edges stays outside the brackets', precedent: 'VS Code', before: '- the« fox »jumped', key: '[[', after: '- the [[«fox»]] jumped' },
    { rule: 'a second tap adds a layer, as a third and fourth press of [ would', precedent: 'Logseq', before: '- «fox»', key: '[[ [[', after: '- [[[[«fox»]]]]' },
    { rule: 'a wikilink wraps towards a nested one', precedent: 'Logseq', before: '- «[[Test]]»', key: '[[', after: '- [[«[[Test]]»]]' },
    { rule: 'in a fence the brackets wrap', precedent: 'VS Code', before: '- ```js\n  f(«x»)\n  ```', key: '[[', after: '- ```js\n  f([[«x»]])\n  ```' },
    { rule: 'with nothing selected the button types its brackets', precedent: 'EtherPK', before: '- the fox|', key: '[[', after: '- the fox[[|' },
    { rule: 'and the closing button types its own', precedent: 'EtherPK', before: '- the [[fox|', key: ']]', after: '- the [[fox]]|' },
    { rule: 'a selection of only whitespace is the ordinary replace', precedent: 'EtherPK', before: '- the« »fox', key: '[[', after: '- the[[|fox' },
    { rule: 'a selection across lines is the ordinary replace', precedent: 'EtherPK', before: 'one «two\nthree» four', key: '[[', after: 'one [[| four' },
    { rule: 'a block selection is replaced, not wrapped: one block takes its place', precedent: 'EtherPK', before: '«- a\n- b»', key: '[[', after: '- [[|' },
    { rule: 'in the frontmatter nothing wraps', precedent: 'EtherPK', before: '---\ntitle: «x»\n---\n', key: '[[', after: '---\ntitle: [[|\n---\n' },
])

// Typing over a block selection replaces the blocks, and one block takes the first one's place, at its
// indent and with its marker, so the outline never loses a parent (Editor Content Rules → Selection).
typedTable('typing over a block selection leaves one block in its place', [
    { rule: 'the typed text is the block’s content, at the first block’s indent', precedent: 'EtherPK', before: '- a\n«  - b\n  - c»\n  - d', key: 'x', after: '- a\n  - x|\n  - d' },
    { rule: 'two stars are typed, not wrapped, into the block', precedent: 'EtherPK', before: '- a\n«  - b\n  - c»\n  - d', key: '* *', after: '- a\n  - **|\n  - d' },
    { rule: 'the selected blocks’ children go with them', precedent: 'EtherPK', before: '- a\n«  - b\n    - c\n- d\n  - e»\n- f', key: 'x', after: '- a\n  - x|\n- f' },
    { rule: 'a task stays a task, open again', precedent: 'EtherPK', before: '«- [x] a\n- b»\n- c', key: 'x', after: '- [ ] x|\n- c' },
    { rule: 'a bullet whose text is a heading leaves a plain bullet', precedent: 'EtherPK', before: '«- ## a\n- b»', key: 'x', after: '- x|' },
    { rule: 'a bullet whose code opens on its line leaves a plain bullet', precedent: 'EtherPK', before: '«- ```js\n  y\n  ```\n- b»', key: 'x', after: '- x|' },
    { rule: 'a selection on into prose is replaced the same way', precedent: 'EtherPK', before: '- a\n«  - b\n\nprose»\n- c', key: 'x', after: '- a\n  - x|\n- c' },
])

describe('after a wrap the inner text stays selected, left to right', () => {
    it('so the caret ends after the word whichever way it was selected', () => {
        const editor = editorFixture('- the fox|')
        editor.select(9, 6) // right to left: anchor after "fox", head before it
        editor.type('*')
        expect(editor.fixture()).toBe('- the *«fox»*')
        expect(editor.head()).toBe(10)
        expect(editor.state.selection.main.anchor).toBe(7)
    })
})

table('format toggles', [
    { rule: 'Mod-b wraps the selection in bold', precedent: 'Obsidian', before: '- «fox»', key: 'Mod-b', after: '- **«fox»**' },
    { rule: 'Mod-b on bold unwraps it', precedent: 'Obsidian', before: '- **«fox»**', key: 'Mod-b', after: '- «fox»' },
    { rule: 'Mod-b on a selection that includes the markers unwraps it', precedent: 'Obsidian', before: '- «**fox**»', key: 'Mod-b', after: '- «fox»' },
    { rule: 'Mod-b with nothing selected opens an empty pair', precedent: 'Obsidian', before: '- |', key: 'Mod-b', after: '- **|**' },
    { rule: 'Mod-b on the empty pair removes it', precedent: 'Obsidian', before: '- **|**', key: 'Mod-b', after: '- |' },
    { rule: 'Mod-i wraps in italic', precedent: 'Obsidian', before: '- «fox»', key: 'Mod-i', after: '- *«fox»*' },
    { rule: 'Mod-i on italic unwraps it', precedent: 'Obsidian', before: '- *«fox»*', key: 'Mod-i', after: '- «fox»' },
    { rule: 'Mod-Shift-h wraps in highlight', precedent: 'Logseq', before: '- «fox»', key: 'Mod-Shift-h', after: '- ==«fox»==' },
    { rule: 'Mod-Shift-h on a highlight unwraps it', precedent: 'Logseq', before: '- ==«fox»==', key: 'Mod-Shift-h', after: '- «fox»' },
    { rule: 'a toggle trims edge whitespace like a wrap key', precedent: 'VS Code', before: '- the« fox »ran', key: 'Mod-b', after: '- the **«fox»** ran' },
    { rule: 'at the end of a marked word the chord steps out past the closing run', precedent: 'EtherPK', before: '- **fox|**', key: 'Mod-b', after: '- **fox**|' },
    { rule: 'stepping out, for highlight', precedent: 'EtherPK', before: '- ==fox|==', key: 'Mod-Shift-h', after: '- ==fox==|' },
    { rule: 'before an opening run the chord opens a pair as usual', precedent: 'EtherPK', before: '- |**fox**', key: 'Mod-b', after: '- **|****fox**' },
    { rule: 'refused in a fence', precedent: 'VS Code', before: '- ```js\n  «x»\n  ```', key: 'Mod-b', after: '- ```js\n  «x»\n  ```' },
    { rule: 'refused in inline code', precedent: 'EtherPK', before: '- `«code»`', key: 'Mod-b', after: '- `«code»`' },
    { rule: 'refused in the frontmatter', precedent: 'EtherPK', before: '---\ntitle: «x»\n---\n', key: 'Mod-b', after: '---\ntitle: «x»\n---\n' },
    { rule: 'refused across lines', precedent: 'EtherPK', before: 'one «two\nthree» four', key: 'Mod-b', after: 'one «two\nthree» four' },
])

// Interactive fences (Editor Content Rules → Interactive fences, ADR 0118): a Map Block is a fenced
// block drawn as its widget while no selection touches it, as a rendered fence is (ADR 0022). The
// caret on its lines, or a selection reaching it, shows its text, where every fenced-code rule
// applies, and beside it the keys are a code block's. A map opened on a bullet's line is drawn after
// the marker, beside the dot.
describe('the caret at an interactive fence', () => {
    const widget: InteractiveFence = { height: () => 320, mount: () => ({ update: () => {}, destroy: () => {} }) }
    beforeEach(() => {
        const registry = createContributionRegistry()
        registerInteractiveFence(registry, 'map', widget)
        setActiveContributionRegistry(registry)
    })
    afterEach(() => setActiveContributionRegistry(null))

    const map = '```map\nGarden @ 50.7, -1.0\n```'
    /** The same map beneath a bullet, at its content column. */
    const nested = map.replaceAll('\n', '\n  ')
    const open = (doc: string) => editorFixture(doc, { extensions: [interactiveFenceAugmentation()] })

    /**
     * A key as the editor runs it: every binding for it in precedence order, then the default. The
     * map's arrows run ahead of the view's own vertical motion, which no headless editor has.
     */
    function pressKey(editor: ReturnType<typeof open>, key: string): void {
        for (const binding of editor.state.facet(keymap).flat()) {
            if (binding.key === key && binding.run?.(editor as never)) return
        }
        editor.key(key)
    }

    /** What each widget stands in for, `block` over whole lines or `inline` after a bullet's marker. */
    function drawn(editor: ReturnType<typeof open>): string[] {
        const out: string[] = []
        for (const source of editor.state.facet(EditorView.decorations)) {
            if (typeof source === 'function') continue
            source.between(0, editor.state.doc.length, (from, to, value) => {
                if (value.spec.widget) out.push(`${value.spec.block ? 'block' : 'inline'}: ${editor.state.sliceDoc(from, to)}`)
            })
        }
        return out
    }

    // A fence drawn while the caret is elsewhere and shown as text while it is in it is Obsidian's
    // Live Preview. Opened on a bullet's line, it is drawn after the marker, the form-1 convention of
    // the rendered fences (ADR 0022).
    const shows: { rule: string; precedent: Rule['precedent']; doc: string; drawn: string[] }[] = [
        { rule: 'a map is drawn as its widget while the caret is on another line', precedent: 'Obsidian', doc: `Int|ro\n${map}\nAfter`, drawn: [`block: ${map}`] },
        { rule: 'the caret at the end of the line above leaves it drawn', precedent: 'Obsidian', doc: `Intro|\n${map}\nAfter`, drawn: [`block: ${map}`] },
        { rule: 'the caret at the start of the line below leaves it drawn', precedent: 'Obsidian', doc: `Intro\n${map}\n|After`, drawn: [`block: ${map}`] },
        { rule: 'the caret on its opening fence shows its text', precedent: 'Obsidian', doc: `Intro\n|${map}\nAfter`, drawn: [] },
        { rule: 'the caret at the end of its closing fence shows its text', precedent: 'Obsidian', doc: `Intro\n${map}|\nAfter`, drawn: [] },
        { rule: 'a selection reaching into it shows its text', precedent: 'Obsidian', doc: 'In«tro\n```map\nGar»den @ 50.7, -1.0\n```\nAfter', drawn: [] },
        { rule: 'beneath a bullet it is drawn over its own lines, from the content column', precedent: 'EtherPK', doc: `- Trip|\n  ${nested}\n- After`, drawn: [`block:   ${nested}`] },
        { rule: 'a map opened on a bullet’s line is drawn after the marker, beside the dot', precedent: 'EtherPK', doc: `- Int|ro\n- ${nested}\n- After`, drawn: [`inline: ${nested}`] },
        { rule: 'the caret on that bullet’s line shows its text', precedent: 'EtherPK', doc: `- Intro\n- |${nested}\n- After`, drawn: [] },
        { rule: 'the caret at the end of the line above that bullet leaves it drawn', precedent: 'EtherPK', doc: `- Intro|\n- ${nested}\n- After`, drawn: [`inline: ${nested}`] },
    ]
    for (const row of shows) {
        it(`${row.rule} (${row.precedent})`, () => {
            expect(drawn(open(row.doc))).toEqual(row.drawn)
        })
    }

    const keyRows: Rule[] = [
        { rule: 'ArrowDown from the line above a map shows its text, the caret on its opening fence', precedent: 'Obsidian', before: `Int|ro\n${map}\nAfter`, key: 'ArrowDown', after: `Intro\n|${map}\nAfter` },
        { rule: 'ArrowUp from the line below a map shows its text, the caret at the end of its closing fence', precedent: 'Obsidian', before: `Intro\n${map}\nAf|ter`, key: 'ArrowUp', after: `Intro\n${map}|\nAfter` },
        { rule: 'beneath a bullet, ArrowDown lands on the opening fence at the content column', precedent: 'Obsidian', before: `- Tr|ip\n  ${nested}\n- After`, key: 'ArrowDown', after: `- Trip\n  |${nested}\n- After` },
        { rule: 'Backspace at the start of the line after a map changes nothing, as after any code block', precedent: 'Logseq', before: `Intro\n${map}\n|After`, key: 'Backspace', after: `Intro\n${map}\n|After` },
        { rule: 'Delete at the end of the line before a map changes nothing, as before any code block', precedent: 'Logseq', before: `Intro|\n${map}\nAfter`, key: 'Delete', after: `Intro|\n${map}\nAfter` },
        // Over a form-1 map's inline widget the view's motion would land by which half of the widget
        // the caret's column is under: the same two places as a block's are given instead.
        { rule: 'ArrowDown from the bullet above a map on a bullet’s line lands on its fence column', precedent: 'EtherPK', before: `- Garden pat|h\n- ${nested}\n- After`, key: 'ArrowDown', after: `- Garden path\n- |${nested}\n- After` },
        { rule: 'ArrowUp from the bullet below a map on a bullet’s line lands at the end of its closing fence', precedent: 'EtherPK', before: `- Intro\n- ${nested}\n- Af|ter`, key: 'ArrowUp', after: `- Intro\n- ${nested}|\n- After` },
        { rule: 'Delete at the end of the bullet above a map on a bullet’s line changes nothing', precedent: 'Logseq', before: `- Intro|\n- ${nested}\n- After`, key: 'Delete', after: `- Intro|\n- ${nested}\n- After` },
        { rule: 'Backspace at the start of the bullet below a map on a bullet’s line changes nothing', precedent: 'Logseq', before: `- Intro\n- ${nested}\n- |After`, key: 'Backspace', after: `- Intro\n- ${nested}\n- |After` },
    ]
    for (const row of keyRows) {
        it(`${row.key}: ${row.rule} (${row.precedent})`, () => {
            const editor = open(row.before)
            pressKey(editor, row.key)
            expect(editor.fixture()).toBe(row.after)
        })
    }

    it('ArrowDown or ArrowUp further from a map is left to the view (EtherPK)', () => {
        for (const [doc, key] of [[`Fir|st\nIntro\n${map}`, 'ArrowDown'], [`${map}\nAfter\nLa|st`, 'ArrowUp']] as const) {
            const editor = open(doc)
            pressKey(editor, key)
            expect(editor.fixture()).toBe(doc)
        }
    })
})

// Extension Fences (Editor Content Rules → Extension Fences, ADR 0138): a fence named
// `<extension id>.<name>` holds an extension's data, such as a drawing. It is drawn by its widget, or
// by a placeholder where its extension is not running, and the caret alone never shows its text: the
// caret passes over it as one block, as over an embed in a block editor, and its text shows only
// through Edit as text. Beside it the keys are a code block's, as beside any interactive fence.
describe('the caret at an Extension Fence', () => {
    const widget: InteractiveFence = { height: () => 400, mount: () => ({ update: () => {}, destroy: () => {} }) }
    beforeEach(() => {
        const registry = createContributionRegistry()
        registerInteractiveFence(registry, 'garden.plan', widget)
        setActiveContributionRegistry(registry)
    })
    afterEach(() => setActiveContributionRegistry(null))

    const plan = '```garden.plan\n{"id":"k1"}\n{"type":"rectangle"}\n```'
    const nested = plan.replaceAll('\n', '\n  ')
    const open = (doc: string) => editorFixture(doc, { extensions: [interactiveFenceAugmentation()] })

    function pressKey(editor: ReturnType<typeof open>, key: string): void {
        for (const binding of editor.state.facet(keymap).flat()) {
            if (binding.key === key && binding.run?.(editor as never)) return
        }
        editor.key(key)
    }

    function drawn(editor: ReturnType<typeof open>): string[] {
        const out: string[] = []
        for (const source of editor.state.facet(EditorView.decorations)) {
            if (typeof source === 'function') continue
            source.between(0, editor.state.doc.length, (from, to, value) => {
                if (value.spec.widget) out.push(`${value.spec.block ? 'block' : 'inline'}: ${editor.state.sliceDoc(from, to)}`)
            })
        }
        return out
    }

    const shows: { rule: string; precedent: Rule['precedent']; doc: string; drawn: string[] }[] = [
        { rule: 'an Extension Fence is drawn as its widget while the caret is on another line', precedent: 'EtherPK', doc: `Int|ro\n${plan}\nAfter`, drawn: [`block: ${plan}`] },
        { rule: 'a selection reaching across it leaves it drawn, where a map’s would show its text', precedent: 'EtherPK', doc: 'In«tro\n```garden.plan\n{"id":"k1"}\n{"type":"rectangle"}\n```\nAf»ter', drawn: [`block: ${plan}`] },
        { rule: 'opened on a bullet’s line it is drawn after the marker, beside the dot', precedent: 'EtherPK', doc: `- Int|ro\n- ${nested}\n- After`, drawn: [`inline: ${nested}`] },
    ]
    for (const row of shows) {
        it(`${row.rule} (${row.precedent})`, () => {
            expect(drawn(open(row.doc))).toEqual(row.drawn)
        })
    }

    const keyRows: Rule[] = [
        { rule: 'Backspace at the start of the line after an Extension Fence changes nothing, as after any code block', precedent: 'Logseq', before: `Intro\n${plan}\n|After`, key: 'Backspace', after: `Intro\n${plan}\n|After` },
        { rule: 'Delete at the end of the line before an Extension Fence changes nothing, as before any code block', precedent: 'Logseq', before: `Intro|\n${plan}\nAfter`, key: 'Delete', after: `Intro|\n${plan}\nAfter` },
    ]
    for (const row of keyRows) {
        it(`${row.key}: ${row.rule} (${row.precedent})`, () => {
            const editor = open(row.before)
            pressKey(editor, row.key)
            expect(editor.fixture()).toBe(row.after)
        })
    }

    // Where a caret placed on its lines comes to rest. The arrow keys reach these places through
    // the editor's atomic ranges, which need a view (tests-client/extension-api.test.ts); every
    // other placement (a press, an undo, a command's selection) passes the caret filter, checked here
    // by moving the caret to the start of `to`.
    const placements: { rule: string; precedent: Rule['precedent']; before: string; to: string; after: string }[] = [
        { rule: 'a caret moving down onto it rests at the start of the line below', precedent: 'EtherPK', before: `Int|ro\n${plan}\nAfter`, to: '{"type"', after: `Intro\n${plan}\n|After` },
        { rule: 'a caret moving up onto it rests at the end of the line above', precedent: 'EtherPK', before: `Intro\n${plan}\nAf|ter`, to: '{"id"', after: `Intro|\n${plan}\nAfter` },
        { rule: 'on a bullet’s line, a caret moving down onto it rests at the start of the bullet below', precedent: 'EtherPK', before: `- Garden pat|h\n- ${nested}\n- After`, to: '{"id"', after: `- Garden path\n- ${nested}\n- |After` },
    ]
    for (const row of placements) {
        it(`${row.rule} (${row.precedent})`, () => {
            const editor = open(row.before)
            editor.dispatch(editor.state.update({ selection: { anchor: editor.text().indexOf(row.to) }, userEvent: 'select' }))
            expect(editor.fixture()).toBe(row.after)
        })
    }

    // Where the caret meets a second wall beside the fence: the outline's margin, a second fence, the
    // frontmatter or an end of the document. Each row moves the caret as the editor would and then
    // types, which writes beside the fence and never into its lines.
    const second = '```garden.plan\n{"id":"k2"}\n```'
    const select = (to: (editor: ReturnType<typeof open>) => number) => (editor: ReturnType<typeof open>) =>
        editor.dispatch(editor.state.update({ selection: { anchor: to(editor) }, userEvent: 'select' }))
    const walls: { rule: string; precedent: Rule['precedent']; before: string; move: (editor: ReturnType<typeof open>) => void; after: string }[] = [
        {
            rule: 'ArrowLeft at the start of the bullet below a fence on a bullet’s line flows to the end of the bullet above the fence',
            precedent: 'Logseq',
            before: `- Intro\n- ${nested}\n- |After`,
            move: select((editor) => editor.head() - 1),
            after: `- Introx|\n- ${nested}\n- After`,
        },
        {
            rule: 'ArrowLeft at the start of the bullet below a fence in the bullet above flows to the end of that bullet’s line',
            precedent: 'Logseq',
            before: `- Intro\n  ${nested}\n- |After`,
            move: select((editor) => editor.head() - 1),
            after: `- Introx|\n  ${nested}\n- After`,
        },
        {
            rule: 'a caret moving down onto the first of two fences in a row goes on past both',
            precedent: 'EtherPK',
            before: `Int|ro\n${plan}\n${second}\nAfter`,
            move: select((editor) => editor.text().indexOf('{"type"')),
            after: `Intro\n${plan}\n${second}\nx|After`,
        },
        {
            rule: 'with the frontmatter above it and nothing below, Ctrl+End rests at its end, and typing starts a line below it',
            precedent: 'EtherPK',
            before: `---\ntitle: Garden\n---\n|${plan}`,
            move: select((editor) => editor.text().length),
            after: `---\ntitle: Garden\n---\n${plan}\nx|`,
        },
        {
            rule: 'with the frontmatter above it, Backspace on the empty last line takes the line, and typing then starts a line above it',
            precedent: 'EtherPK',
            before: `---\ntitle: Garden\n---\n${plan}\n|`,
            move: (editor) => void editor.key('Backspace'),
            after: `---\ntitle: Garden\n---\nx|\n${plan}`,
        },
        {
            rule: 'in a document that opens with it, typing before the caret has moved starts a line above it',
            precedent: 'EtherPK',
            before: `|${plan}\nAfter`,
            move: () => {},
            after: `x|\n${plan}\nAfter`,
        },
    ]
    for (const row of walls) {
        it(`${row.rule} (${row.precedent})`, () => {
            const editor = open(row.before)
            row.move(editor)
            editor.type('x')
            expect(editor.fixture()).toBe(row.after)
        })
    }

    it('Tab over a block selection that holds a fence on a bullet’s line indents the fence with its bullet (Logseq)', () => {
        const editor = open(`- Intro\n«- ${nested}\n- After»`)
        pressKey(editor, 'Tab')
        expect(editor.text()).toBe(`- Intro\n  - ${plan.replaceAll('\n', '\n    ')}\n  - After`)
    })

    it('a paste or deletion that would change its lines with the caret at its edge changes nothing (EtherPK)', () => {
        const editor = open(`|${plan}\nAfter`)
        editor.key('Delete')
        expect(editor.fixture()).toBe(`|${plan}\nAfter`)
        editor.paste('beans\npeas')
        expect(editor.text()).toBe(`beans\npeas\n${plan}\nAfter`)
    })
})

// Where an inline panel's block lands (Editor Content Rules → Inline panels, ADR 0147, amended
// 2026-10-20): the block is the panel's line's first child, after the line's own text, and it never
// rearranges the outline around it. `line` is the 1-based line the panel opened on, `after` the text
// once the block is in, or null where the block is refused and the text stays as it was. The caret
// is on the panel's line, where `/Agent` was typed.
describe("where an inline panel's block lands", () => {
    const rows: { rule: string; precedent: Rule['precedent']; before: string; line: number; block: string; after: string | null }[] = [
        {
            rule: "beneath a bullet with continuation lines it goes after them, never between the bullet's lines",
            precedent: 'EtherPK',
            before: '- Kitchen|\n  more about the kitchen\n- Shed',
            line: 1,
            block: '- Agent Chat\n  - What?',
            after: '- Kitchen\n  more about the kitchen\n  - Agent Chat\n    - What?\n- Shed',
        },
        {
            rule: "beneath a bullet whose children sit deeper than its content column it goes in at their indentation, as their sibling, as Enter makes a first child (ADR 0019)",
            precedent: 'Logseq',
            before: '- Kitchen|\n    - beans\n- Shed',
            line: 1,
            block: '- Agent Chat\n  - What?',
            after: '- Kitchen\n    - Agent Chat\n      - What?\n    - beans\n- Shed',
        },
        {
            rule: 'a blank line inside the block takes the indentation of the line after it, so the block stays one branch',
            precedent: 'EtherPK',
            before: '- Garden\n  - Kitchen|\n  - Shed',
            line: 2,
            block: '- Agent Chat\n  - 1. Dig\n\n    Then rake.',
            after: '- Garden\n  - Kitchen\n    - Agent Chat\n      - 1. Dig\n        \n        Then rake.\n  - Shed',
        },
        {
            rule: 'a block with an indented heading in it, which would end every branch around it, is refused',
            precedent: 'EtherPK',
            before: '- Garden\n  - Kitchen|\n  - Shed',
            line: 2,
            block: '- Agent Chat\n  - What?\n  ## Sowing',
            after: null,
        },
    ]
    for (const row of rows) {
        it(`${row.rule} (${row.precedent})`, () => {
            const editor = editorFixture(row.before, { extensions: [inlinePanelsField] })
            editor.dispatch(editor.state.update({ effects: addInlinePanel.of({ id: 1, lineStart: editor.state.doc.line(row.line).from, mode: 'line' }) }))
            const plan = planPanelInsert(editor.state, 1, row.block)
            if (plan) editor.dispatch(editor.state.update({ changes: plan.changes, effects: plan.effects }))
            expect(plan === null ? null : editor.text()).toBe(row.after)
            if (row.after === null) expect(editor.text()).toBe(row.before.replace('|', ''))
        })
    }
})

// Inline panels (Editor Content Rules → Inline panels, ADR 0147): the empty bullet a panel is drawn
// beside is the panel's place, where its first block goes, so the caret is kept off it as it is kept
// off an Extension Fence's lines, by the same filter and atomic ranges: it passes over the line, and
// comes back to it only once the panel closes.
describe('the caret beside an inline panel', () => {
    beforeEach(() => setActiveContributionRegistry(createContributionRegistry()))
    afterEach(() => setActiveContributionRegistry(null))

    const open = (doc: string) => editorFixture(doc, { extensions: [interactiveFenceAugmentation(), inlinePanelsField, panelCaretBlocks] })
    type Fixture = ReturnType<typeof open>
    /** Open a panel at the start of 1-based `line`, as `openPanel` places one at the caret's line. */
    const openPanel = (editor: Fixture, line: number, id = 1) =>
        editor.dispatch(editor.state.update({ effects: addInlinePanel.of({ id, lineStart: editor.state.doc.line(line).from, mode: 'line' }) }))
    const select = (editor: Fixture, anchor: number, head = anchor) => editor.dispatch(editor.state.update({ selection: { anchor, head }, userEvent: 'select' }))

    const opening: { rule: string; precedent: Rule['precedent']; before: string; line: number; after: string }[] = [
        { rule: 'a panel opening beside the empty bullet the caret is on moves the caret to the end of the line above', precedent: 'EtherPK', before: '- Garden\n  - |\n- Kitchen', line: 2, after: '- Garden|\n  - \n- Kitchen' },
        { rule: 'with the frontmatter above it, the caret goes to the start of the bullet below instead', precedent: 'EtherPK', before: '---\ntitle: Garden\n---\n- |\n- Kitchen', line: 4, after: '---\ntitle: Garden\n---\n- \n- |Kitchen' },
        { rule: 'a panel opening beneath a line with text leaves the caret on that line', precedent: 'EtherPK', before: '- Gar|den\n- Kitchen', line: 1, after: '- Gar|den\n- Kitchen' },
    ]
    for (const row of opening) {
        it(`${row.rule} (${row.precedent})`, () => {
            const editor = open(row.before)
            openPanel(editor, row.line)
            expect(editor.fixture()).toBe(row.after)
        })
    }

    it('moves the caret off without a step in the undo history or a tidy of the line it leaves (EtherPK)', () => {
        const editor = open('- Garden\n  -   |\n- Kitchen')
        openPanel(editor, 2)
        expect(editor.text()).toBe('- Garden\n  -   \n- Kitchen')
        expect(editor.fixture()).toBe('- Garden|\n  -   \n- Kitchen')
    })

    const placements: { rule: string; precedent: Rule['precedent']; before: string; line: number; to: (editor: Fixture) => number; after: string }[] = [
        {
            rule: 'a caret moving down onto it (a key, a press or a tap) rests at the start of the bullet below',
            precedent: 'EtherPK',
            before: '- Gar|den\n  - \n- Kitchen',
            line: 2,
            to: (editor) => editor.state.doc.line(2).to,
            after: '- Garden\n  - \n- |Kitchen',
        },
        {
            rule: 'a caret moving up onto it rests at the end of the line above',
            precedent: 'EtherPK',
            before: '- Garden\n  - \n- Kit|chen',
            line: 2,
            to: (editor) => editor.state.doc.line(2).to,
            after: '- Garden|\n  - \n- Kitchen',
        },
        {
            rule: 'ArrowLeft at the start of the bullet below it flows to the end of the line above, past it',
            precedent: 'Logseq',
            before: '- Garden\n  - \n- |Kitchen',
            line: 2,
            to: (editor) => editor.head() - 1,
            after: '- Garden|\n  - \n- Kitchen',
        },
    ]
    for (const row of placements) {
        it(`${row.rule} (${row.precedent})`, () => {
            const editor = open(row.before)
            openPanel(editor, row.line)
            select(editor, row.to(editor))
            expect(editor.fixture()).toBe(row.after)
        })
    }

    it('passes two panels in a row, as two Extension Fences in a row (EtherPK)', () => {
        const editor = open('- Gar|den\n- \n- \n- Kitchen')
        openPanel(editor, 2, 1)
        openPanel(editor, 3, 2)
        select(editor, editor.state.doc.line(2).to)
        expect(editor.fixture()).toBe('- Garden\n- \n- \n- |Kitchen')
    })

    it('leaves Select all whole with a panel on the last line (EtherPK)', () => {
        const editor = open('- Gar|den\n- Kitchen\n- ')
        openPanel(editor, 3)
        select(editor, 0, editor.state.doc.length)
        expect(editor.fixture()).toBe('«- Garden\n- Kitchen\n- »')
    })

    it('gives the line back once the panel closes (EtherPK)', () => {
        const editor = open('- Gar|den\n  - \n- Kitchen')
        openPanel(editor, 2)
        editor.dispatch(editor.state.update({ effects: removeInlinePanel.of(1) }))
        select(editor, editor.state.doc.line(2).to)
        expect(editor.fixture()).toBe('- Garden\n  - |\n- Kitchen')
    })
})

// The two buttons after a document's text (ADR 0149, Editor Content Rules → End of document): each
// always starts on a new line at the end, the text button an empty line after a blank line, the
// bullet button a top-level bullet, and either is taken back out if the caret leaves it untouched.
describe('the end of the document', () => {
    beforeEach(() => setActiveContributionRegistry(createContributionRegistry()))
    afterEach(() => setActiveContributionRegistry(null))

    const open = (doc: string) => editorFixture(doc, { extensions: [endOfDocument(), interactiveFenceAugmentation(), inlinePanelsField, panelCaretBlocks] })
    type Fixture = ReturnType<typeof open>
    const select = (editor: Fixture, anchor: number, head = anchor) => editor.dispatch(editor.state.update({ selection: { anchor, head }, userEvent: 'select' }))

    const starts: { rule: string; precedent: Rule['precedent']; kind: EndKind; before: string; after: string }[] = [
        { rule: 'the text button starts an empty line after a blank line below the last text', precedent: 'EtherPK', kind: 'line', before: '- Gar|den\n- Kitchen', after: '- Garden\n- Kitchen\n\n|' },
        { rule: 'after a paragraph too, so what is typed starts a paragraph of its own', precedent: 'EtherPK', kind: 'line', before: 'Some no|tes', after: 'Some notes\n\n|' },
        { rule: 'a document ending in one line break gets one more', precedent: 'EtherPK', kind: 'line', before: 'Some no|tes\n', after: 'Some notes\n\n|' },
        { rule: 'a blank line already after the text is reused', precedent: 'EtherPK', kind: 'line', before: 'Some no|tes\n\n', after: 'Some notes\n\n|' },
        { rule: 'with more blank lines, the line after the first is used and the rest left alone', precedent: 'EtherPK', kind: 'line', before: 'Some no|tes\n\n\n', after: 'Some notes\n\n|\n' },
        { rule: 'below a code block at the end, after a blank line', precedent: 'EtherPK', kind: 'line', before: '```\nco|de\n```', after: '```\ncode\n```\n\n|' },
        { rule: 'a body with no text: the caret at its start, below the frontmatter', precedent: 'EtherPK', kind: 'line', before: '---\ntitle: Gar|den\n---\n', after: '---\ntitle: Garden\n---\n|' },
        { rule: 'frontmatter that ends the document gets a line after it', precedent: 'EtherPK', kind: 'line', before: '---\ntitle: Gar|den\n---', after: '---\ntitle: Garden\n---\n|' },
        { rule: 'the bullet button puts a top-level bullet straight under the last bullet, however deep', precedent: 'Logseq', kind: 'bullet', before: '- Garden\n  - wat|er', after: '- Garden\n  - water\n- |' },
        { rule: 'straight under a code block inside a bullet, which is the bullet\'s own', precedent: 'EtherPK', kind: 'bullet', before: '- Garden\n  ```\n  co|de\n  ```', after: '- Garden\n  ```\n  code\n  ```\n- |' },
        { rule: 'after a heading, a blank line first', precedent: 'EtherPK', kind: 'bullet', before: '# Gar|den', after: '# Garden\n\n- |' },
        { rule: 'after a paragraph, a blank line first, reusing one already there', precedent: 'EtherPK', kind: 'bullet', before: 'Some no|tes\n\n', after: 'Some notes\n\n- |' },
        { rule: 'after a code block at the top level, a blank line first', precedent: 'EtherPK', kind: 'bullet', before: '```\nco|de\n```', after: '```\ncode\n```\n\n- |' },
        { rule: 'a document ending in a line break gets the bullet on that empty last line', precedent: 'EtherPK', kind: 'bullet', before: '- Gar|den\n', after: '- Garden\n- |' },
        { rule: 'an empty top-level bullet already at the end is reused', precedent: 'EtherPK', kind: 'bullet', before: '- Gar|den\n- ', after: '- Garden\n- |' },
        { rule: 'an empty nested bullet at the end still gets a top-level one under it', precedent: 'EtherPK', kind: 'bullet', before: '- Gar|den\n  - ', after: '- Garden\n  - \n- |' },
        { rule: 'an empty document gets the bullet on its first line', precedent: 'EtherPK', kind: 'bullet', before: '|', after: '- |' },
        { rule: 'frontmatter that ends the document gets the bullet on a line after it', precedent: 'EtherPK', kind: 'bullet', before: '---\ntitle: Gar|den\n---', after: '---\ntitle: Garden\n---\n- |' },
    ]
    for (const row of starts) {
        it(`${row.rule} (${row.precedent})`, () => {
            const editor = open(row.before)
            startAtEnd(editor, row.kind)
            expect(editor.fixture()).toBe(row.after)
        })
    }

    const takeBacks: { rule: string; precedent: Rule['precedent']; kind: EndKind; before: string; to: number; after: string }[] = [
        { rule: 'a new line left untouched is taken back out with its blank line when the caret leaves it', precedent: 'EtherPK', kind: 'line', before: 'Some no|tes', to: 4, after: 'Some| notes' },
        { rule: 'a new bullet left untouched is taken back out when the caret leaves it', precedent: 'EtherPK', kind: 'bullet', before: '- Garden\n  - wat|er', to: 2, after: '- |Garden\n  - water' },
        { rule: 'a blank line the button reused keeps the spaces it held', precedent: 'EtherPK', kind: 'bullet', before: '- Gar|den\n  ', to: 0, after: '- |Garden\n  ' },
        { rule: 'the caret moving up onto the blank line above lands at the end of the text', precedent: 'EtherPK', kind: 'line', before: 'Some no|tes', to: 11, after: 'Some notes|' },
        { rule: 'a bullet after frontmatter that ends the document is taken back out too', precedent: 'EtherPK', kind: 'bullet', before: '---\ntitle: Gar|den\n---', to: 5, after: '---\nt|itle: Garden\n---' },
    ]
    for (const row of takeBacks) {
        it(`${row.rule} (${row.precedent})`, () => {
            const editor = open(row.before)
            startAtEnd(editor, row.kind)
            select(editor, row.to)
            expect(editor.fixture()).toBe(row.after)
        })
    }

    it('ArrowLeft at the new bullet\'s wall flows to the end of the line above and takes the bullet back (Logseq)', () => {
        const editor = open('- Garden\n  - wat|er')
        startAtEnd(editor, 'bullet')
        // The caret clamp turns a move into the bullet's margin into the end of the line above.
        select(editor, editor.head() - 1)
        expect(editor.fixture()).toBe('- Garden\n  - water|')
    })

    it('text put in where the line\'s added text begins is kept above it when the line is taken back (EtherPK)', () => {
        // Another device or an external write typing at the end of the last text, before the line.
        const editor = open('Some no|tes')
        startAtEnd(editor, 'line')
        editor.dispatch(editor.state.update({ changes: { from: 10, insert: 'X' } }))
        editor.dispatch(editor.state.update({ changes: { from: 11, insert: 'Y' } }))
        select(editor, 0)
        expect(editor.fixture()).toBe('|Some notesXY')
    })

    it('a bullet a panel holds is not reused: the next bullet goes under it (EtherPK)', () => {
        const editor = open('- Gar|den')
        startAtEnd(editor, 'bullet')
        editor.dispatch(editor.state.update({ effects: addInlinePanel.of({ id: 1, lineStart: editor.state.doc.line(2).from, mode: 'line' }) }))
        startAtEnd(editor, 'bullet')
        expect(editor.fixture()).toBe('- Garden\n- \n- |')
    })

    it('an edit elsewhere leaves the line, which is taken back after it and out of its undo step (EtherPK)', () => {
        const editor = open('Some no|tes')
        startAtEnd(editor, 'line')
        editor.dispatch(editor.state.update({ changes: { from: 0, insert: 'Big ' }, selection: { anchor: 4 }, userEvent: 'input.type' }))
        expect(editor.text()).toBe('Big Some notes\n\n')
        takeBackIfLeft(editor)
        expect(editor.fixture()).toBe('Big |Some notes')
        editor.key('Mod-z')
        expect(editor.text()).toBe('Some notes')
    })

    // The press is no step in the history, so the history maps its steps through it, and text it
    // restores at the end of the last text would land on the new line. It goes back where it was.
    const restores: { rule: string; precedent: Rule['precedent']; kind: EndKind; before: string; steps: (editor: Fixture) => void; after: string }[] = [
        {
            rule: 'Mod+Z of a deletion at the end of the text puts the text back there, not on the new line',
            precedent: 'EtherPK',
            kind: 'line',
            before: 'Some notes!|',
            steps: (editor) => editor.key('Backspace'),
            after: 'Some notes!',
        },
        {
            rule: 'and on a new bullet straight under a bullet',
            precedent: 'EtherPK',
            kind: 'bullet',
            before: '- Garden!|',
            steps: (editor) => editor.key('Backspace'),
            after: '- Garden!',
        },
    ]
    for (const row of restores) {
        it(`${row.rule} (${row.precedent})`, () => {
            const editor = open(row.before)
            row.steps(editor)
            startAtEnd(editor, row.kind)
            editor.key('Mod-z')
            takeBackIfLeft(editor)
            expect(editor.text()).toBe(row.after)
        })
    }

    it('Mod+Y of typing at the end of the text puts it back there, not on the new line (EtherPK)', () => {
        const editor = open('Some notes|')
        editor.type('!')
        editor.key('Mod-z')
        startAtEnd(editor, 'line')
        editor.key('Mod-y')
        takeBackIfLeft(editor)
        expect(editor.text()).toBe('Some notes!')
    })

    it('once anything is typed on the line, it stays when the caret leaves (EtherPK)', () => {
        const editor = open('Some no|tes')
        startAtEnd(editor, 'line')
        editor.type('x')
        select(editor, 0)
        expect(editor.fixture()).toBe('|Some notes\n\nx')
    })

    it('neither the press nor taking it back is a step in the undo history (EtherPK)', () => {
        const editor = open('Some notes|')
        editor.type('!')
        const depth = undoDepth(editor.state)
        startAtEnd(editor, 'line')
        expect(undoDepth(editor.state)).toBe(depth)
        select(editor, 0)
        expect(undoDepth(editor.state)).toBe(depth)
        editor.key('Mod-z')
        expect(editor.text()).toBe('Some notes')
    })

    // The history's own transaction skips transaction filters, so the editor takes the line back in
    // the transaction after it (`takeBackIfLeft`, which a view plugin calls after every update).
    it('Mod+Z on the untouched line undoes the edit before it, and the line is taken back after it (EtherPK)', () => {
        const editor = open('Some notes|')
        editor.type('!')
        startAtEnd(editor, 'line')
        editor.key('Mod-z')
        expect(editor.text()).toBe('Some notes\n\n')
        takeBackIfLeft(editor)
        expect(editor.fixture()).toBe('Some notes|')
    })

    it('leaves a line the caret is still on alone when asked after an update (EtherPK)', () => {
        const editor = open('Some no|tes')
        startAtEnd(editor, 'line')
        takeBackIfLeft(editor)
        expect(editor.fixture()).toBe('Some notes\n\n|')
    })

    it('pressing again, or the other button, starts afresh rather than adding to the untouched line (EtherPK)', () => {
        const editor = open('Some no|tes')
        startAtEnd(editor, 'line')
        startAtEnd(editor, 'line')
        expect(editor.fixture()).toBe('Some notes\n\n|')
        startAtEnd(editor, 'bullet')
        expect(editor.fixture()).toBe('Some notes\n\n- |')
        select(editor, 0)
        expect(editor.fixture()).toBe('|Some notes')
    })

    it('a bullet an inline panel opens on is kept, as an Agent Chat opened there holds it (EtherPK)', () => {
        const editor = open('- Gar|den')
        startAtEnd(editor, 'bullet')
        editor.dispatch(editor.state.update({ effects: addInlinePanel.of({ id: 1, lineStart: editor.state.doc.line(2).from, mode: 'line' }) }))
        expect(editor.fixture()).toBe('- Garden|\n- ')
        select(editor, 0)
        editor.dispatch(editor.state.update({ effects: removeInlinePanel.of(1) }))
        select(editor, 4)
        expect(editor.fixture()).toBe('- Ga|rden\n- ')
    })

    it('the press and the take-back are placements, which a Draft takes in without being created (EtherPK)', () => {
        const editor = open('Some no|tes')
        const edits: boolean[] = []
        const dispatch = editor.dispatch
        editor.dispatch = (tr) => {
            if (tr.docChanged) edits.push(isEdit(tr))
            dispatch(tr)
        }
        startAtEnd(editor, 'line')
        // A caret the app places, with no user event of its own: the take-back adds none either.
        editor.dispatch(editor.state.update({ selection: { anchor: 0 } }))
        expect(editor.text()).toBe('Some notes')
        expect(edits).toEqual([false, false])
    })
})

// A paste at the end of a delimiter line (a fence's opener or closer, or a frontmatter `---`) starts on
// the line Enter there would open (Editor Content Rules → Pasting into a block). Joined onto the
// delimiter, the first pasted line was an info string: a closer with one is no longer a closer, and
// the block ran on into the text below. After a closer or a frontmatter `---` that holds for a single
// line too, since they take no text; after a fence's opener a single line is typed text, as everywhere
// else in the paste rules, so a language pasted there is still its info string.
describe('a paste at the end of a delimiter line starts on the line Enter would open', () => {
    const rows: { rule: string; precedent: Rule['precedent']; before: string; text: string; plain?: boolean; after: string }[] = [
        { rule: 'after a bullet’s closer, the lines are blocks from a new sibling', precedent: 'EtherPK', before: '- a\n  ```\n  x\n  ```|\n- c', text: 'one\ntwo', after: '- a\n  ```\n  x\n  ```\n- one\n- two|\n- c' },
        { rule: '…after a form-1 closer too', precedent: 'EtherPK', before: '- ```\n  x\n  ```|\n- c', text: 'one\ntwo', after: '- ```\n  x\n  ```\n- one\n- two|\n- c' },
        { rule: '…at the closing bullet’s depth', precedent: 'EtherPK', before: '- a\n  - ```\n    x\n    ```|', text: 'one\ntwo', after: '- a\n  - ```\n    x\n    ```\n  - one\n  - two|' },
        { rule: 'pasted bullets keep their own nesting', precedent: 'EtherPK', before: '- ```\n  x\n  ```|', text: '- one\n  - two', after: '- ```\n  x\n  ```\n- one\n  - two|' },
        { rule: 'a Plain Paste keeps its lines in the new block', precedent: 'EtherPK', before: '- ```\n  x\n  ```|', text: 'one\ntwo', plain: true, after: '- ```\n  x\n  ```\n- one\n  two|' },
        { rule: 'after a prose closer, the lines are prose', precedent: 'EtherPK', before: '```\nx\n```|\nafter', text: 'one\ntwo', after: '```\nx\n```\none\ntwo|\nafter' },
        { rule: '…a copied tree starting at the top level', precedent: 'EtherPK', before: '```\nx\n```|', text: '    - one\n      - two', after: '```\nx\n```\n- one\n  - two|' },
        { rule: 'spaces after the closer are dropped with it', precedent: 'EtherPK', before: '```\nx\n``` |', text: 'one\ntwo', after: '```\nx\n```\none\ntwo|' },
        { rule: 'after an opener, the lines are the first code lines, at the fence column', precedent: 'EtherPK', before: '- ```py|\n  x\n  ```', text: 'one\ntwo', after: '- ```py\n  one\n  two|\n  x\n  ```' },
        { rule: '…after a form-2 opener too', precedent: 'EtherPK', before: '- a\n  ```py|\n  x\n  ```', text: 'one\ntwo', after: '- a\n  ```py\n  one\n  two|\n  x\n  ```' },
        { rule: '…and a prose opener, the code keeping its spaces', precedent: 'EtherPK', before: '```|\nx\n```', text: 'one  \n  two', after: '```\none  \n  two|\nx\n```' },
        { rule: 'a single line after an opener is its info string, as typed', precedent: 'CommonMark', before: '- ```py|\n  x\n  ```', text: 'thon', after: '- ```python|\n  x\n  ```' },
        { rule: 'a single line after a closer starts on the next line too: a closer cannot take text', precedent: 'EtherPK', before: '- Garden\n  - ```\n    x\n    ```|\n  - Kitchen', text: 'water the beans', after: '- Garden\n  - ```\n    x\n    ```\n  - water the beans|\n  - Kitchen' },
        { rule: '…a single bullet line too', precedent: 'EtherPK', before: '- ```\n  x\n  ```|', text: '- [ ] weed', after: '- ```\n  x\n  ```\n- [ ] weed|' },
        { rule: '…after a prose closer', precedent: 'EtherPK', before: '```\nx\n```|\nafter', text: 'beans', after: '```\nx\n```\nbeans|\nafter' },
        { rule: '…and after the frontmatter’s closer', precedent: 'EtherPK', before: '---\ntitle: T\n---|\n- a', text: 'beans', after: '---\ntitle: T\n---\nbeans|\n- a' },
        { rule: '…and its opener, which takes no info string', precedent: 'EtherPK', before: '---|\ntitle: T\n---', text: 'tags: x', after: '---\ntags: x|\ntitle: T\n---' },
        { rule: 'after the frontmatter’s closer, the lines are body text', precedent: 'EtherPK', before: '---\ntitle: T\n---|\n- a', text: 'one\ntwo', after: '---\ntitle: T\n---\none\ntwo|\n- a' },
        { rule: 'after the frontmatter’s opener, the lines are YAML', precedent: 'EtherPK', before: '---|\ntitle: T\n---', text: 'tags: x\nkind: y', after: '---\ntags: x\nkind: y|\ntitle: T\n---' },
        { rule: 'a fence line inside another block’s code is code: the paste is clamped there', precedent: 'CommonMark', before: '````\n```|\nx\n````', text: 'one\ntwo', after: '````\n```one\ntwo|\nx\n````' },
        { rule: 'after the closer of a block with children, the lines are its first children, as Enter at the end of a body makes one', precedent: 'Logseq', before: '- a\n  ```\n  x\n  ```|\n  - kid', text: 'one\ntwo', after: '- a\n  ```\n  x\n  ```\n  - one\n  - two|\n  - kid' },
        { rule: 'text that starts with a line break takes that break as the Enter', precedent: 'EtherPK', before: '- ```\n  x\n  ```|', text: '\none', after: '- ```\n  x\n  ```\n- one|' },
        { rule: '…after a prose closer too', precedent: 'EtherPK', before: '```\nx\n```|', text: '\none\ntwo', after: '```\nx\n```\none\ntwo|' },
        { rule: '…and after an opener', precedent: 'EtherPK', before: '```|\nx\n```', text: '\none', after: '```\none|\nx\n```' },
    ]
    for (const row of rows) {
        it(`${row.rule} (${row.precedent})`, () => {
            const editor = editorFixture(row.before)
            editor.paste(row.text, row.plain ? PLAIN_PASTE_USER_EVENT : 'input.paste')
            expect(editor.fixture()).toBe(row.after)
        })
    }
})

// A line copied with nothing selected pastes as a whole line above the caret's line, the caret staying
// where it was (VS Code; CodeMirror's line-wise copy and paste). Inserted as typed text at the start
// of a bullet's line, its marker landed after the copied text (`c- b`). In an outline the copied line
// is a block above the caret's block, at its depth, as a pasted line is a block; in code it is code.
describe('a line copied with nothing selected pastes as a whole line above the caret’s line', () => {
    const rows: { rule: string; precedent: Rule['precedent']; before: string; line: string; after: string }[] = [
        { rule: 'a copied bullet lands above the caret’s block', precedent: 'VS Code', before: '- a\n- b|', line: '- c', after: '- a\n- c\n- b|' },
        { rule: '…at the depth of the caret’s block', precedent: 'EtherPK', before: '- a\n  - b|', line: '- c', after: '- a\n  - c\n  - b|' },
        { rule: '…whatever depth it was copied at', precedent: 'EtherPK', before: '- a\n- b|', line: '    - c', after: '- a\n- c\n- b|' },
        { rule: 'from a continuation line it lands above the block, never inside it', precedent: 'EtherPK', before: '- a\n  soft|\n- b', line: '- c', after: '- c\n- a\n  soft|\n- b' },
        { rule: 'a copied task keeps its own checkbox', precedent: 'EtherPK', before: '- [ ] a\n- b|', line: '- [x] c', after: '- [ ] a\n- [x] c\n- b|' },
        { rule: 'a copied prose line becomes a block, as a pasted line does', precedent: 'EtherPK', before: '- a\n- b|', line: 'prose', after: '- a\n- prose\n- b|' },
        { rule: 'its trailing spaces are dropped', precedent: 'EtherPK', before: '- a\n- b|', line: '- c  ', after: '- a\n- c\n- b|' },
        { rule: 'on a form-1 opener it lands above the bullet', precedent: 'EtherPK', before: '- ```py|\n  x\n  ```', line: '- c', after: '- c\n- ```py|\n  x\n  ```' },
        { rule: 'in code it is a code line, as copied', precedent: 'VS Code', before: '- ```\n  x|\n  ```', line: '  y  ', after: '- ```\n  y  \n  x|\n  ```' },
        { rule: '…moved right to the fence column if it is short of it', precedent: 'EtherPK', before: '- ```\n  x|\n  ```', line: '- c', after: '- ```\n  - c\n  x|\n  ```' },
        { rule: 'on the closer it is the last code line', precedent: 'VS Code', before: '- ```\n  x\n  ```|', line: 'y', after: '- ```\n  x\n  y\n  ```|' },
        { rule: 'in prose, a copied tree starts at the top level', precedent: 'EtherPK', before: 'p\nq|', line: '    - c', after: 'p\n- c\nq|' },
        { rule: 'in the frontmatter it is YAML, as copied', precedent: 'VS Code', before: '---\ntitle: T|\n---', line: 'tags: x', after: '---\ntags: x\ntitle: T|\n---' },
        { rule: 'on the frontmatter’s opening line it is the first YAML line, so the frontmatter still opens', precedent: 'EtherPK', before: '---|\ntitle: T\n---\n- a', line: 'tags: x', after: '---|\ntags: x\ntitle: T\n---\n- a' },
        { rule: 'a tab in a copied code line is the code’s own: the spaces go before it', precedent: 'EtherPK', before: '- ```\n  x|\n  ```', line: '\tz', after: '- ```\n  \tz\n  x|\n  ```' },
        { rule: 'a copied empty line is an empty block: a bare empty line there would cut the group', precedent: 'EtherPK', before: '- a\n  - b|', line: '', after: '- a\n  - \n  - b|' },
    ]
    for (const row of rows) {
        it(`${row.rule} (${row.precedent})`, () => {
            const editor = editorFixture(row.before)
            editor.pasteLine(row.line)
            expect(editor.fixture()).toBe(row.after)
        })
    }
})

// Text pasted on a line of its own becomes the fence an extension claims it for: the first Hook, a
// fence registration's `fromPaste` (Editor Content Rules → Pasting into a block). A garden link is
// claimed as its one line, trimmed, and copied beds as one line each, kept as written. A Plain Paste
// never reaches this route, so the text stays text (Logseq): the route order is asserted in
// editor-extensions.test.ts and pressed for real in tests-client/plain-paste.test.ts.
describe('pasting text an extension claims', () => {
    const link = 'https://garden.example/plot'
    const beds = 'garden-beds: north, south'
    const fence: InteractiveFence = {
        height: () => 100,
        mount: () => ({ update: () => {}, destroy: () => {} }),
        fromPaste: (text) => {
            if (text.trim().startsWith('https://garden.example/')) return [text.trim()]
            if (!text.startsWith('garden-beds:')) return null
            return text
                .replace(/^garden-beds: ?/, '')
                .split(/\r?\n|, /)
                .filter((line) => line !== '')
        },
    }
    beforeEach(() => {
        const registry = createContributionRegistry()
        registerInteractiveFence(registry, 'garden', fence)
        setActiveContributionRegistry(registry)
    })
    afterEach(() => setActiveContributionRegistry(null))

    const rows: { rule: string; precedent: Rule['precedent']; before: string; text: string; after: string }[] = [
        { rule: 'alone on an empty line, a link becomes the fence holding it, the caret on the line after', precedent: 'Logseq', before: 'Intro\n|\nAfter', text: link, after: `Intro\n\`\`\`garden\n${link}\n\`\`\`\n|After` },
        { rule: 'text the extension reads as several lines becomes a fence of those lines', precedent: 'EtherPK', before: 'Intro\n|\nAfter', text: beds, after: 'Intro\n```garden\nnorth\nsouth\n```\n|After' },
        { rule: 'on an empty bullet, the fence opens beside its dot', precedent: 'Logseq', before: '- Intro\n- |\n- After', text: link, after: `- Intro\n- \`\`\`garden\n  ${link}\n  \`\`\`\n- |After` },
        { rule: 'inside text, it stays as pasted', precedent: 'Logseq', before: 'Intro\nSee |\nAfter', text: link, after: `Intro\nSee ${link}|\nAfter` },
        { rule: 'text no extension claims stays as pasted', precedent: 'EtherPK', before: 'Intro\n|\nAfter', text: 'https://example.com/garden', after: 'Intro\nhttps://example.com/garden|\nAfter' },
        { rule: 'on the last line, a link copied with its line break becomes the fence, the caret on the line before as /video leaves it', precedent: 'EtherPK', before: 'Intro\n|', text: `${link}\n`, after: `Intro|\n\`\`\`garden\n${link}\n\`\`\`` },
        { rule: 'with a block below, the caret waits on the line before, never on the block', precedent: 'EtherPK', before: 'Intro\n|\n```js\nx\n```', text: 'garden-beds: north\nsouth', after: 'Intro|\n```garden\nnorth\nsouth\n```\n```js\nx\n```' },
        { rule: 'on the last bullet, text of several lines becomes the fence beside its dot, the caret on the line before', precedent: 'EtherPK', before: '- Intro\n- |', text: 'garden-beds: north\nsouth', after: '- Intro|\n- ```garden\n  north\n  south\n  ```' },
        { rule: 'the lines below the caret stay as they were', precedent: 'EtherPK', before: '- |\n  - child\n  closing words\n- After', text: 'garden-beds: north\nsouth', after: '- ```garden\n  north\n  south\n  ```\n  - |child\n  closing words\n- After' },
        { rule: 'on a soft line of a bullet, the fence stays in the bullet at the line’s indentation', precedent: 'EtherPK', before: '- Garden\n  |\n- After', text: link, after: `- Garden\n  \`\`\`garden\n  ${link}\n  \`\`\`\n- |After` },
        { rule: 'the lines the extension gave are kept as it gave them, never reshaped as a paste is', precedent: 'EtherPK', before: 'Intro\n|\nAfter', text: 'garden-beds:\n  - north\n  - south', after: 'Intro\n```garden\n  - north\n  - south\n```\n|After' },
    ]
    for (const row of rows) {
        it(`${row.rule} (${row.precedent})`, () => {
            const editor = editorFixture(row.before)
            if (!pasteAsFence(editor, row.text)) editor.paste(row.text)
            expect(editor.fixture()).toBe(row.after)
        })
    }

    it('Mod+Z straight after gives back the text that was pasted, caret and all, as an autoformat is undone (EtherPK)', () => {
        const editor = editorFixture('Intro\n|\nAfter')
        pasteAsFence(editor, beds)
        editor.key('Mod-z')
        expect(editor.fixture()).toBe(`Intro\n${beds}|\nAfter`)
        // Windows line breaks are one line break each in the editor.
        const crlf = editorFixture('Intro\n|\nAfter')
        pasteAsFence(crlf, 'garden-beds: north\r\nsouth')
        expect(crlf.text()).toBe('Intro\n```garden\nnorth\nsouth\n```\nAfter')
        crlf.key('Mod-z')
        expect(crlf.fixture()).toBe('Intro\ngarden-beds: north\nsouth|\nAfter')
    })
})

// Interactive fences (Editor Content Rules → Interactive fences, ADR 0121): a fence is drawn as its
// widget for as long as an extension draws its info word, so switching that extension off shows the
// fence as its text at once, and switching it on draws the widget again, with no edit in between.
describe('an interactive fence follows its widget’s registration (EtherPK)', () => {
    const widget: InteractiveFence = { height: () => 320, mount: () => ({ update: () => {}, destroy: () => {} }) }
    let registry: ReturnType<typeof createContributionRegistry>
    beforeEach(() => {
        registry = createContributionRegistry()
        setActiveContributionRegistry(registry)
    })
    afterEach(() => setActiveContributionRegistry(null))

    const map = '```map\nGarden @ 50.7, -1.0\n```'
    const doc = `Intro\n\n${map}\n\nAfter|`
    /** The transactions the registry sent an editor, to see what each carried. */
    let sent: Transaction[] = []
    /** An editor over `text` that hears the registry as an open editor does. */
    const open = (text = doc) => {
        const editor = editorFixture(text, { extensions: [interactiveFenceAugmentation()] })
        sent = []
        followFenceRegistrations(registry, {
            get state() {
                return editor.state
            },
            dispatch(tr) {
                sent.push(tr)
                editor.dispatch(tr)
            },
        })
        return editor
    }
    /** The editor is told on a microtask, once whatever registered has finished. */
    const told = () => new Promise((resolve) => setTimeout(resolve, 0))
    /** The blocks the editor draws as a widget: each block-replacing decoration, as its lines. */
    const drawn = (editor: ReturnType<typeof open>) => {
        const out: string[] = []
        for (const source of editor.state.facet(EditorView.decorations)) {
            if (typeof source === 'function') continue
            source.between(0, editor.state.doc.length, (from, to, value) => {
                if (value.spec.block) out.push(editor.state.sliceDoc(from, to))
            })
        }
        return out
    }

    it('draws a fence as its widget once one is registered for its word', async () => {
        const editor = open()
        expect(drawn(editor)).toEqual([])
        registerInteractiveFence(registry, 'map', widget)
        await told()
        expect(drawn(editor)).toEqual([map])
        expect(editor.fixture()).toBe(doc)
        // No caret move: nothing that follows the caret (a completion menu, the undo grouping) hears one.
        expect(sent.map((tr) => tr.selection)).toEqual([undefined])
    })

    it('shows the fence as its text once its widget is withdrawn', async () => {
        const withdraw = registerInteractiveFence(registry, 'map', widget)
        const editor = open()
        expect(drawn(editor)).toHaveLength(1)
        withdraw()
        await told()
        expect(drawn(editor)).toEqual([])
        expect(editor.fixture()).toBe(doc)
    })

    it('keeps a fence the caret is inside as its text until the caret leaves it', async () => {
        const inside = `Intro\n\n\`\`\`map\nGarden |@ 50.7, -1.0\n\`\`\`\n\nAfter`
        const editor = open(inside)
        registerInteractiveFence(registry, 'map', widget)
        await told()
        expect(drawn(editor)).toEqual([])
        editor.type('X')
        expect(editor.fixture()).toBe(`Intro\n\n\`\`\`map\nGarden X|@ 50.7, -1.0\n\`\`\`\n\nAfter`)
        editor.dispatch(editor.state.update({ selection: { anchor: editor.state.doc.length } }))
        expect(drawn(editor)).toEqual(['```map\nGarden X@ 50.7, -1.0\n```'])
    })

    it('leaves the caret where it was when a widget is registered or withdrawn', async () => {
        const nested = '- Place\n  |```map\n  Garden @ 50.7, -1.0\n  ```\n- After'
        const editor = open(nested)
        const withdraw = registerInteractiveFence(registry, 'map', widget)
        await told()
        withdraw()
        await told()
        expect(editor.fixture()).toBe(nested)
    })

    it('stops hearing the registry once the editor is taken down', async () => {
        const editor = editorFixture(doc, { extensions: [interactiveFenceAugmentation()] })
        const stop = followFenceRegistrations(registry, editor)
        stop()
        registerInteractiveFence(registry, 'map', widget)
        await told()
        // Nothing told it, so it draws nothing until a transaction of its own reads the fences again.
        expect(drawn(editor)).toEqual([])
    })
})

// A [[Template]] lands as a paste does (Editor Content Rules → Inserting a Template, ADR 0144): the
// paste rules place it, so a Template and a pasted outline land alike. `{{cursor}}` puts the caret.
describe('inserting a Template', () => {
    const context = { day: '2026-10-14', now: new Date(2026, 9, 14, 9, 30), title: 'Garden' }
    const rows: { rule: string; precedent: Rule['precedent']; before: string; body: string; after: string }[] = [
        { rule: 'on an empty bullet, the first block takes the bullet', precedent: 'Logseq', before: '- Garden\n- |', body: '- Review\n  - [ ] water the beans', after: '- Garden\n- Review\n  - [ ] water the beans|' },
        { rule: 'on a bullet with text, the Template nests under it, as a pasted outline does', precedent: 'EtherPK', before: '- Garden|', body: '- Review\n  - beans', after: '- Garden\n  - Review\n    - beans|' },
        { rule: 'a Template of one plain line is typed in at the caret', precedent: 'EtherPK', before: '- Met |today', body: 'the Kitchen team ', after: '- Met the Kitchen team |today' },
        { rule: 'on an empty prose line, an outline starts at the margin', precedent: 'EtherPK', before: 'Intro\n|', body: '- Review\n  - beans', after: 'Intro\n- Review\n  - beans|' },
        { rule: 'after prose on the same line, an outline starts on a line of its own', precedent: 'EtherPK', before: 'Intro|', body: '- Review\n  - beans', after: 'Intro\n- Review\n  - beans|' },
        { rule: 'the variables are filled in', precedent: 'Logseq', before: '- |', body: '- [[{{date}}]] in [[{{title}}]]', after: '- [[2026-10-14]] in [[Garden]]|' },
        { rule: '{{cursor}} puts the caret where it stood', precedent: 'AS Notes', before: '- |', body: '- Notes: {{cursor}}\n- Tasks', after: '- Notes: |\n- Tasks' },
        { rule: '{{cursor}} on an empty bullet of the Template puts the caret on it', precedent: 'EtherPK', before: '- |', body: '- Notes\n  - {{cursor}}\n- Tasks', after: '- Notes\n  - |\n- Tasks' },
        { rule: '{{cursor}} before a bullet’s marker puts the caret after it', precedent: 'EtherPK', before: '- |', body: '- Notes\n{{cursor}}- Tasks', after: '- Notes\n- |Tasks' },
        { rule: 'a Template that starts with prose lands as the next block, as Enter would put it', precedent: 'EtherPK', before: '- Garden|', body: 'Notes\n- a', after: '- Garden\n- Notes\n  - a|' },
        { rule: 'with the caret inside a line, the rest of the line follows the Template’s last line, as after a paste', precedent: 'EtherPK', before: '- Met |today', body: '- Review\n  - beans', after: '- Met\n  - Review\n    - beans|today' },
        { rule: 'a fence opened on the Template’s bullet stays a fence', precedent: 'EtherPK', before: '- Garden\n- |', body: '- ```js\n  x\n  ```', after: '- Garden\n- ```js\n  x\n  ```|' },
        { rule: 'a fence under the Template’s bullet stays a fence', precedent: 'EtherPK', before: '- Garden\n- |', body: '- Code\n  ```js\n  x\n  ```', after: '- Garden\n- Code\n  ```js\n  x\n  ```|' },
        { rule: '{{cursor}} inside a fence puts the caret on its code line', precedent: 'EtherPK', before: '- Garden\n- |', body: '- ```js\n  {{cursor}}\n  ```', after: '- Garden\n- ```js\n  |\n  ```' },
        { rule: '{{cursor}} on a fence’s opening line leaves the fence whole and the caret at the end', precedent: 'EtherPK', before: '- Garden\n- |', body: '{{cursor}}- ```js\n  x\n  ```', after: '- Garden\n- ```js\n  x\n  ```|' },
        { rule: '{{cursor}} on a fence’s closing line leaves the fence whole', precedent: 'EtherPK', before: '- Garden\n- |', body: '- ```js\n  x\n  ```{{cursor}}', after: '- Garden\n- ```js\n  x\n  ```|' },
        { rule: 'in an outline, {{cursor}} alone on a line puts the caret at the end of the line above, as a blank line is dropped', precedent: 'EtherPK', before: '- |', body: '- Notes\n{{cursor}}\n- Later', after: '- Notes|\n- Later' },
        { rule: '{{cursor}} on a line of its own in prose leaves an empty line to type on', precedent: 'EtherPK', before: '|', body: '# Notes\n{{cursor}}\n# Later', after: '# Notes\n|\n# Later' },
        { rule: 'Windows line endings are read as line breaks', precedent: 'EtherPK', before: '- Garden\n- |', body: '- a\r\n  - {{cursor}}\r\n- c', after: '- Garden\n- a\n  - |\n- c' },
        { rule: 'a private-use character the Template holds is kept, and the caret still goes to {{cursor}}', precedent: 'EtherPK', before: '- |', body: '- \uE000 icon {{cursor}}', after: '- \uE000 icon |' },
        { rule: 'after a bullet’s closing fence, the Template starts on the next block, as a paste does', precedent: 'EtherPK', before: '- a\n  ```\n  x\n  ```|\n- c', body: '- Notes:  \n- Tasks', after: '- a\n  ```\n  x\n  ```\n- Notes:  \n- Tasks|\n- c' },
        { rule: 'after an opening fence, the Template is the first code', precedent: 'EtherPK', before: '- ```py|\n  x\n  ```', body: 'one\ntwo', after: '- ```py\n  one\n  two|\n  x\n  ```' },
        { rule: 'after a prose closing fence, the Template is prose on the next line', precedent: 'EtherPK', before: '```\nx\n```|', body: 'one\ntwo', after: '```\nx\n```\none\ntwo|' },
        { rule: 'over selected blocks, the Template replaces them', precedent: 'EtherPK', before: '«- Old\n  - child»\n- Next', body: '- Review\n  - beans', after: '- Review\n  - beans|\n- Next' },
    ]
    for (const row of rows) {
        it(`${row.rule} (${row.precedent})`, () => {
            const editor = editorFixture(row.before)
            insertTemplate(editor, renderTemplate(row.body, context))
            expect(editor.fixture()).toBe(row.after)
        })
    }

    it('typing straight after a Template is an undo step of its own, and Mod+Y puts the Template back (EtherPK)', () => {
        const editor = editorFixture('- Garden\n- |')
        insertTemplate(editor, renderTemplate('- Notes: {{cursor}}\n- Tasks', context))
        editor.type('x')
        editor.key('Mod-z')
        expect(editor.fixture()).toBe('- Garden\n- Notes: |\n- Tasks')
        editor.key('Mod-z')
        expect(editor.text()).toBe('- Garden\n- ')
        editor.key('Mod-y')
        expect(editor.text()).toBe('- Garden\n- Notes: \n- Tasks')
    })

    it('Mod+Z straight after takes the whole Template out in one step (EtherPK)', () => {
        const editor = editorFixture('- Garden\n- |')
        insertTemplate(editor, renderTemplate('- Notes: {{cursor}}\n  - beans\n- Tasks', context))
        editor.key('Mod-z')
        expect(editor.fixture()).toBe('- Garden\n- |')
    })
})

describe('a bookmark follows its line (ADR 0160)', () => {
    /** The marked line's text after `key`, from a fixture whose 1-based line 2 is bookmarked. */
    function markedAfter(fixture: string, key: string): string[] {
        const editor = editorFixture(fixture, { extensions: [bookmarkMarks()] })
        const lines = editor.text().split('\n')
        const bookmark = { id: 'b', concept: 'Garden', createdAt: 1, ...captureAnchor(lines, 1)! }
        editor.dispatch(editor.state.update({ effects: syncBookmarkMarks.of([bookmark]) }))
        editor.key(key)
        return bookmarkedLines(editor.state).map(({ line }) => editor.state.doc.line(line).text)
    }
    const rows: Array<Omit<Rule, 'after'> & { marked: string[] }> = [
        { rule: 'Enter above it moves it down with its line', precedent: 'VS Code', before: '- water the beans|\n- dig the bed', key: 'Enter', marked: ['- dig the bed'] },
        { rule: 'Enter at the start of its words takes it down with them', precedent: 'VS Code', before: '- water the beans\n- |dig the bed', key: 'Enter', marked: ['- dig the bed'] },
        { rule: 'Tab on it keeps it on its line', precedent: 'VS Code', before: '- water the beans\n- dig the bed|', key: 'Tab', marked: ['  - dig the bed'] },
        { rule: 'Alt+Up carries it with its block', precedent: 'VS Code', before: '- water the beans\n- dig the bed|', key: 'Alt-ArrowUp', marked: ['- dig the bed'] },
        { rule: 'Alt+Down on the prose line above carries it with its own line', precedent: 'VS Code', before: 'water the beans|\ndig the bed\nfeed the hens', key: 'Alt-ArrowDown', marked: ['dig the bed'] },
        { rule: 'Backspace joining its line upward carries it to the joined line', precedent: 'EtherPK', before: 'water the beans\n|dig the bed', key: 'Backspace', marked: ['water the beansdig the bed'] },
        { rule: 'deleting the whole line, line break included, removes it', precedent: 'EtherPK', before: '- water the beans\n«- dig the bed\n»- feed the hens', key: 'Backspace', marked: [] },
        { rule: 'typing over its words keeps it', precedent: 'VS Code', before: '- water the beans\n- «dig the bed»', key: 'Backspace', marked: ['- '] },
    ]
    for (const row of rows) {
        it(`${row.key}: ${row.rule} (${row.precedent})`, () => {
            expect(markedAfter(row.before, row.key)).toEqual(row.marked)
        })
    }
    // Two keys: the line's words cleared, then the empty line itself joined away, up or down.
    for (const key of ['Backspace', 'Delete']) {
        it(`Backspace then ${key}: a line whose words were cleared goes when it is joined away (EtherPK)`, () => {
            expect(markedAfter('water the beans\n«dig the bed»\nfeed the hens', 'Backspace')).toEqual([''])
            const editor = editorFixture('water the beans\n«dig the bed»\nfeed the hens', { extensions: [bookmarkMarks()] })
            const bookmark = { id: 'b', concept: 'Garden', createdAt: 1, ...captureAnchor(editor.text().split('\n'), 1)! }
            editor.dispatch(editor.state.update({ effects: syncBookmarkMarks.of([bookmark]) }))
            editor.key('Backspace')
            editor.key(key)
            expect(bookmarkedLines(editor.state)).toEqual([])
        })
    }
})
