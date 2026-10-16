/**
 * The two buttons after a document's text (ADR 0149, Editor Content Rules → End of document).
 *
 * Putting the caret at the end of a document to add something is fiddly, most of all on a phone,
 * and the end can sit under a code block or a map, where a caret at the last line's end is in the
 * fence's source. So each button always starts on a new line at the end: the text button an empty
 * line, the bullet button a new top-level bullet, with the caret on it (`startAtEnd`).
 *
 * A line the button started and nobody wrote on is taken back out, with the blank line the button
 * added before it, when the caret leaves it. The press and the take-back are placements, not edits:
 * neither is a step in the undo history, and a [[Draft]] takes both in without being created (the
 * press is a `select` event, the take-back carries `placementChange`, and cm-document.ts reports
 * neither as an edit). A line an inline panel comes to hold (`caretKeptOff`), as an [[Agent Chat]]
 * opened on the new bullet does, is kept: the person used it.
 */

import { ChangeSet, type ChangeDesc, EditorSelection, EditorState, type Extension, Prec, StateEffect, StateField, type Text, Transaction, type TransactionSpec } from '@codemirror/state'
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

import { frontmatterLines } from '$lib/storage/fs/frontmatter-span'

import { bulletContent, isBulletLine, lineIndent, ownerBulletIndex, taskDone } from '../outliner'
import { caretKeptOff } from './augmentations/interactive-fence'
import { placementChange } from './cm-document'

/** The buttons' row beneath `view`'s text while it is drawn (`data-end-of-document`, written out in EndOfDocument.svelte). */
export function endButtonsOf(view: EditorView): HTMLElement | null {
    return view.scrollDOM.querySelector<HTMLElement>(':scope > div > [data-end-of-document]')
}

/** Which button: an empty line, or a new top-level bullet. */
export type EndKind = 'line' | 'bullet'

/** What a press does to the text, against the document as it stands without any untouched line. */
export interface EndPlan {
    /** The text written, or null when a blank line or an empty bullet already there is used as it is. */
    change: { from: number; to: number; insert: string } | null
    /** Where the caret goes, against the document after `change`. */
    caret: number
}

/** The top-level bullet the bullet button starts. */
const BULLET = '- '

/** An empty bullet at the left margin: a bullet's marker and nothing after it. A task is not one. */
function isEmptyTopLevelBullet(line: string): boolean {
    return lineIndent(line) === 0 && isBulletLine(line) && taskDone(line) === undefined && bulletContent(line).trim() === ''
}

/**
 * Where a press puts its new line or bullet in `doc`, by the rules in ADR 0149:
 *
 * - The text button leaves one blank line between the last text and the new line, so what is typed
 *   starts a paragraph of its own.
 * - The bullet button goes straight under a bullet or a bullet's own lines (a continuation, a code
 *   block inside it), and after anything else leaves a blank line first.
 * - An empty top-level bullet already at the end is the bullet button's, unless an inline panel
 *   holds it (`held`, 0-based line numbers): then the new bullet goes under it.
 * - A body with no text gets the line or bullet at its start, below any frontmatter.
 *
 * Blank lines already there are used before any is added, and one holding only spaces is emptied
 * for the new line. Nothing above the last text is ever touched.
 */
export function planAtEnd(doc: Text, kind: EndKind, held: ReadonlySet<number> = new Set()): EndPlan {
    const lines = doc.toString().split('\n')
    const body = frontmatterLines(lines)
    let last = lines.length - 1
    while (last >= body && lines[last].trim() === '') last--
    if (kind === 'bullet' && last >= body && isEmptyTopLevelBullet(lines[last]) && !held.has(last)) {
        return { change: null, caret: doc.line(last + 1).to }
    }
    const content = kind === 'bullet' ? BULLET : ''
    // The 0-based line the new line takes: the body's first with no text in it, else past the gap.
    const gap = kind === 'bullet' && last >= body && ownerBulletIndex(lines, last) !== null ? 0 : 1
    const target = last < body ? body : last + 1 + gap
    if (target < lines.length) {
        const line = doc.line(target + 1)
        return {
            change: line.text === content ? null : { from: line.from, to: line.to, insert: content },
            caret: line.from + content.length,
        }
    }
    const breaks = '\n'.repeat(target - lines.length + 1)
    return { change: { from: doc.length, to: doc.length, insert: breaks + content }, caret: doc.length + breaks.length + content.length }
}

/** A line the button started that nobody has written on yet, against the document now. */
interface UntouchedLine {
    /** The line's start and end. */
    from: number
    to: number
    /** Where what the button added begins: the line break before its blank line, or the line itself. */
    addedFrom: number
    /** Takes what the button added back out, restoring any spaces a reused blank line held. */
    undo: ChangeSet
    /**
     * An undo or redo put the person's own text at the line's end (`restoresAtLineEnd`): it is taken
     * back at once, wherever the caret is, so that text rejoins the line above.
     */
    displaced?: true
}

