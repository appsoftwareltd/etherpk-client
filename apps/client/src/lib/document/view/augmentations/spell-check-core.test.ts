/**
 * What [[Spell Check]] checks and when (ADR 0095). Each case is a sentence of Editor Content Rules
 * → Spell check: prose is checked, and syntax, code, names and metadata are not.
 */

import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { editorAnalysis } from '../analysis/editor-analysis'
import { editorFixture } from '../testing/editor-state-fixture'
import { markdownWithCodeHighlight } from './code-highlight'
import { isProtectedDocumentFacet } from './protected-fence'
import {
    carryUserEdited,
    nextTypingAt,
    scanSpelling,
    spellCheckApplies,
    spellCheckExclusions,
    spellingCandidates,
    userEditedField,
    userHasEdited,
} from './spell-check-core'

/** The editor's own parser and analysis over `doc`, fully parsed. */
function stateOf(doc: string, protectedDocument = false): EditorState {
    const state = EditorState.create({
        doc,
        extensions: [markdownWithCodeHighlight(), editorAnalysis(), isProtectedDocumentFacet.of(() => protectedDocument), userEditedField],
    })
    ensureSyntaxTree(state, state.doc.length, 5000)
    return state
}

/** The excluded text: whole lines as `line N`, spans as the text they cover. */
function excluded(doc: string, from?: number, to?: number): string[] {
    const state = stateOf(doc)
    const { lines, spans } = spellCheckExclusions(state, from, to)
    return [...lines.map((n) => `line ${n}`), ...spans.map((s) => state.sliceDoc(s.from, s.to))]
}

describe('spellCheckExclusions', () => {
    it('leaves prose alone: paragraphs, bullets, headings, quotes, table cells and marks', () => {
        expect(excluded('# A headng\n\n- the quick brwn fox\n  - a chlid\n\n> a quoe')).toEqual([])
        expect(excluded('| Nmae | Age |\n| --- | --- |\n| Sidnye | 4 |')).toEqual([])
        expect(excluded('**bodl** *italc* ~~strk~~ ==hihglight==')).toEqual([])
    })

    it('excludes every line of a fenced code block, fences included, whatever its language', () => {
        expect(excluded('Text\n```js\nconst x = teh\n```\nMore')).toEqual(['line 2', 'line 3', 'line 4'])
        expect(excluded('```mermaid\ngraph TD\n```')).toEqual(['line 1', 'line 2', 'line 3'])
        expect(excluded('- a bullet\n  ```math\n  \\frac{a}{b}\n  ```')).toEqual(['line 2', 'line 3', 'line 4'])
    })

    it('excludes every line of the frontmatter, and nothing below it', () => {
        expect(excluded('---\ntitle: Quantm\ndescription: some prsoe\n---\nBody txet')).toEqual([
            'line 1',
            'line 2',
            'line 3',
            'line 4',
        ])
    })

    it('excludes inline code', () => {
        expect(excluded('run `npm instal` first')).toEqual(['`npm instal`'])
    })

    it("checks what only Lezer calls code: an indented bullet, raw HTML, a tilde fence", () => {
        // The editor's own model has backtick fences and inline code (Editor Content Rules): Lezer
        // reads a deeply indented bullet under a heading as an indented code block, raw HTML as an
        // HTML block, and ~~~ as a fence, and none of those is code here.
        expect(excluded('## Head\n    - a bullt')).toEqual([])
        expect(excluded('<details>\n<summary>Sumary</summary>\nhiden text\n</details>')).toEqual([])
        expect(excluded('~~~\nnot a fnce\n~~~')).toEqual([])
    })

    it('excludes a whole wikilink, a scoped concept included', () => {
        expect(excluded('see [[Quantm Mechanics]] now')).toEqual(['[[Quantm Mechanics]]'])
        expect(excluded('see [[[[Physiks]] Quantm]] now')).toEqual(['[[[[Physiks]] Quantm]]'])
    })

    it("excludes a markdown link's target but checks its label", () => {
        expect(excluded('read [teh guide](https://exmaple.com/gude) today')).toEqual(['https://exmaple.com/gude'])
    })

    it('excludes bare urls, autolinks and file links', () => {
        expect(excluded('go to https://exmaple.com now')).toEqual(['https://exmaple.com'])
        expect(excluded('go to <https://exmaple.com/x> now')).toEqual(['https://exmaple.com/x'])
        expect(excluded('open file:///home/sidney/notse.txt now')).toEqual(['file:///home/sidney/notse.txt'])
    })

    it("checks an image's alt text but not its size hint or its path", () => {
        expect(excluded('![Quartrly chart|300](https://exmaple.com/chart.png)')).toEqual([
            '|300',
            'https://exmaple.com/chart.png',
        ])
        expect(excluded('![Quartrly chart](../assets/chart.a1b2c3d4.png)')).toEqual(['../assets/chart.a1b2c3d4.png'])
    })

    it('excludes a whole asset link, label included: its right-click menu is EtherPK\u2019s own', () => {
        expect(excluded('see [Q3 reprot](../assets/q3-report.5e6f7a8b.pdf) here')).toEqual([
            '[Q3 reprot](../assets/q3-report.5e6f7a8b.pdf)',
        ])
    })

    it("excludes a task's tags but checks its text", () => {
        expect(excluded('- [ ] #P1 #D-2026-07-01 Ship teh release')).toEqual(['#P1 #D-2026-07-01'])
        expect(excluded('- [ ] Ship teh #P1 release')).toEqual([])
    })

    it('excludes inline maths', () => {
        expect(excluded('the area $\\pi r^2$ of it')).toEqual(['$\\pi r^2$'])
    })

    it('returns each excluded range once, merged where constructs overlap', () => {
        // The url sits inside the asset link; the inline code holds a would-be wikilink.
        const state = stateOf('a [x](../assets/f.a1b2c3d4.pdf) and `[[not a link]]` b')
        const { spans } = spellCheckExclusions(state)
        for (let i = 1; i < spans.length; i++) expect(spans[i].from).toBeGreaterThan(spans[i - 1].to)
        expect(spans.map((s) => state.sliceDoc(s.from, s.to))).toEqual(['[x](../assets/f.a1b2c3d4.pdf)', '`[[not a link]]`'])
    })

    it('reports only what lies in the range asked for', () => {
        const doc = 'one `a`\n```\ncode\n```\nthree `b`'
        const secondLineStart = doc.indexOf('```')
        const thirdLineEnd = doc.indexOf('code') + 'code'.length
        expect(excluded(doc, secondLineStart, thirdLineEnd)).toEqual(['line 2', 'line 3'])
    })
})

