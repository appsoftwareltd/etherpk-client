/**
 * The two buttons in a row at the foot of a document's tab (ADR 0149, ADR 0168, Editor Content
 * Rules → End of document).
 *
 * Putting the caret where something new should go is fiddly, most of all on a phone, and a line can
 * sit under a code block or a map, where a caret at its end is in the fence's source. So each button
 * starts a new line with the caret on it: the text button an empty line, the bullet button a bullet.
 * With the caret in the document, the line goes after the caret's block (`startAfterCaret`): the text
 * button's after the caret's whole tree, which splits a list into two, the bullet button's as a
 * sibling of the caret's bullet. Without it, the line goes at the end (`startAtEnd`).
 *
 * A line the button started and nobody wrote on is taken back out, with the blank line the button
 * added before it, when the caret leaves it. The press and the take-back are placements, not edits:
 * neither is a step in the undo history, and a [[Draft]] takes both in without being created (the
 * press is a `select` event, the take-back carries `placementChange`, and cm-document.ts reports
 * neither as an edit). A line an inline panel comes to hold (`caretKeptOff`), as an [[Agent Chat]]
 * opened on the new bullet does, is kept: the person used it.
 */

import { ChangeSet, type ChangeDesc, EditorSelection, EditorState, type Extension, Prec, StateEffect, StateField, type Text, Transaction, type TransactionSpec } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

import { frontmatterLines } from '#lib/storage/fs/frontmatter-span.js'

import { type FencedBlockRange, fencedBlocks } from '../fenced-code'
import { branchRange, bulletContent, isBulletLine, isHeadingLine, lineIndent, ownerBulletIndex, taskDone, treeRootIndex } from '../outliner'
import { caretKeptOff } from './augmentations/interactive-fence'
import { placementChange } from './cm-document'

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

/** The last line of the caret's block, and what the button's line holds and how far below it starts. */
interface AfterBlock {
    /** 0-based. */
    end: number
    content: string
    /** Blank lines between the block and the new line. */
    gap: number
}

/**
 * Where the button's line goes after the block holding line `i`, by the rules in ADR 0168:
 *
 * - In a bullet, the bullet button adds a sibling at the bullet's depth after its branch, as Enter
 *   at the end of the block would. The text button goes after the bullet's whole tree, the branch
 *   of its top-level ancestor, as Mod+Enter leaves one: after the bullet's own branch, the nested
 *   lines that follow would be cut off from their parent by the text.
 * - Outside a list, after the code block, the heading or the paragraph (the lines up to a blank line,
 *   a bullet, a heading or a fence) the line is in, with a blank line first.
 * - A line at the margin never goes above indented lines that follow the block: a blank line or a
 *   line of text between them would leave those lines with no parent above them (an orphan). It
 *   goes after them, as far as the next line at the margin.
 */
function afterBlock(lines: string[], i: number, owner: number | null, kind: EndKind, blocks: FencedBlockRange[]): AfterBlock {
    if (owner !== null && kind === 'bullet') return { end: branchRange(lines, owner, blocks).end, content: ' '.repeat(lineIndent(lines[owner])) + BULLET, gap: 0 }
    const end = owner !== null ? branchRange(lines, treeRootIndex(lines, owner, blocks), blocks).end : blockEnd(lines, i, blocks)
    return { end: pastIndentedLines(lines, end), content: kind === 'bullet' ? BULLET : '', gap: 1 }
}

/** The last line of the code block, heading or paragraph holding line `i`, outside any list. */
function blockEnd(lines: string[], i: number, blocks: readonly FencedBlockRange[]): number {
    const fence = blocks.find((block) => block.start <= i && i <= block.end)
    if (fence) return fence.end
    if (isHeadingLine(lines[i])) return i
    const paragraphGoesOn = (j: number) =>
        j < lines.length && lines[j].trim() !== '' && !isBulletLine(lines[j]) && !isHeadingLine(lines[j]) && !blocks.some((block) => block.start === j)
    let end = i
    while (paragraphGoesOn(end + 1)) end++
    return end
}

/** `end`, or the last of the indented lines that follow it, blank lines between them included. */
function pastIndentedLines(lines: readonly string[], end: number): number {
    for (;;) {
        let next = end + 1
        while (next < lines.length && lines[next].trim() === '') next++
        if (next >= lines.length || lineIndent(lines[next]) === 0) return end
        end = next
    }
}

/**
 * The line a caret on line `i` stands for: the line itself; in a code block, the block's opening
 * fence, since a bullet-shaped line there is code; or, on a blank line that belongs to no bullet,
 * the text above it. Null in the frontmatter and above the body's first text.
 */
function caretTextLine(lines: string[], i: number, blocks: readonly FencedBlockRange[]): number | null {
    const body = frontmatterLines(lines)
    if (i < body) return null
    // The outermost block around the line, from its opener on: its lines are code, never structure.
    const fence = blocks.filter((block) => block.start < i && i <= block.end).sort((a, b) => a.start - b.start)[0]
    if (fence && fence.start >= body) return fence.start
    if (lines[i].trim() !== '' || ownerBulletIndex(lines, i, blocks as FencedBlockRange[]) !== null) return i
    let text = i
    while (text >= body && lines[text].trim() === '') text--
    return text < body ? null : text
}