/**
 * The line through `changes`. Text put in where what the button added begins goes before it, as
 * `undo.map` places it, so the take-back leaves it in place. `toAssoc` -1 keeps the line's end
 * before text put in there, for text the history restored (`restoresAtLineEnd`).
 */
function mapUntouched(line: UntouchedLine, changes: ChangeDesc, toAssoc: -1 | 1 = 1): UntouchedLine {
    return {
        from: changes.mapPos(line.from, -1),
        to: changes.mapPos(line.to, toAssoc),
        addedFrom: changes.mapPos(line.addedFrom, 1),
        undo: line.undo.map(changes),
        ...(line.displaced ? { displaced: true as const } : {}),
    }
}

/** Whether a change of `fromA..toA` writes on the line (reaching it, an insertion at either end included) or into what the button added before it. */
function rangeWritesOn(fromA: number, toA: number, line: UntouchedLine): boolean {
    return (fromA <= line.to && toA >= line.from) || (fromA < line.from && toA > line.addedFrom)
}

/**
 * Whether `changes` write on the button's line or into what it added before it. A change that only
 * meets the added text's start, as an undo of the word before it does, leaves the line untouched.
 */
function writesOn(changes: ChangeDesc, line: UntouchedLine): boolean {
    let writes = false
    changes.iterChangedRanges((fromA, toA) => {
        if (rangeWritesOn(fromA, toA, line)) writes = true
    })
    return writes
}

/**
 * Whether an undo or redo only put text in at the line's end. The press was no step in the history,
 * so the history maps its steps through the press, and text it restores at the end of the last text,
 * where the press put its line, lands after the press's text instead: on the new line. That text is
 * the person's, from before the press, and belongs where it was.
 */
function restoresAtLineEnd(tr: Transaction, line: UntouchedLine): boolean {
    if (!tr.isUserEvent('undo') && !tr.isUserEvent('redo')) return false
    let atEnd = false
    let elsewhere = false
    tr.changes.iterChangedRanges((fromA, toA) => {
        if (fromA === line.to && toA === line.to) atEnd = true
        else if (rangeWritesOn(fromA, toA, line)) elsewhere = true
    })
    return atEnd && !elsewhere
}

/** Sets the untouched line a press started, or clears it (null) once a panel holds it or it is taken back. */
const setUntouchedLine = StateEffect.define<UntouchedLine | null>({ map: (line, changes) => line && mapUntouched(line, changes) })

const untouchedLineField = StateField.define<UntouchedLine | null>({
    create: () => null,
    update(line, tr) {
        for (const effect of tr.effects) if (effect.is(setUntouchedLine)) return effect.value
        if (!line || tr.changes.empty) return line
        if (restoresAtLineEnd(tr, line)) return { ...mapUntouched(line, tr.changes, -1), displaced: true }
        return writesOn(tr.changes, line) ? null : mapUntouched(line, tr.changes)
    },
})

/** Whether an inline panel is drawn on the line, which then belongs to it (`caretKeptOff`). */
function heldByPanel(state: EditorState, line: UntouchedLine): boolean {
    return state.facet(caretKeptOff).some((blocks) => blocks(state).some((block) => block.blockFrom <= line.to && block.blockTo >= line.from))
}

/** Whether any part of the selection is on the line: the caret, or a selection reaching it. */
function selectionOn(state: EditorState, line: UntouchedLine): boolean {
    return state.selection.ranges.some((range) => range.from <= line.to && range.to >= line.from)
}

/** What takes the line back out: its own changes, a placement out of the history. */
const takeBackAnnotations = [Transaction.addToHistory.of(false), placementChange.of(true)]

/**
 * Takes the untouched line back out in the transaction that moves the caret off it, so the caret is
 * mapped with it: moving up onto the blank line before it lands at the end of the text. Only a caret
 * move: a transaction that also changes the text elsewhere is left whole and `takeBackAfterUpdate`
 * takes the line back after it, out of that edit's undo step. A transaction that writes on the line
 * makes it the person's, which the field records by dropping it. A panel opening on it ends the
 * tracking.
 *
 * At high precedence, so it sees the caret where the default filters leave it (the caret clamp's
 * ArrowLeft at a bullet's wall), and its take-back is not judged again by the guards that ran before
 * it (the frontmatter boundary would refuse taking out a bullet after a closer that ends the
 * document). Still before the Extension Fence caret filter, at the highest, which moves a caret off
 * a panel's line once the panel opens.
 */
