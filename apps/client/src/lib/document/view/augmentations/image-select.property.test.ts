/**
 * Property tests over the selected image (image-select.ts): the one rendered image whose controls
 * a tap or a click has raised. Random documents of bullets, prose and image lines take random taps,
 * clicks, Edits as text, caret moves, typing and edits made elsewhere (a peer's, with no selection of their own: text
 * written and deleted, whole lines deleted, lines indented and outdented), and
 * after every step the rules of Editor Content Rules.md → "A click or a tap on a rendered image shows
 * its actions" must hold:
 *
 * - The selected line, when there is one, is drawn as its picture: never a line that was deleted,
 *   written into something else, or revealed.
 * - Exactly that picture's widget is the selected one, and no other.
 * - A tap selects the picture tapped, or deselects it when it was the selected one, and a click
 *   selects the picture clicked, however often. Neither moves the caret.
 * - Nothing else selects a picture: after any other step the selected picture is the one that was
 *   selected before it, or none.
 * - The picture holds the keyboard exactly when a click was the last to select it.
 */

import type { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { editorFixture, type HeadlessEditor } from '../testing/editor-state-fixture'
import { imageClickSpec, imageEmbedAugmentation } from './image-embed'
import { imagePressSpec, imageTapSpec, selectedImageHoldsKeyboard, selectedImageLine } from './image-select'

/**
 * A fixed seed keeps the suite deterministic in CI. To hunt for new counterexamples, run with
 * `EDITOR_FUZZ_SEED=<n>` (any integer) and optionally `EDITOR_FUZZ_RUNS=<n>`.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.EDITOR_FUZZ_SEED
    return {
        numRuns: Number(process.env.EDITOR_FUZZ_RUNS ?? runs),
        seed: seed === undefined ? 20261123 : Number(seed),
    }
}

const extensions = [imageEmbedAugmentation({ resolveAsset: () => Promise.resolve(null) })]

/** The lines a document is made of: standalone and bullet images among bullets, prose and blanks. */
const line = fc.constantFrom(
    '![Beds|300](../assets/beds.png)',
    '- ![Shed](../assets/shed.png)',
    '  - ![Pond|200](../assets/pond.png)',
    '- [ ] ![Gate](../assets/gate.png)',
    '- water the beans',
    '  - under the net',
    'Kitchen garden plan',
    '',
)

/** One thing that happens to the editor. Numbers pick a line or a place, wrapped into the document. */
type Step =
    | { kind: 'tap'; picture: number }
    | { kind: 'click'; picture: number }
    | { kind: 'edit'; picture: number }
    | { kind: 'caret'; at: number }
    | { kind: 'type'; text: string }
    | { kind: 'peer-insert'; at: number; text: string }
    | { kind: 'peer-delete'; from: number; length: number }
    | { kind: 'peer-delete-line'; line: number }
    | { kind: 'peer-indent'; line: number; out: boolean }

const step: fc.Arbitrary<Step> = fc.oneof(
    { weight: 4, arbitrary: fc.record({ kind: fc.constant('tap' as const), picture: fc.nat(20) }) },
    { weight: 4, arbitrary: fc.record({ kind: fc.constant('click' as const), picture: fc.nat(20) }) },
    fc.record({ kind: fc.constant('edit' as const), picture: fc.nat(20) }),
    fc.record({ kind: fc.constant('caret' as const), at: fc.nat(400) }),
    fc.record({ kind: fc.constant('type' as const), text: fc.constantFrom('s', ' ', '!', '\n') }),
    fc.record({ kind: fc.constant('peer-insert' as const), at: fc.nat(400), text: fc.constantFrom('- peas\n', 'x', '\n', '```\n', ' and more') }),
    fc.record({ kind: fc.constant('peer-delete' as const), from: fc.nat(400), length: fc.integer({ min: 1, max: 40 }) }),
    // A whole line with its break, as a peer deleting a bullet does.
    { weight: 2, arbitrary: fc.record({ kind: fc.constant('peer-delete-line' as const), line: fc.nat(20) }) },
    // A line moved in or out by two spaces, as a peer's Tab or Shift+Tab does.
    { weight: 2, arbitrary: fc.record({ kind: fc.constant('peer-indent' as const), line: fc.nat(20), out: fc.boolean() }) },
)

/** What this tier reads of an image widget: whether it is drawn selected. */
interface ImageWidgetShape {
    selected: boolean
}

/** The image widgets drawn, each with its 1-based line. */
function pictures(state: EditorState): { line: number; selected: boolean }[] {
    const found: { line: number; selected: boolean }[] = []
    for (const set of state.facet(EditorView.decorations)) {
        if (typeof set === 'function') continue
        for (const cursor = set.iter(); cursor.value; cursor.next()) {
            const widget = cursor.value.spec.widget as Partial<ImageWidgetShape> | undefined
            if (widget && typeof widget.selected === 'boolean') found.push({ line: state.doc.lineAt(cursor.from).number, selected: widget.selected })
        }
    }
    return found
}

/** What a step may leave selected: exactly `pressed` after a tap or a click, and `carried` or nothing after any other step. */
interface Outcome {
    /** The line a tap or a click must leave selected, or null when a tap deselects. */
    pressed?: number | null
    /** Whether the picture a tap or a click selected holds the keyboard. */
    keyboard?: boolean
    /** Where the picture selected before the step is now, or null when there was none or it is gone. */
    carried: number | null
}

/** The range a peer's step replaces: a place for an insert, a run of characters or a whole line for a delete. */
function peerRange(state: EditorState, s: Extract<Step, { kind: `peer-${string}` }>): { from: number; to: number } {
    const length = state.doc.length
    if (s.kind === 'peer-insert') return { from: s.at % (length + 1), to: s.at % (length + 1) }
    if (s.kind === 'peer-delete-line') {
        const line = state.doc.line(1 + (s.line % state.doc.lines))
        return { from: line.from, to: Math.min(length, line.to + 1) }
    }
    if (s.kind === 'peer-indent') {
        const line = state.doc.line(1 + (s.line % state.doc.lines))
        return { from: line.from, to: s.out && line.text.startsWith('  ') ? line.from + 2 : line.from }
    }
    const from = length === 0 ? 0 : s.from % length
    return { from, to: Math.min(length, from + s.length) }
}

/** Run one step and say what it may leave selected. */
function run(editor: HeadlessEditor, s: Step): Outcome {
    const { state } = editor
    const length = state.doc.length
    const selected = selectedImageLine(state)
    if (s.kind === 'tap' || s.kind === 'click' || s.kind === 'edit') {
        // Only a drawn picture can be pressed: the gesture lands on its widget.
        const drawn = pictures(state)
        if (drawn.length === 0) return { carried: selected }
        const target = drawn[s.picture % drawn.length].line
        const from = state.doc.line(target).from
        if (s.kind === 'edit') {
            // The caret goes onto the picture's line, which puts any picture's controls away.
            editor.dispatch(state.update(imageClickSpec(state, from)))
            return { carried: null }
        }
        if (s.kind === 'click') {
            editor.dispatch(state.update(imagePressSpec(state, from)))
            return { pressed: target, keyboard: true, carried: null }
        }
        editor.dispatch(state.update(imageTapSpec(state, from)))
        return { pressed: selected === target ? null : target, keyboard: false, carried: null }
    }
    if (s.kind === 'caret') {
        // The caret may be held off the place asked for (a bullet's marker): what counts is whether it moved.
        const head = editor.head()
        editor.select(s.at % (length + 1))
        return { carried: editor.head() === head ? selected : null }
    }
    if (s.kind === 'type') {
        editor.type(s.text)
        return { carried: null }
    }
    // A peer's edit, with no selection of its own: the picture goes with its image, unless the edit
    // takes the image's `!`, which is the line being deleted or made something else.
    const { from, to } = peerRange(state, s)
    const insert = s.kind === 'peer-insert' ? s.text : s.kind === 'peer-indent' && !s.out ? '  ' : ''
    const tr = state.update({ changes: { from, to, insert } })
    editor.dispatch(tr)
    if (selected === null) return { carried: null }
    // The image's `!`, which an edit before it on the line (an indent, an outdent) leaves standing.
    const line = state.doc.line(selected)
    const start = line.from + line.text.indexOf('![')
    const gone = from <= start && to > start
    return { carried: gone ? null : tr.state.doc.lineAt(tr.changes.mapPos(start, 1)).number }
}

describe('the selected image', () => {
    it('is always one drawn picture or none, and only a tap or a click selects one, without moving the caret', () => {
        fc.assert(
            fc.property(fc.array(line, { minLength: 1, maxLength: 8 }), fc.array(step, { maxLength: 25 }), (lines, steps) => {
                const editor = editorFixture(`${lines.join('\n')}\n- Last line§`, { caret: '§', extensions })
                let keyboard = false
                for (const s of steps) {
                    const caret = editor.head()
                    const outcome = run(editor, s)
                    const selected = selectedImageLine(editor.state)
                    if (outcome.pressed !== undefined) {
                        expect(selected).toBe(outcome.pressed)
                        keyboard = outcome.keyboard ?? false
                        expect(editor.head()).toBe(caret)
                    } else if (selected !== null) {
                        // Carried along with its line, never moved to another picture.
                        expect(selected).toBe(outcome.carried)
                    }
                    expect(selectedImageHoldsKeyboard(editor.state)).toBe(selected !== null && keyboard)
                    // The selected line is drawn as its picture, and its widget alone is the selected one.
                    const drawn = pictures(editor.state)
                    expect(drawn.filter((picture) => picture.selected).map((picture) => picture.line)).toEqual(selected === null ? [] : [selected])
                }
            }),
            fuzz(1000),
        )
    })
})
