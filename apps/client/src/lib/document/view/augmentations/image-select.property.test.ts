/**
 * Property tests over the selected image and the parked caret (image-select.ts): the one rendered
 * image whose controls a tap has raised, and the picture a tap put the caret on without showing its
 * markdown. Random documents of bullets, prose and image lines take random taps, clicks (which are
 * Edit as text), caret moves, typing and edits made elsewhere (a peer's, with no selection of their
 * own: text written and deleted, whole lines deleted, lines indented and outdented), and after every
 * step the rules of Editor Content Rules.md → "A click on a rendered image shows its markdown" and
 * "A tap on a rendered image shows its actions" must hold:
 *
 * - The selected line, when there is one, is drawn as its picture: never a line that was deleted,
 *   written into something else, or revealed.
 * - Exactly that picture's widget is the selected one, and no other.
 * - An image line shows its markdown exactly when the caret is on it and not parked there: no
 *   picture opened as text stays open once the caret has gone.
 * - A parked caret is one caret, on the parked line.
 * - A tap selects the picture tapped, or deselects it when it was the selected one. It leaves the
 *   caret where it was, unless the caret was on another image line showing its markdown: then the
 *   caret is parked on the tapped one.
 * - A click shows the clicked picture's markdown, with the caret at its end, and selects nothing.
 * - A key that writes at a parked caret writes nothing: it opens that picture as text, as a click does.
 * - Nothing else selects a picture: after any other step the selected picture is the one that was
 *   selected before it, or none.
 */

