/**
 * An editor that shows one run of its document's lines and keeps the person's edits inside it: the
 * [[Task Editor]]'s description, comments and additional context (ADR 0170). It is the document's
 * own editor on the document itself, so wikilinks, images, pasting assets, undo and live
 * collaboration all work as in a tab; only the lines outside the run are hidden and out of reach.
 *
 * The run is worked out from the text by the host's `rangeOf`, afresh after every change, so it
 * follows the structure it stands for rather than offsets: a line another member adds under the task
 * is in it at once, and a Comments bullet an agent starts is not. `rangeOf` may read the editor's
 * anchored line (`line-anchor.ts`), which follows the task through lines added above it.
 *
 * The rules, for the person's own editing (typing, deleting, pasting, moving lines):
 *
 * - An edit that reaches a hidden line is refused, as is one that would take shown text out of the
 *   run (an outdent past the task, a line moved above it). The refusal is said (`edit-refused.ts`).
 * - Enter at the end of the last shown line stays inside, because the new line is still part of the
 *   structure `rangeOf` reads.
 * - Deleting everything shown takes the line it leaves empty with it, and the run is then empty.
 * - The selection never rests on a hidden line: Select All selects the run.
 *
 * Changes that are not the person's own pass untouched: another member's, an external write, and
 * the editor's own housekeeping. They are the document's truth, and refusing one would leave this
 * editor behind the text (the reason `frontmatter-boundary.ts` gives).
 *
 * The run is drawn from the level below the bullet it is nested under (`augmentations/outline-base.ts`):
 * that level sits at the left edge, and a guide hangs only from a line the run shows. The text keeps
 * its indentation.
 *
 * The caret's line shows its markdown only while the editor has the keyboard (`augmentations/reveal-policy.ts`
 * → `revealOnlyWhileFocused`): the caret is on a shown line from the start, and the part must open
 * drawn, not as source.
 */
import { EditorSelection, EditorState, type Extension, Facet, Prec, type Transaction, type TransactionSpec } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'

import { INDENT_UNIT } from '../indent-unit'
import { lineIndent } from '../outliner'
import { analysisFor, editorAnalysisField } from './analysis/editor-analysis'
import { type OutlineBase, outlineBaseFacet } from './augmentations/outline-base'
import { revealOnlyWhileFocused } from './augmentations/reveal-policy'
import { clampedCaret } from './caret-clamp'
import { EXTERNAL } from './cm-document'
import { refuseEdit, type ShownPartNames, type ShownRangeEdge } from './edit-refused'
import { lineAnchorField } from './line-anchor'
import { isOwnEditing } from './own-editing'

/** The shown run, from the start of its first line to the end of its last. */
export interface ShownRange {
    from: number
    to: number
    /**
     * The line (1-based) of the bullet the run is nested under: the task, or its Comments bullet. The
     * run is drawn from the level below it (`augmentations/outline-base.ts`).
     */
    nestedUnder: number
}

/**
 * Where the shown run is in a state, or null when there is nothing to show; with the names a refused
 * edit's notice gives the part (`edit-refused.ts`), where the host has them.
 */
export interface ShownRangeOf {
    (state: EditorState): ShownRange | null
    readonly names?: ShownPartNames
}

/** The names of a part whose host gives none. */
const UNNAMED: ShownPartNames = { field: 'part shown', line: 'line', above: 'the line above it' }

const rangeOfFacet = Facet.define<ShownRangeOf, ShownRangeOf | null>({ combine: (values) => values[0] ?? null })

/** The run, worked out again whenever the text or the anchored line changes. */
const shownRangeFacet = Facet.define<ShownRange | null, ShownRange | null | undefined>({
    combine: (values) => (values.length === 0 ? undefined : values[0]),
    // The same run worked out again is no change to what reads it.
    compare: (a, b) => a === b || (!!a && !!b && a.from === b.from && a.to === b.to && a.nestedUnder === b.nestedUnder),
})

/** The editor's shown run: null when nothing is shown, undefined in an editor that shows everything. */
export function shownRangeIn(state: EditorState): ShownRange | null | undefined {
    return state.facet(shownRangeFacet)
}

/** The lines outside the run, as block replacements: whole lines, the line breaks between them included. */
const hiddenLines = Facet.define<DecorationSet, DecorationSet>({ combine: (values) => values[0] ?? Decoration.none })

function hide(state: EditorState): DecorationSet {
    const range = state.facet(shownRangeFacet)
    if (range === undefined) return Decoration.none
    const replace = Decoration.replace({ block: true })
    const length = state.doc.length
    if (range === null) return length === 0 ? Decoration.none : Decoration.set([replace.range(0, length)])
    const hidden = []
    // `from` starts a line, so the line before it ends one character earlier, at its break.
    if (range.from > 0) hidden.push(replace.range(0, range.from - 1))
    if (range.to < length) hidden.push(replace.range(range.to + 1, length))
    return Decoration.set(hidden)
}

/** `pos` kept within the run. */
function clamp(pos: number, range: ShownRange): number {
    return Math.min(Math.max(pos, range.from), range.to)
}