const takeBackFilter = Prec.high(
    EditorState.transactionFilter.of((tr): TransactionSpec | readonly TransactionSpec[] => {
        const before = tr.startState.field(untouchedLineField, false)
        if (!before) return tr
        if (tr.effects.some((effect) => effect.is(setUntouchedLine))) return tr
        if (writesOn(tr.changes, before)) return tr
        const line = mapUntouched(before, tr.changes)
        const state = tr.state
        if (heldByPanel(state, line)) return [tr, { effects: setUntouchedLine.of(null) }]
        if (!tr.selection || !tr.changes.empty || selectionOn(state, line)) return tr
        return [tr, { changes: line.undo, sequential: true, annotations: takeBackAnnotations }]
    }),
)

/** The untouched-line field and its take-back. Registered with the editor's feature stack. */
export function endOfDocument(): Extension {
    return [untouchedLineField, takeBackFilter, takeBackAfterUpdate]
}

/** What `startAtEnd` needs of an editor: an `EditorView`, or a test's stand-in over a state. */
export interface EndTarget {
    state: EditorState
    dispatch(tr: Transaction): void
}

/** The 0-based lines of `base` an inline panel holds, from `state`'s panels mapped through `toBase`. */
function heldLines(state: EditorState, base: Text, toBase: ChangeDesc | null): Set<number> {
    const held = new Set<number>()
    for (const blocks of state.facet(caretKeptOff)) {
        for (const block of blocks(state)) {
            const from = base.lineAt(toBase ? toBase.mapPos(block.blockFrom) : block.blockFrom).number
            const to = base.lineAt(toBase ? toBase.mapPos(block.blockTo) : block.blockTo).number
            for (let number = from; number <= to; number++) held.add(number - 1)
        }
    }
    return held
}

/**
 * Press a button: start the new line or bullet at the end with the caret on it, as a placement.
 * A press while the last press's line is still untouched starts afresh from the text without it,
 * so pressing twice, or the other button, never stacks lines.
 */
export function startAtEnd(target: EndTarget, kind: EndKind): void {
    const state = target.state
    const untouched = state.field(untouchedLineField, false) ?? null
    const base = untouched ? untouched.undo.apply(state.doc) : state.doc
    const plan = planAtEnd(base, kind, heldLines(state, base, untouched?.undo ?? null))
    const planned = ChangeSet.of(plan.change ? [plan.change] : [], base.length)
    const changes = untouched ? untouched.undo.compose(planned) : planned
    const after = changes.apply(state.doc)
    const undo = planned.invert(base)
    let line: UntouchedLine | null = null
    if (!undo.empty) {
        const caretLine = after.lineAt(plan.caret)
        let addedFrom = caretLine.from
        undo.iterChangedRanges((fromA) => (addedFrom = Math.min(addedFrom, fromA)))
        line = { from: caretLine.from, to: caretLine.to, addedFrom, undo }
    }
    target.dispatch(
        state.update({
            // Pressing again over an untouched line can leave the text as it is: no change at all then.
            changes: after.eq(state.doc) ? undefined : changes,
            selection: EditorSelection.cursor(plan.caret),
            effects: setUntouchedLine.of(line),
            userEvent: 'select.end',
            annotations: Transaction.addToHistory.of(false),
            scrollIntoView: true,
        }),
    )
}

/**
 * Take an untouched line back out if the caret is already off it and no panel holds it, or at once
 * if an undo or redo put the person's text on it. The filter takes it back in the transaction that
 * moves the caret, but not after an edit elsewhere, and the history's undo and redo skip transaction
 * filters altogether, so those are caught here, in a transaction of their own
 * (`takeBackAfterUpdate`).
 */
export function takeBackIfLeft(target: EndTarget): void {
    const state = target.state
    const line = state.field(untouchedLineField, false)
    if (!line || heldByPanel(state, line)) return
    if (!line.displaced && selectionOn(state, line)) return
    target.dispatch(state.update({ changes: line.undo, effects: setUntouchedLine.of(null), annotations: takeBackAnnotations }))
}

/**
 * Calls `takeBackIfLeft` after an update that leaves an untouched line to take back, once the update
 * is over. A microtask rather than a dispatch from an update listener, as the caret clamp's selection
 * fix is: this changes the text, and a change dispatched while the update's listeners are still
 * running reaches every listener after this one (DocumentView's own among them) before the update
 * that caused it.
 */
const takeBackAfterUpdate = ViewPlugin.define((view) => {
    let destroyed = false
    return {
        update(update: ViewUpdate) {
            const line = update.state.field(untouchedLineField, false)
            if (!line || (!line.displaced && selectionOn(update.state, line))) return
            queueMicrotask(() => {
                if (!destroyed) takeBackIfLeft(view)
            })
        },
        destroy() {
            destroyed = true
        },
    }
})