describe('spellingCandidates', () => {
    /** The candidate words, as the text each covers, with the offsets checked against the doc. */
    function candidates(doc: string, from?: number, to?: number): string[] {
        const state = stateOf(doc)
        return spellingCandidates(state, from, to).map((w) => {
            expect(state.sliceDoc(w.from, w.to)).toBe(w.word)
            return w.word
        })
    }

    it('offers the words of prose and nothing that is excluded', () => {
        expect(candidates('- see [[Quantm]] and `instal` then https://exmaple.com here')).toEqual(['see', 'and', 'then', 'here'])
        expect(candidates('- [ ] #P1 Ship teh release')).toEqual(['Ship', 'teh', 'release'])
        expect(candidates('Text\n```js\nconst mispeled = 1\n```\nMore')).toEqual(['Text', 'More'])
    })

    it('skips an HTML entity: it is syntax, not a word', () => {
        expect(candidates('a&nbsp;wrod &amp; more')).toEqual(['wrod', 'more'])
    })

    it('reads a word inside emphasis, underscores or asterisks, but never a snake_case name', () => {
        expect(candidates('_italc_ and __bodl__ and *strng* but snake_case')).toEqual([
            'italc',
            'and',
            'bodl',
            'and',
            'strng',
            'but',
        ])
    })

    it('offers only the lines of the range asked for', () => {
        const doc = 'frist line\nsecnd line\nthrid line'
        expect(candidates(doc, doc.indexOf('secnd'), doc.indexOf('secnd') + 5)).toEqual(['secnd', 'line'])
    })
})