/**
 * A selection spec keeping `tr`'s selection inside the run, or null when it already is. A caret
 * brought in from a hidden line rests at its line's content column, never in the margin (the caret
 * clamp's rule, which has run by now).
 */
function clampedSelection(tr: Transaction, range: ShownRange | null | undefined): TransactionSpec | null {
    if (!range) return null
    const selection = tr.newSelection
    if (selection.ranges.every((r) => r.from >= range.from && r.to <= range.to)) return null
    const state = tr.state
    const ranges = selection.ranges.map((r) =>
        r.empty ? EditorSelection.cursor(Math.min(clampedCaret(state, clamp(r.head, range)), range.to)) : EditorSelection.range(clamp(r.anchor, range), clamp(r.head, range)),
    )
    return { selection: EditorSelection.create(ranges, selection.mainIndex), sequential: true }
}

/**
 * Whether every change `tr` makes lies inside `range`, its edges included. A pure insertion of whole
 * lines at the start of the hidden line after the run (`X\n` there) is the same text as one at the
 * run's end (`\nX`), and so is `\nX` at the end of the hidden line before it and `X\n` at its start,
 * so both count as inside here and `judgeOwnEdit` judges where the lines land. The outliner's line
 * move writes them that way on purpose (`anchored-move.ts`, `carried`): Alt+Up on the last line shown
 * writes the line it passes at the start of the line after it, so a peer typing at the end of the
 * moved line keeps their text on one side of it.
 */
function changesWithin(tr: Transaction, range: ShownRange): boolean {
    let within = true
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        if (fromA >= range.from && toA <= range.to) return
        const text = inserted.toString()
        const pureInsert = fromA === toA && text.length > 0
        if (pureInsert && fromA === range.to + 1 && text.endsWith('\n')) return
        if (pureInsert && fromA === range.from - 1 && text.startsWith('\n')) return
        within = false
    })
    return within
}

/**
 * Which edge an edit reaching past the run would cross, read from what it does rather than the key
 * that made it, so the notice is right for any command. Losing a line while reaching above the run is
 * Backspace at its start joining it onto the line above; losing one while reaching below is Delete at
 * its end; a move (Alt+Up past the task, Alt+Down past the Comments block) loses none.
 */
function crossedEdge(tr: Transaction, range: ShownRange): ShownRangeEdge {
    // An undo or a redo puts back an earlier state: it joins and moves nothing the person pressed.
    if (tr.isUserEvent('undo') || tr.isUserEvent('redo')) return 'outside'
    let above = false
    let below = false
    tr.changes.iterChangedRanges((fromA, toA) => {
        if (fromA < range.from) above = true
        if (toA > range.to) below = true
    })
    if (tr.newDoc.lines < tr.startState.doc.lines) return above ? 'join-above' : below ? 'join-below' : 'outside'
    return tr.isUserEvent('move') ? 'move-out' : 'outside'
}

/** The refusal of `tr`, carrying the edge and the names the notice gives the part. */
function refuse(tr: Transaction, edge: ShownRangeEdge): readonly TransactionSpec[] {
    return refuseEdit({ edge, names: tr.startState.facet(rangeOfFacet)?.names ?? UNNAMED })
}

/**
 * The person's own edit, judged: refused when it reaches outside the run or takes shown text out of
 * it; otherwise the edit, with the selection kept inside, and with the empty line it leaves when it
 * deletes everything shown.
 */
function judgeOwnEdit(tr: Transaction, before: ShownRange | null): Transaction | readonly TransactionSpec[] {
    if (before === null) return refuse(tr, 'nothing-shown')
    if (emptiesRun(tr, before)) return tr
    if (!changesWithin(tr, before)) return refuse(tr, crossedEdge(tr, before))
    const { from, to } = mappedEdges(tr, before)
    if (from === to) return emptied(tr, from)
    const after = shownRangeIn(tr.state)
    // Inside the run, but shown text would leave it: Shift+Tab past the task, Tab into the comments.
    if (!after || after.from > from || after.to < to) return refuse(tr, 'move-out')
    const selection = clampedSelection(tr, after)
    return selection ? [tr, selection] : tr
}

/**
 * The run's edges after `tr`, mapped from the line breaks either side of it, so whole lines written
 * beside the run (see `changesWithin`) count as written at its edge and must land in it.
 */
function mappedEdges(tr: Transaction, before: ShownRange): { from: number; to: number } {
    const doc = tr.startState.doc
    const from = before.from > 0 ? tr.changes.mapPos(before.from - 1, -1) + 1 : tr.changes.mapPos(before.from, -1)
    const to = before.to < doc.length ? tr.changes.mapPos(before.to + 1, 1) - 1 : tr.changes.mapPos(before.to, 1)
    return { from, to }
}

/**
 * Whether `tr` leaves the document as it was with everything shown and one line break beside it taken
 * out: what the outliner's delete of the whole run does (Select All then Backspace, or Backspace on a
 * sole empty bullet). The change is often written as a smaller replacement that ends in the same text,
 * so the text is compared, not the change. The break goes with the lines, so no blank line is left.
 */
