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

import { describe, expect, it } from 'vitest'
import { showTooltip } from '@codemirror/view'

import { hiddenSyntax, revealStateOf } from './augmentations/base-renderer'
import { markdownWithCodeHighlight } from './augmentations/code-highlight'
import { formatDecorations, RULE_LINE_CLASS } from './augmentations/markdown-format'
import { guideThreadsFor } from './augmentations/outline-guides'
import { wikilinkCompletion } from './augmentations/wikilink-complete'
import { editorFixture, press } from './testing/editor-state-fixture'
import { wikilinkButtonSpec } from './wrap-selection'

interface Rule {
    rule: string
    /** Which editor the behaviour is borrowed from, so a reviewer has a reference to check against. */
    precedent: 'Logseq' | 'Obsidian' | 'VS Code' | 'CommonMark' | 'EtherPK'
    before: string
    key: string
    after: string
}

function table(name: string, rows: Rule[]) {
    describe(name, () => {
        for (const row of rows) {
            it(`${row.key}: ${row.rule} (${row.precedent})`, () => {
                expect(press(row.before, row.key)).toBe(row.after)
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

table('prose is deliberately boring', [
    { rule: 'Enter is a plain newline', precedent: 'VS Code', before: 'text|', key: 'Enter', after: 'text\n|' },
    { rule: 'Tab makes the line a block at column 0, caret on the same character', precedent: 'EtherPK', before: 'te|xt', key: 'Tab', after: '- te|xt' },
    { rule: 'Tab on an empty line opens an empty bullet', precedent: 'EtherPK', before: '|', key: 'Tab', after: '- |' },
    { rule: 'Tab on a heading is refused', precedent: 'EtherPK', before: '# h|', key: 'Tab', after: '# h|' },
    { rule: 'Tab on a continuation makes it a child of its bullet', precedent: 'EtherPK', before: '- a\n  te|xt', key: 'Tab', after: '- a\n  - te|xt' },
    { rule: 'Alt+Up is the ordinary line move', precedent: 'VS Code', before: 'one\ntwo|', key: 'Alt-ArrowUp', after: 'two|\none' },
    { rule: 'Alt+Down is the ordinary line move', precedent: 'VS Code', before: 'one|\ntwo', key: 'Alt-ArrowDown', after: 'two\none|' },
    { rule: 'a heading edits as a plain line', precedent: 'Obsidian', before: '# Title|', key: 'Enter', after: '# Title\n|' },
])

// ── Editor Content Rules → Standard prose → Rules and heading underlines ─────────────────────

/**
 * A document as the formatting pass presents it, in text: hidden syntax removed, a line drawn as
 * a rule shown as `────` after whatever of the line stays visible (a bullet's marker), and heading
 * text wrapped in `<hN>…</hN>`. The caret in the fixture decides which lines reveal their source,
 * exactly as in the editor. Presentation, not a key: rows here have `shows` instead of `key`/`after`.
 */
function presented(fixture: string, caret?: string): string {
    const { state } = editorFixture(fixture, { extensions: [markdownWithCodeHighlight()], caret })
    const decorations = formatDecorations(state, 0, state.doc.length, revealStateOf(state))
    const hidden = decorations.filter((d) => d.value === hiddenSyntax)
    const classOf = (d: (typeof decorations)[number]) => (d.value.spec as { class?: string }).class ?? ''
    const ruleLines = new Set(decorations.filter((d) => d.from === d.to && classOf(d).includes(RULE_LINE_CLASS)).map((d) => state.doc.lineAt(d.from).number))
    const headings = decorations
        .filter((d) => d.from < d.to && /cm-md-h\d/.test(classOf(d)))
        .map((d) => ({ from: d.from, to: d.to, tag: classOf(d).match(/h\d/)![0] }))
    const out: string[] = []
    for (let n = 1; n <= state.doc.lines; n++) {
        const line = state.doc.line(n)
        let text = ''
        let open: string | null = null
        for (let pos = line.from; pos < line.to; pos++) {
            if (hidden.some((h) => h.from <= pos && pos < h.to)) continue
            const tag = headings.find((h) => h.from <= pos && pos < h.to)?.tag ?? null
            if (tag !== open) {
                if (open) text += `</${open}>`
                if (tag) text += `<${tag}>`
                open = tag
            }
            text += state.doc.sliceString(pos, pos + 1)
        }
        if (open) text += `</${open}>`
        out.push(ruleLines.has(n) ? `${text}────` : text)
    }
    return out.join('\n')
}

describe('a --- in the body is a rule, or a heading’s underline where markdown says so', () => {
    const rows: { rule: string; precedent: Rule['precedent']; before: string; shows: string; caret?: string }[] = [
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
    ]
    for (const row of rows) {
        it(`${row.rule} (${row.precedent})`, () => {
            expect(presented(row.before, row.caret)).toBe(row.shows)
        })
    }
})

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
    { rule: 'a continuation cannot outdent past its content column', precedent: 'EtherPK', before: '- a\n    x|', key: 'Shift-Tab', after: '- a\n  x|' },
    { rule: 'a continuation at its floor stays put', precedent: 'EtherPK', before: '- a\n  x|', key: 'Shift-Tab', after: '- a\n  x|' },
])

table('Tab and Shift+Tab move every branch of a block selection together, and a range inside one block moves that block', [
    { rule: 'sibling branches nest together, each with its descendants', precedent: 'Logseq', before: '- a\n«- b\n  - c\n- d»', key: 'Tab', after: '- a\n«  - b\n    - c\n  - d»' },
    { rule: 'descendants below the selection travel with their root', precedent: 'Logseq', before: '- a\n«- b\n- c»\n  - d', key: 'Tab', after: '- a\n«  - b\n  - c»\n    - d' },
    { rule: 'branches at different depths each nest under their own previous sibling', precedent: 'Logseq', before: '- a\n  - b\n«  - c\n- d»', key: 'Tab', after: '- a\n  - b\n«    - c\n  - d»' },
    { rule: 'the head’s line does not decide: a first child at the head is no refusal', precedent: 'EtherPK', before: '- a\n«- b\n  - c\n- d\n  - e»', key: 'Tab', after: '- a\n«  - b\n    - c\n  - d\n    - e»' },
    { rule: 'refused as a whole when the first selected branch has no previous sibling', precedent: 'Logseq', before: '«- a\n- b»', key: 'Tab', after: '«- a\n- b»' },
    { rule: 'refused as a whole when any selected branch is a first child', precedent: 'EtherPK', before: '- a\n«  - b\n- c»', key: 'Tab', after: '- a\n«  - b\n- c»' },
    { rule: 'each selected branch lands one unit under its own previous sibling, on any grid', precedent: 'EtherPK', before: '- a\n    - x\n«    - b\n    - c»', key: 'Tab', after: '- a\n    - x\n«      - b\n      - c»' },
    { rule: 'outdent lifts every selected branch one level', precedent: 'Logseq', before: '- a\n«  - b\n    - c\n  - d»', key: 'Shift-Tab', after: '- a\n«- b\n  - c\n- d»' },
    { rule: 'outdent is refused as a whole when a selected branch is at the root', precedent: 'EtherPK', before: '«- a\n  - b\n- c»', key: 'Shift-Tab', after: '«- a\n  - b\n- c»' },
    { rule: 'a block selection whose head reached a fence is still the outliner’s', precedent: 'EtherPK', before: '- a\n«- b\n- c\n  ```\n  x»\n  ```', key: 'Tab', after: '- a\n«  - b\n  - c\n    ```\n    x»\n    ```' },
    { rule: 'a range from a block into its own code nests the block, not the code', precedent: 'Logseq', before: '- a\n- «b\n  ```\n  x»\n  ```', key: 'Tab', after: '- a\n  - «b\n    ```\n    x»\n    ```' },
    { rule: 'a range inside one block, across its continuation, nests the block and stays on its text', precedent: 'Logseq', before: '- a\n- «b\n  soft»', key: 'Tab', after: '- a\n  - «b\n    soft»' },
    { rule: 'a range across a block’s continuation lines alone still moves the block, not a line of it', precedent: 'Logseq', before: '- a\n- b\n  «soft\n  more»', key: 'Tab', after: '- a\n  - b\n    «soft\n    more»' },
    { rule: 'outdent of a range inside one block lifts the block', precedent: 'Logseq', before: '- a\n  - «b\n    soft»', key: 'Shift-Tab', after: '- a\n- «b\n  soft»' },
    { rule: 'a range from a block into its own code is refused whole when the block cannot nest', precedent: 'EtherPK', before: '- «a\n  ```\n  x»\n  ```', key: 'Tab', after: '- «a\n  ```\n  x»\n  ```' },
    { rule: 'a selection across a blank line spans two groups: the second group’s first block has no sibling, so Tab is refused whole', precedent: 'EtherPK', before: '- a\n«- b\n\n- c»', key: 'Tab', after: '- a\n«- b\n\n- c»' },
    { rule: 'across a blank line, Shift+Tab lifts the blocks of both groups and leaves the blank alone', precedent: 'EtherPK', before: '- a\n  - b\n«  - c\n\n  - d»', key: 'Shift-Tab', after: '- a\n  - b\n«- c\n\n- d»' },
    { rule: 'a selection from a nested block to a shallower one lifts each; the block after becomes the last one’s child', precedent: 'Logseq', before: '- a\n  - b\n«    - c\n  - d»\n  - e', key: 'Shift-Tab', after: '- a\n  - b\n«  - c\n- d»\n  - e' },
])

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
    { rule: 'on a fence line the whole owning branch moves, fence included', precedent: 'EtherPK', before: '- a\n- b\n  ```|\n  x\n  ```', key: 'Alt-ArrowUp', after: '- b\n  ```|\n  x\n  ```\n- a' },
    { rule: 'inside code the default line move reorders code lines', precedent: 'VS Code', before: '```\nx\ny|\n```', key: 'Alt-ArrowUp', after: '```\ny|\nx\n```' },
    { rule: 'inside code a move that would cross a fence is consumed', precedent: 'EtherPK', before: '```\nx|\ny\n```', key: 'Alt-ArrowUp', after: '```\nx|\ny\n```' },
    { rule: 'on a prose fence line the move is consumed', precedent: 'EtherPK', before: 'p\n```|\nx\n```', key: 'Alt-ArrowUp', after: 'p\n```|\nx\n```' },
    { rule: 'a prose line never moves up into the closer above it', precedent: 'EtherPK', before: '- a\n  ```\n  ```\np|', key: 'Alt-ArrowUp', after: '- a\n  ```\n  ```\np|' },
    { rule: 'a prose line never moves up into the tree above it', precedent: 'EtherPK', before: '- a\n  - b\np|', key: 'Alt-ArrowUp', after: '- a\n  - b\np|' },
    { rule: 'a prose line never moves down into the tree below it', precedent: 'EtherPK', before: 'p|\n- a\n  - b', key: 'Alt-ArrowDown', after: 'p|\n- a\n  - b' },
    { rule: 'a prose line never moves down into the opener below it', precedent: 'EtherPK', before: 'p|\n```\nx\n```', key: 'Alt-ArrowDown', after: 'p|\n```\nx\n```' },
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
    { rule: 'a within-line selection that takes the top bullet’s marker removes the block and promotes its subtree', precedent: 'EtherPK', before: '«- a»\n  - b\n    - c', key: 'Backspace', after: '- |b\n  - c' },
    { rule: 'a within-line selection that takes a middle bullet’s marker re-flows its children under the block above', precedent: 'EtherPK', before: '- x\n«- a»\n  - b', key: 'Delete', after: '- x\n  - |b' },
    { rule: 'clearing a bullet’s content within the line keeps the block (marker and children stay)', precedent: 'VS Code', before: '- «a»\n  - b', key: 'Backspace', after: '- |\n  - b' },
    { rule: 'taking the marker of the only line leaves an empty document', precedent: 'VS Code', before: '«- a»', key: 'Backspace', after: '|' },
    { rule: 'taking only the marker leaves the content as prose and re-parents the children', precedent: 'EtherPK', before: '«- »a\n  - b\n    - c', key: 'Backspace', after: '|a\n- b\n  - c' },
    { rule: 'taking a nested bullet’s marker leaves a soft line of the parent; its children become the parent’s', precedent: 'EtherPK', before: '- p\n  «- »a\n    - b\n- q', key: 'Backspace', after: '- p\n  |a\n  - b\n- q' },
    { rule: 'a bullet-shaped line inside a fence is code: the delete is the delete', precedent: 'CommonMark', before: '```\n«- x»\n```', key: 'Backspace', after: '```\n|\n```' },
    { rule: 'a bullet-shaped line inside a form-2 fence is code too', precedent: 'CommonMark', before: '- a\n  ```\n  «- x»\n  ```\n  - b', key: 'Backspace', after: '- a\n  ```\n  |\n  ```\n  - b' },
    { rule: 'a YAML list entry in the frontmatter is not a bullet', precedent: 'EtherPK', before: '---\ntags:\n  «- a»\n---\n- b', key: 'Backspace', after: '---\ntags:\n  |\n---\n- b' },
])

describe('cutting blocks heals the survivors (ADR 0021)', () => {
    const cut = (before: string) => {
        const editor = editorFixture(before)
        editor.cut()
        return editor.fixture()
    }
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
})

table('Mod+Shift+Enter cycles the task state', [
    { rule: 'plain bullet becomes an open task', precedent: 'EtherPK', before: '- a|', key: 'Mod-Shift-Enter', after: '- [ ] a|' },
    { rule: 'open task becomes done', precedent: 'EtherPK', before: '- [ ] a|', key: 'Mod-Shift-Enter', after: '- [x] a|' },
    { rule: 'done task becomes a plain bullet', precedent: 'EtherPK', before: '- [x] a|', key: 'Mod-Shift-Enter', after: '- a|' },
    { rule: 'a prose line becomes a task, indentation kept', precedent: 'EtherPK', before: '  text|', key: 'Mod-Shift-Enter', after: '  - [ ] text|' },
    { rule: 'a continuation becomes a child task of its bullet', precedent: 'Logseq', before: '- a\n  text|', key: 'Mod-Shift-Enter', after: '- a\n  - [ ] text|' },
    { rule: 'an over-indented continuation still becomes a child, never an orphan', precedent: 'EtherPK', before: '- a\n      te|xt', key: 'Mod-Shift-Enter', after: '- a\n  - [ ] te|xt' },
    { rule: 'an empty indented line under a bullet becomes a child task', precedent: 'EtherPK', before: '- a\n    |', key: 'Mod-Shift-Enter', after: '- a\n  - [ ] |' },
    { rule: 'a heading is refused', precedent: 'EtherPK', before: '# h|', key: 'Mod-Shift-Enter', after: '# h|' },
    { rule: 'a prose line that split a group re-joins it as a task and the blocks below are healed', precedent: 'EtherPK', before: '- a\n  - b\n|\n    - c', key: 'Mod-Shift-Enter', after: '- a\n  - b\n- [ ] |\n  - c' },
])

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
])

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
    // The replace itself is the block selection's (Editor Content Rules → Selection): the blocks go, the marker heals.
    { rule: 'a block selection is the ordinary replace', precedent: 'EtherPK', before: '- «a\n- b»', key: '*', after: '- *|' },
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
    { rule: 'a phrase, not only a word', precedent: 'Logseq', before: '- see «Desktop CRM» here', key: '[[', after: '- see [[«Desktop CRM»]] here' },
    { rule: 'whitespace at the edges stays outside the brackets', precedent: 'VS Code', before: '- the« fox »jumped', key: '[[', after: '- the [[«fox»]] jumped' },
    { rule: 'a second tap adds a layer, as a third and fourth press of [ would', precedent: 'Logseq', before: '- «fox»', key: '[[ [[', after: '- [[[[«fox»]]]]' },
    { rule: 'a wikilink wraps towards a nested one', precedent: 'Logseq', before: '- «[[Test]]»', key: '[[', after: '- [[«[[Test]]»]]' },
    { rule: 'in a fence the brackets wrap', precedent: 'VS Code', before: '- ```js\n  f(«x»)\n  ```', key: '[[', after: '- ```js\n  f([[«x»]])\n  ```' },
    { rule: 'with nothing selected the button types its brackets', precedent: 'EtherPK', before: '- the fox|', key: '[[', after: '- the fox[[|' },
    { rule: 'and the closing button types its own', precedent: 'EtherPK', before: '- the [[fox|', key: ']]', after: '- the [[fox]]|' },
    { rule: 'a selection of only whitespace is the ordinary replace', precedent: 'EtherPK', before: '- the« »fox', key: '[[', after: '- the[[|fox' },
    { rule: 'a selection across lines is the ordinary replace', precedent: 'EtherPK', before: 'one «two\nthree» four', key: '[[', after: 'one [[| four' },
    { rule: 'a block selection is the ordinary replace', precedent: 'EtherPK', before: '- «a\n- b»', key: '[[', after: '- [[|' },
    { rule: 'in the frontmatter nothing wraps', precedent: 'EtherPK', before: '---\ntitle: «x»\n---\n', key: '[[', after: '---\ntitle: [[|\n---\n' },
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