describe('scanSpelling', () => {
    const BAD = new Set(['teh', 'wrod'])
    /** Verdicts known for every word but `unknownWord`. */
    const verdictFor = (unknownWord?: string) => (word: string) => (word === unknownWord ? undefined : !BAD.has(word))

    function scan(doc: string, typingAt: number | null = null, unknownWord?: string) {
        const state = stateOf(doc)
        const result = scanSpelling(state, [{ from: 0, to: state.doc.length }], verdictFor(unknownWord), typingAt)
        return { misspelt: result.misspelt.map((w) => w.word), unknown: result.unknown }
    }

    it('underlines the misspelt words it has verdicts for', () => {
        expect(scan('teh wrod is here')).toEqual({ misspelt: ['teh', 'wrod'], unknown: [] })
    })

    it('asks about each word it has no verdict for, once', () => {
        expect(scan('teh novel novel', null, 'novel')).toEqual({ misspelt: ['teh'], unknown: ['novel'] })
    })

    it('treats a visible range that splits a line as the whole line, so exclusions still hold', () => {
        // CodeMirror splits visibleRanges at a collapsed replace decoration of 20+ characters (a
        // rendered inline formula), mid-line. The scan must still see the line's exclusions, and
        // report each word once.
        const doc = 'run `npm instal` then $\\frac{a+b}{c} + \\sqrt{x}$ and see [[Quantm Mechanics]] and teh end'
        const state = stateOf(doc)
        const mathFrom = doc.indexOf('$')
        const mathTo = doc.lastIndexOf('$') + 1
        const split = [
            { from: 0, to: mathFrom },
            { from: mathTo, to: doc.length },
        ]
        const result = scanSpelling(state, split, (word) => word !== 'teh', null)
        expect(result.misspelt.map((w) => w.word)).toEqual(['teh'])
        const unknown = scanSpelling(state, split, () => undefined, null).unknown
        expect(unknown).not.toContain('instal')
        expect(unknown).not.toContain('Quantm')
        expect(unknown).not.toContain('frac')
    })

    it('leaves the word being typed alone, at either edge of it', () => {
        const doc = 'teh wrod'
        expect(scan(doc, doc.length).misspelt).toEqual(['teh']) // caret at the end of "wrod"
        expect(scan(doc, 0).misspelt).toEqual(['wrod']) // caret at the start of "teh"
        expect(scan(doc, 4).misspelt).toEqual(['teh']) // caret between the words touches "wrod"
    })
})

describe('nextTypingAt', () => {
    const base = { docChanged: false, typed: false, userEdit: false, carriedTyping: false, selectionSet: false, focusLost: false, caret: { empty: true, head: 10 }, mapPos: (p: number) => p + 3 }

    it('starts at the caret when the user types or deletes', () => {
        expect(nextTypingAt(null, { ...base, docChanged: true, typed: true, userEdit: true })).toBe(10)
    })

    it('ends when the user does anything else: Enter, a paste, a caret move, leaving the editor', () => {
        expect(nextTypingAt(7, { ...base, docChanged: true, userEdit: true })).toBeNull()
        expect(nextTypingAt(7, { ...base, selectionSet: true })).toBeNull()
        expect(nextTypingAt(7, { ...base, focusLost: true })).toBeNull()
    })

    it('survives an edit from elsewhere, moved with the text', () => {
        // A collaborator's change or an external write has no user event: the half-typed word is
        // still being typed, wherever the edit moved it.
        expect(nextTypingAt(7, { ...base, docChanged: true })).toBe(10)
        expect(nextTypingAt(null, { ...base, docChanged: true })).toBeNull()
    })

    it('keeps going when a selection update leaves the caret where it was', () => {
        expect(nextTypingAt(10, { ...base, selectionSet: true })).toBe(10)
    })

    it('ends when an editor command moved the caret off the word, user event or not', () => {
        // The outliner's Enter dispatches with no user event: the caret lands on a new line
        // rather than moving with the text, and the word it left is judged.
        expect(nextTypingAt(7, { ...base, docChanged: true, caret: { empty: true, head: 14 } })).toBeNull()
    })

    it('starts at the caret when a remount carries typing into a new editor', () => {
        // A Draft's first keystroke promotes it and the editor is rebuilt: the word the user was
        // typing in the Draft is still being typed in the page that replaced it.
        expect(nextTypingAt(null, { ...base, carriedTyping: true })).toBe(10)
        expect(nextTypingAt(null, { ...base, carriedTyping: true, caret: { empty: false, head: 10 } })).toBeNull()
    })

    it('is not started by a selection over text', () => {
        expect(nextTypingAt(null, { ...base, docChanged: true, typed: true, userEdit: true, caret: { empty: false, head: 10 } })).toBeNull()
    })
})