/**
 * Where a press puts its new line or bullet in `doc` with the caret on line `caretLine` (0-based):
 * after the caret's block ({@link afterBlock}). A caret on a blank line counts as on the text above
 * it, and a caret in the frontmatter, or on a blank line with no text above it, as no caret at all
 * ({@link planAtEnd}). A new text line, and a new bullet outside a list before text that is not a
 * bullet, gets a blank line after it as well, so what is typed on it is not read as part of what follows. Blank
 * lines already below the block stay where they are, below the new line.
 */
export function planAfterCaret(doc: Text, kind: EndKind, caretLine: number, held: ReadonlySet<number> = new Set()): EndPlan {
    const lines = doc.toString().split('\n')
    const blocks = fencedBlocks(lines)
    const i = caretTextLine(lines, caretLine, blocks)
    if (i === null) return planAtEnd(doc, kind, held)
    const { end, content, gap } = afterBlock(lines, i, ownerBulletIndex(lines, i, blocks), kind, blocks)
    let next = end + 1
    while (next < lines.length && lines[next].trim() === '') next++
    const blanks = next - end - 1
    // A sibling bullet (no gap) sits in its list as Enter leaves one, with nothing after it: a line
    // that follows is the list's own, such as a paragraph after a sublist (ADR 0089).
    const after = next < lines.length && (kind === 'line' || (gap > 0 && !isBulletLine(lines[next]))) ? 1 : 0
    const at = doc.line(end + 1).to
    const insert = '\n'.repeat(gap + 1) + content + '\n'.repeat(Math.max(0, after - blanks))
    return { change: { from: at, to: at, insert }, caret: at + gap + 1 + content.length }
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
    /** Which press started it: at the end, or after the caret. A press again while the caret is on it plans the same way. */
    planner: Planner
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
        planner: line.planner,
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

/**
 * Room kept below a caret scrolled into view, in CSS pixels. The line a press starts, and any caret
 * moved near the foot of the pane, then sits a few lines above the buttons' row instead of flush
 * against it, and a menu that opens at the caret (a completion, the Command Menu) has somewhere to
 * open below it when the text above fills the pane (ADR 0168).
 */
const ROOM_BELOW_CARET_PX = 80

/** Keeps a caret scrolled into view clear of the pane's foot. Given to a tab's editors, not an embedded one. */
export const roomBelowCaret: Extension = EditorView.scrollMargins.of(() => ({ bottom: ROOM_BELOW_CARET_PX }))

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
 * Press a button with no caret in the document: start the new line or bullet at the end with the
 * caret on it, as a placement.
 */
export function startAtEnd(target: EndTarget, kind: EndKind): void {
    start(target, kind, 'end')
}

/** Press a button with the caret in the document: start the new line or bullet after the caret's block ({@link planAfterCaret}). */
export function startAfterCaret(target: EndTarget, kind: EndKind): void {
    start(target, kind, 'caret')
}

/** Which way a press plans its line: at the end, or after the caret's block. */
type Planner = 'end' | 'caret'

/** The press's plan against `base`, the text without the untouched line, with the caret mapped into it. */
function planPress(state: EditorState, base: Text, untouched: UntouchedLine | null, kind: EndKind, planner: Planner): EndPlan {
    const held = heldLines(state, base, untouched?.undo ?? null)
    if (planner === 'end') return planAtEnd(base, kind, held)
    const head = state.selection.main.head
    const caret = untouched ? untouched.undo.mapPos(head, -1) : head
    return planAfterCaret(base, kind, base.lineAt(caret).number - 1, held)
}

/** The line a press started, to take back if left untouched; null when the press wrote nothing. */
function untouchedAfter(after: Text, caret: number, undo: ChangeSet, planner: Planner): UntouchedLine | null {
    if (undo.empty) return null
    const caretLine = after.lineAt(caret)
    let addedFrom = caretLine.from
    undo.iterChangedRanges((fromA) => (addedFrom = Math.min(addedFrom, fromA)))
    return { from: caretLine.from, to: caretLine.to, addedFrom, undo, planner }
}

/**
 * Make a press, planned against the text without any untouched line, with the lines a panel holds
 * there and the caret mapped into it. A press while the last press's line is still untouched starts
 * afresh from the text without it, so pressing twice, or the other button, never stacks lines. With
 * the caret still on that line it plans as the press that started it did: the caret was put there,
 * not placed after a block, and a line at the end stays at the end.
 */
function start(target: EndTarget, kind: EndKind, asked: Planner): void {
    const state = target.state
    const untouched = state.field(untouchedLineField, false) ?? null
    const base = untouched ? untouched.undo.apply(state.doc) : state.doc
    const planner = untouched && selectionOn(state, untouched) ? untouched.planner : asked
    const plan = planPress(state, base, untouched, kind, planner)
    const planned = ChangeSet.of(plan.change ? [plan.change] : [], base.length)
    const changes = untouched ? untouched.undo.compose(planned) : planned
    const after = changes.apply(state.doc)
    const line = untouchedAfter(after, plan.caret, planned.invert(base), planner)
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