function emptiesRun(tr: Transaction, range: ShownRange): boolean {
    const doc = tr.startState.doc
    if (doc.length - tr.newDoc.length !== range.to - range.from + 1) return false
    const after = tr.newDoc.toString()
    const breakBefore = range.from > 0 && doc.sliceString(0, range.from - 1) + doc.sliceString(range.to) === after
    return breakBefore || (range.to < doc.length && doc.sliceString(0, range.from) + doc.sliceString(range.to + 1) === after)
}

/** Everything shown was deleted: the line left empty goes too, with the break before it. */
function emptied(tr: Transaction, at: number): readonly TransactionSpec[] {
    const line = tr.newDoc.lineAt(at)
    if (line.text !== '' || line.from === 0) return [tr]
    return [tr, { changes: { from: line.from - 1, to: line.to }, selection: EditorSelection.cursor(line.from - 1), sequential: true }]
}

/**
 * The person's edits kept inside the run. `Prec.highest`, and registered before every other
 * `Prec.highest` filter (the Extension Fence's caret, `interactive-fence.ts`): filters run from the last
 * registered back, so this one runs last and judges, and places the caret after, all the others.
 */
const keepEditsInside = Prec.highest(
    EditorState.transactionFilter.of((tr) => {
        const before = shownRangeIn(tr.startState)
        if (before === undefined) return tr
        if (tr.docChanged && !tr.annotation(EXTERNAL) && isOwnEditing(tr)) return judgeOwnEdit(tr, before)
        // Not the person's edit, or no edit at all: it stands, and only the selection is kept in.
        const selection = clampedSelection(tr, tr.docChanged ? shownRangeIn(tr.state) : before)
        return selection ? [tr, selection] : tr
    }),
)

/**
 * The level the run is drawn from: one below the bullet it is nested under, whatever the run holds,
 * so the drawing never moves while the person types (`augmentations/outline-base.ts`). Null for an
 * empty run, which shows nothing.
 */
function runBase(state: EditorState): OutlineBase | null {
    const range = state.facet(shownRangeFacet)
    if (!range || range.nestedUnder > state.doc.lines) return null
    const parent = range.nestedUnder - 1
    const { lines, outline } = analysisFor(state)
    return {
        depth: (outline[parent]?.depth ?? 0) + 1,
        indent: lineIndent(lines[parent]) + INDENT_UNIT,
        shown: { first: state.doc.lineAt(range.from).number - 1, last: state.doc.lineAt(range.to).number - 1 },
    }
}

/**
 * The editor shows one part of a document rather than the whole: a run (`shownRange`), or a new
 * task's description held until it is written (`showsPart`). Its Command Menu offers only the rows
 * that act on the text (`surface/command-menu.ts`, ADR 0170): a row acting on the tab, the document
 * as a whole, a View or the graph would act on whatever is behind the Task Editor.
 */
const showsPartFacet = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) })

/**
 * Mark an editor as showing one part of a document, for an editor with no run to show. Like a run, it
 * reveals the caret's line only while it has the keyboard (see `shownRange`).
 */
export function showsPart(): Extension {
    return [showsPartFacet.of(true), revealOnlyWhileFocused()]
}

/** Whether `state`'s editor shows one part of a document. */
export function showsPartOfDocument(state: EditorState): boolean {
    return state.facet(showsPartFacet) || state.facet(shownRangeFacet) !== undefined
}

/**
 * Show only the run `rangeOf` finds, and keep the person's edits inside it. Registered first in the
 * feature stack (`editor-extensions.ts`): its filter then runs after every other, and its hidden lines,
 * at the highest precedence, are drawn in place of any widget another feature puts on them.
 */
export function shownRange(rangeOf: ShownRangeOf): Extension {
    return [
        rangeOfFacet.of(rangeOf),
        // `rangeOf` reads the anchored line and the shared analysis, so both are dependencies.
        shownRangeFacet.compute(['doc', lineAnchorField, editorAnalysisField, rangeOfFacet], (state) => state.facet(rangeOfFacet)?.(state) ?? null),
        // The text too: the run may stay where it is while text is added after it, which the hidden
        // lines after it must then cover.
        hiddenLines.compute(['doc', shownRangeFacet], hide),
        // Drawn from its own first level: the analysis gives each line's depth.
        outlineBaseFacet.compute([shownRangeFacet, editorAnalysisField], runBase),
        // Block replacements that span line breaks must come from the state, not a view plugin; at the
        // highest precedence, so an image or a rendered fence on a hidden line is not drawn over them.
        Prec.highest(EditorView.decorations.compute([hiddenLines], (state) => state.facet(hiddenLines))),
        // The caret steps over the hidden lines rather than into them.
        EditorView.atomicRanges.of((view) => view.state.facet(hiddenLines)),
        keepEditsInside,
        // The caret is always on a line shown, from the moment the editor opens, so it reveals that
        // line only while the editor has the keyboard: a picture on the first line opens drawn, and the
        // line last edited is drawn again once the person moves to another field (reveal-policy.ts).
        revealOnlyWhileFocused(),
    ]
}
