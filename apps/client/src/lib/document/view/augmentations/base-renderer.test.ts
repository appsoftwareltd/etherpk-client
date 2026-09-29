import { EditorState, type Range } from '@codemirror/state'
import { Decoration, WidgetType } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import { editorAnalysis } from '../analysis/editor-analysis'
import { dropPiecesOnCodeLines, hiddenSyntax, hiddenSyntaxPieces, splitMarksAtLineText } from './base-renderer'
import { markdownWithCodeHighlight } from './code-highlight'

const code = Decoration.mark({ class: 'cm-md-code' })
const quoteLine = Decoration.line({ class: 'gk-quote-line' })

class Marker extends WidgetType {
    toDOM(): HTMLElement {
        throw new Error('not drawn in Node')
    }
}
const widget = Decoration.widget({ widget: new Marker(), side: 1 })

/** A parsed state with the shared analysis, the caret at `caret` (the end when omitted). */
function stateOf(doc: string, caret = doc.length): EditorState {
    return EditorState.create({ doc, selection: { anchor: caret }, extensions: [editorAnalysis(), markdownWithCodeHighlight()] })
}

/** Each piece as `[from, to) "text"`, so a row reads as what is covered. */
function covered(state: EditorState, pieces: readonly Range<Decoration>[]): string[] {
    return pieces.map((p) => `[${p.from}, ${p.to}) ${JSON.stringify(state.doc.sliceString(p.from, p.to))}`)
}

describe('splitMarksAtLineText: a mark covers text, never a later line’s structure', () => {
    it('keeps a mark within one line as it is', () => {
        const state = stateOf('- a `b` c')
        expect(covered(state, splitMarksAtLineText(state, [code.range(4, 7)]))).toEqual(['[4, 7) "`b`"'])
    })

    it('splits a mark over a line break per line, starting the later line at its text', () => {
        const state = stateOf('- a `b\n  c` d')
        expect(covered(state, splitMarksAtLineText(state, [code.range(4, 11)]))).toEqual(['[4, 6) "`b"', '[9, 11) "c`"'])
    })

    it('covers a line in the middle from its text to its end', () => {
        const state = stateOf('- a `b\n  c\n  d` e')
        expect(covered(state, splitMarksAtLineText(state, [code.range(4, 15)]))).toEqual(['[4, 6) "`b"', '[9, 10) "c"', '[13, 15) "d`"'])
    })

    it('starts a quoted line after the quote markers the parser reads', () => {
        const state = stateOf('> a `b\n> > c` d')
        expect(covered(state, splitMarksAtLineText(state, [code.range(4, 13)]))).toEqual(['[4, 6) "`b"', '[11, 13) "c`"'])
    })

    it('covers a > the parser reads as text', () => {
        // Four spaces in, the `>` cannot open a quote inside the paragraph: it is the paragraph's text.
        const state = stateOf('Some `code\n    > more` text')
        const pieces = splitMarksAtLineText(state, [code.range(5, 22)])
        expect(covered(state, pieces)).toEqual(['[5, 10) "`code"', '[15, 22) "> more`"'])
    })

    it('starts a later line the outline reads as a bullet after its marker', () => {
        const state = stateOf('- a `b\n        - c` d')
        expect(covered(state, splitMarksAtLineText(state, [code.range(4, 19)]))).toEqual(['[4, 6) "`b"', '[17, 19) "c`"'])
    })

    it('leaves no empty piece where a mark ends at the start of a line', () => {
        const state = stateOf('**a\n  b**')
        expect(covered(state, splitMarksAtLineText(state, [code.range(0, 4)]))).toEqual(['[0, 3) "**a"'])
    })

    it('keeps the decoration itself on every piece, and points whole', () => {
        const state = stateOf('- a `b\n  c` d')
        const pieces = splitMarksAtLineText(state, [code.range(4, 11), hiddenSyntax.range(4, 5), widget.range(11)])
        expect(pieces.map((p) => p.value)).toEqual([code, code, hiddenSyntax, widget])
    })
})

describe('dropPiecesOnCodeLines: nothing is drawn on the lines of a code block the editor shows', () => {
    // To CommonMark the child bullet is a lazy continuation of `a` and its fences a code span; to
    // the editor's outline and fence scan it is a child bullet holding a code block (ADR 0067).
    const doc = '- a\n        - ```\n          x\n          ```\n- y'
    const line = (state: EditorState, n: number) => state.doc.line(n)

    it('drops a mark, a hidden run, a line decoration and a widget inside the block', () => {
        const state = stateOf(doc)
        const opener = line(state, 2)
        const body = line(state, 3)
        const closer = line(state, 4)
        const pieces = [
            code.range(opener.from + 10, opener.to),
            code.range(body.from, body.to),
            hiddenSyntax.range(opener.from + 10, opener.to),
            hiddenSyntax.range(closer.from + 10, closer.to),
            quoteLine.range(body.from),
            widget.range(body.to),
        ]
        expect(dropPiecesOnCodeLines(state, pieces)).toEqual([])
    })

    it('keeps everything on the other lines', () => {
        const state = stateOf(doc)
        const first = line(state, 1)
        const last = line(state, 5)
        const pieces = [code.range(first.from + 2, first.to), code.range(last.from + 2, last.to), widget.range(last.to), quoteLine.range(last.from)]
        expect(dropPiecesOnCodeLines(state, pieces)).toEqual(pieces)
    })

    it('draws on after an unterminated fence, which is text until it is closed', () => {
        const state = stateOf('x\n```\na `b` c')
        const last = line(state, 3)
        const pieces = [code.range(last.from + 2, last.from + 5)]
        expect(dropPiecesOnCodeLines(state, pieces)).toEqual(pieces)
    })

    it('reads the block the panel draws: a half-typed fence under the caret is text', () => {
        // Unbalanced, the caret on the first fence: the panel pairs the second with the third.
        const state = stateOf('```\na\n```\nb\n```', 0)
        const [, a, , b] = [1, 2, 3, 4].map((n) => line(state, n))
        expect(covered(state, dropPiecesOnCodeLines(state, [code.range(a.from, a.to), code.range(b.from, b.to)]))).toEqual([`[${a.from}, ${a.to}) "a"`])
    })
})

describe('hiddenSyntaxPieces: what the plugin draws for a declaration', () => {
    it('clips what the declaration returns for every range, split per line and off the code lines', () => {
        const state = stateOf('- a `b\n  c` d\n        - ```\n          x\n          ```')
        const body = state.doc.line(4)
        const pieces = hiddenSyntaxPieces({ pieces: (_state, from) => (from === 0 ? [code.range(4, 11)] : [code.range(body.from, body.to)]) }, state, [
            { from: 0, to: 12 },
            { from: body.from, to: body.to },
        ])
        expect(covered(state, pieces)).toEqual(['[4, 6) "`b"', '[9, 11) "c`"'])
    })

    it('asks the declaration with the reveal state of the state it draws', () => {
        const state = stateOf('- a\n- b', 1)
        let revealed: boolean | null = null
        hiddenSyntaxPieces({ pieces: (_state, _from, _to, reveal) => ((revealed = reveal.lineRevealedAt(0)), []) }, state, [{ from: 0, to: state.doc.length }])
        expect(revealed).toBe(true)
    })
})