/** `state` after the user typed a space at its end. */
function typedInto(state: EditorState, userEvent = 'input.type'): EditorState {
    return state.update({ changes: { from: state.doc.length, insert: ' ' }, userEvent }).state
}

describe('userHasEdited', () => {
    it('is false in an editor just opened, however much text it shows', () => {
        expect(userHasEdited(stateOf('- a wrod already here'))).toBe(false)
    })

    it('turns on at the first change the user makes, by any means', () => {
        for (const event of ['input.type', 'input.type.compose', 'input.paste', 'input.drop', 'input.complete', 'delete.backward', 'undo']) {
            expect(userHasEdited(typedInto(stateOf('prose'), event)), event).toBe(true)
        }
    })

    it('is not turned on by a change from elsewhere, or by a caret move', () => {
        // A collaborator's change, an external write and a file read landing carry no user event.
        const remote = stateOf('prose').update({ changes: { from: 0, insert: 'a wrod ' } }).state
        expect(userHasEdited(remote)).toBe(false)
        const moved = stateOf('prose').update({ selection: { anchor: 2 }, userEvent: 'select' }).state
        expect(userHasEdited(moved)).toBe(false)
    })

    it('stays on for the life of the editor', () => {
        const edited = typedInto(stateOf('prose'))
        expect(userHasEdited(edited.update({ changes: { from: 0, insert: 'x' } }).state)).toBe(true)
    })

    it('is carried into an editor that replaced one the user edited', () => {
        expect(userHasEdited(stateOf('prose').update({ effects: carryUserEdited.of({ typing: false }) }).state)).toBe(true)
    })
})

describe('userHasEdited, through the editor\'s own filters', () => {
    const edited = (fixture: string, act: (ed: ReturnType<typeof editorFixture>) => void) => {
        const ed = editorFixture(fixture, { extensions: [userEditedField] })
        act(ed)
        return userHasEdited(ed.state)
    }

    it('is not turned on by a click that tidies trailing spaces off the line it leaves', () => {
        // leave-tidy adds its trim to the click's own transaction, which then changes the document
        // while carrying only a `select` event.
        const ed = editorFixture('- a wrod  |\n- second', { extensions: [userEditedField] })
        ed.select(ed.state.doc.length)
        expect(ed.text()).toBe('- a wrod\n- second')
        expect(userHasEdited(ed.state)).toBe(false)
    })

    it('is turned on by typing, a paste, a cut, Backspace, a line move and undo', () => {
        expect(edited('- a wrod|', (ed) => ed.type('s'))).toBe(true)
        expect(edited('- a wrod|', (ed) => ed.paste(' more'))).toBe(true)
        expect(edited('- «a wrod»', (ed) => ed.cut())).toBe(true)
        expect(edited('- a wrod|', (ed) => ed.key('Backspace'))).toBe(true)
        expect(edited('- first|\n- second', (ed) => ed.key('Alt-ArrowDown'))).toBe(true)
    })
})

describe('spellCheckApplies', () => {
    it('follows the preference once the user has edited', () => {
        expect(spellCheckApplies(typedInto(stateOf('prose')), true)).toBe(true)
        expect(spellCheckApplies(typedInto(stateOf('prose')), false)).toBe(false)
    })

    it('waits for the first edit: a document opened to read shows no underlines', () => {
        expect(spellCheckApplies(stateOf('prose'), true)).toBe(false)
    })

    it('never applies to a Protected Document, locked or unlocked', () => {
        // Unlocked, the editor shows plaintext with no fence in it, so only the document can say.
        expect(spellCheckApplies(typedInto(stateOf('plaintext of a protected page', true)), true)).toBe(false)
    })
})