import type { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { analysisFor } from '../analysis/editor-analysis'
import { editorFixture, type HeadlessEditor } from '../testing/editor-state-fixture'
import { imageClickSpec, imageEmbedAugmentation, parkedKeySpec } from './image-embed'
import { imageTapSpec, parkedImageLine, selectedImageLine } from './image-select'

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
    | { kind: 'caret'; at: number }
    | { kind: 'type'; text: string }
    | { kind: 'key'; key: string }
    | { kind: 'peer-insert'; at: number; text: string }
    | { kind: 'peer-delete'; from: number; length: number }
    | { kind: 'peer-delete-line'; line: number }
    | { kind: 'peer-indent'; line: number; out: boolean }

const step: fc.Arbitrary<Step> = fc.oneof(
    { weight: 4, arbitrary: fc.record({ kind: fc.constant('tap' as const), picture: fc.nat(20) }) },
    { weight: 4, arbitrary: fc.record({ kind: fc.constant('click' as const), picture: fc.nat(20) }) },
    fc.record({ kind: fc.constant('caret' as const), at: fc.nat(400) }),
    fc.record({ kind: fc.constant('type' as const), text: fc.constantFrom('s', ' ', '!', '\n') }),
    // A key as the editor's keydown hears it: the parked caret's handler first, then the outliner's keys.
    { weight: 3, arbitrary: fc.record({ kind: fc.constant('key' as const), key: fc.constantFrom('s', 'Enter', 'Tab', 'Backspace', 'Delete') }) },
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
    /** The line a tap or a click must leave selected, or null when a tap deselects or a click opens it. */
    pressed?: number | null
    /** Where a tap or a click must leave the caret: where it was (`stays`), parked on the picture, or at the end of its markdown. */
    caret?: { kind: 'stays' } | { kind: 'parked'; line: number; open: number[] } | { kind: 'opened'; line: number }
    /** Where the picture selected before the step is now, or null when there was none or it is gone. */
    carried: number | null
    /** The step moved the caret or wrote at it, which ends any park. */
    unparks?: boolean
    /** A key at a parked caret: the document as it was, and the parked picture's line opened as text. */
    keyAtPark?: { doc: string; line: number }
}

/** The lines any selection range touches. */
function caretLines(state: EditorState): Set<number> {
    const lines = new Set<number>()
    for (const range of state.selection.ranges) for (let n = state.doc.lineAt(range.from).number; n <= state.doc.lineAt(range.to).number; n++) lines.add(n)
    return lines
}

/** The image lines, other than `except`, that show their markdown because a selection range is on them. */
function openImages(state: EditorState, except: number): number[] {
    const drawn = new Set(pictures(state).map((picture) => picture.line))
    return analysisFor(state)
        .imageLines.map((image) => image.line)
        .filter((n) => n !== except && caretLines(state).has(n) && !drawn.has(n))
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
    if (s.kind === 'tap' || s.kind === 'click') {
        // Only a drawn picture can be pressed: the gesture lands on its widget.
        const drawn = pictures(state)
        if (drawn.length === 0) return { carried: selected }
        const target = drawn[s.picture % drawn.length].line
        const from = state.doc.line(target).from
        if (s.kind === 'click') {
            // The caret goes onto the picture's line, which puts any picture's controls away.
            editor.dispatch(state.update(imageClickSpec(state, from)))
            return { pressed: null, caret: { kind: 'opened', line: target }, carried: null }
        }
        const open = openImages(state, target)
        const tr = state.update(imageTapSpec(state, from))
        editor.dispatch(tr)
        // Where a line is now: the caret leaving a line may tidy it (a blank line's spaces), which
        // moves the lines below.
        const now = (n: number) => tr.state.doc.lineAt(tr.changes.mapPos(state.doc.line(n).from)).number
        const parked = { kind: 'parked' as const, line: now(target), open: open.map(now) }
        return { pressed: selected === target ? null : now(target), caret: open.length > 0 ? parked : { kind: 'stays' }, carried: null }
    }
    if (s.kind === 'caret') {
        // The caret may be held off the place asked for (a bullet's marker): what counts is whether it moved.
        const head = editor.head()
        editor.select(s.at % (length + 1))
        return editor.head() === head ? { carried: selected } : { carried: null, unparks: true }
    }
    if (s.kind === 'type') {
        editor.type(s.text)
        return { carried: null, unparks: true }
    }
    if (s.kind === 'key') {
        const parked = parkedImageLine(state)
        const spec = parkedKeySpec(state, { key: s.key, ctrlKey: false, metaKey: false, altKey: false })
        if (spec) editor.dispatch(state.update(spec))
        else if (s.key.length === 1) editor.type(s.key)
        else editor.key(s.key)
        // Whether such a key puts a tapped picture's actions away is the typing step's to check; here
        // the selection may stay where the key left it.
        return { carried: selectedImageLine(editor.state), unparks: true, ...(parked === null ? {} : { keyAtPark: { doc: state.doc.toString(), line: parked } }) }
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
    it('is always one drawn picture or none, only a tap selects one, and only the caret shows an image line as markdown', () => {
        fc.assert(
            fc.property(fc.array(line, { minLength: 1, maxLength: 8 }), fc.array(step, { maxLength: 25 }), (lines, steps) => {
                const editor = editorFixture(`${lines.join('\n')}\n- Last line§`, { caret: '§', extensions })
                for (const s of steps) {
                    const caret = editor.head()
                    const outcome = run(editor, s)
                    const { state } = editor
                    const selected = selectedImageLine(state)
                    const parked = parkedImageLine(state)
                    if (outcome.pressed !== undefined) expect(selected).toBe(outcome.pressed)
                    // Carried along with its line, never moved to another picture.
                    else if (selected !== null) expect(selected).toBe(outcome.carried)
                    if (outcome.caret?.kind === 'stays') expect(editor.head()).toBe(caret)
                    if (outcome.caret?.kind === 'parked') {
                        // The lines open before are drawn again, and the caret is parked on the tapped
                        // picture, unless the editor's caret rules took it to a line beside it.
                        const drawnNow = new Set(pictures(state).map((picture) => picture.line))
                        for (const n of outcome.caret.open) expect(drawnNow.has(n), `line ${n} drawn again`).toBe(true)
                        if (parked !== null) expect(state.doc.lineAt(editor.head()).number).toBe(outcome.caret.line)
                    }
                    if (outcome.caret?.kind === 'opened') {
                        expect(editor.head()).toBe(state.doc.line(outcome.caret.line).from + state.doc.line(outcome.caret.line).text.trimEnd().length)
                        expect(parked).toBeNull()
                    }
                    // The selected line is drawn as its picture, and its widget alone is the selected one.
                    const drawn = pictures(state)
                    expect(drawn.filter((picture) => picture.selected).map((picture) => picture.line)).toEqual(selected === null ? [] : [selected])
                    // An image line shows its markdown exactly while the caret is on it, unless the caret is parked there.
                    const onCaret = caretLines(state)
                    const drawnLines = new Set(drawn.map((picture) => picture.line))
                    for (const image of analysisFor(state).imageLines) expect(drawnLines.has(image.line), `line ${image.line}`).toBe(!onCaret.has(image.line) || image.line === parked)
                    if (outcome.unparks) expect(parked).toBeNull()
                    // A key at a parked caret writes nothing and opens that picture as text, the caret at its end.
                    if (outcome.keyAtPark) {
                        expect(state.doc.toString()).toBe(outcome.keyAtPark.doc)
                        const opened = state.doc.line(outcome.keyAtPark.line)
                        expect(editor.head()).toBe(opened.from + opened.text.trimEnd().length)
                    }
                    // A parked caret is one caret on its line.
                    if (parked !== null) expect(state.selection.ranges.length === 1 && state.selection.main.empty && state.doc.lineAt(editor.head()).number === parked).toBe(true)
                }
            }),
            fuzz(1000),
        )
    })
})
