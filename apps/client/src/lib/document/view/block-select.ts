/**
 * Block-granular selection for the outliner (ADR 0021). A selection that reaches from one block into
 * another snaps to WHOLE blocks, so every touched block — its bullet marker, continuation lines and code
 * included — reads as selected and deletes as a unit (Logseq-style). Each selected block brings every
 * block nested under it: the selection runs on to the end of its last branch, exactly the lines Tab and
 * Shift-Tab move ([[Block Selection]]). This makes "what will be deleted" unambiguous, and fixes the
 * character-selection quirk where the line the caret just reached shows nothing selected.
 *
 * A range inside one block stays character-precise, across its continuation lines and into its own
 * code too, as a selection inside a Logseq block's editor does. Deciding by block rather than by line
 * is what keeps the highlight steady during a drag: judged by whether the top line was a bullet line,
 * a selection flipped between text range and block selection as it crossed a continuation line.
 *
 * Implemented as a transaction filter over pure selection changes (Shift-arrow AND mouse-drag both flow
 * through here), so it needs no separate keymap or pointer handling. A selection that starts in prose
 * or a heading stays character-precise, whatever it reaches below. Shrinking is the exception: a
 * Shift-arrow that shrinks the selection by one line would land inside a selected branch and be
 * snapped straight back, so those two presses step by branch or block ({@link shrinkBlockSelectionUp}).
 *
 * Typing over a block selection replaces the blocks with one block in the first one's place
 * ({@link blockSelectionReplacement}): the selection starts at column 0, so an ordinary replace would
 * take the first block's indent and marker with it and leave the next block without a parent.
 */

import { type ChangeSpec, EditorSelection, EditorState, type Extension, type SelectionRange, type StateCommand, StateEffect, StateField, type Text, type Transaction, type TransactionSpec } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'

import { type FencedBlockRange, fencedBlocks } from '../fenced-code'
import { outlineLines, type OutlineLine } from '../indent-unit'
import { branchesWithin, contentStart, lineIndent, newBulletMarker } from '../outliner'
import { editorAnalysisField } from './analysis/editor-analysis'
import { editorHistory } from './editor-history'
import { withSelection } from './with-selection'

/** The editor class carried while the selection is block-granular; the caret is hidden under it. */
export const BLOCK_SELECTED_CLASS = 'gk-block-selected'

/**
 * Each line's block: `owner` is the 0-based index of the bullet whose block the line belongs to (its
 * bullet line, continuation lines and fenced code), or -1 for prose, a heading, a bare blank line or
 * frontmatter. Read from the shared analysis, which the outline walk (ADR 0067) fills once per document
 * change, so the filter below scans nothing on each mouse move of a drag.
 */
function lineOwners(state: EditorState): readonly OutlineLine[] {
    return state.field(editorAnalysisField, false)?.outline ?? outlineLines(state.doc.toString().split('\n'))
}

/**
 * The document's lines and fenced blocks, read from the shared analysis like {@link lineOwners}, so a
 * drag splits and scans nothing on each mouse move. Read only: the analysis owns the arrays.
 */
function linesAndBlocks(state: EditorState): { lines: readonly string[]; blocks: readonly FencedBlockRange[] } {
    const analysis = state.field(editorAnalysisField, false)
    if (analysis) return { lines: analysis.lines, blocks: analysis.fencedBlocks }
    const lines = state.doc.toString().split('\n')
    return { lines, blocks: fencedBlocks(lines) }
}

/**
 * The branches rooted within lines `first`…`last`, each from its root to its last descendant
 * (`branchesWithin`), read with the code the editor shows: a fence still being typed is text.
 */
function branchesIn(state: EditorState, first: number, last: number): { start: number; end: number }[] {
    const { lines, blocks } = linesAndBlocks(state)
    return branchesWithin(lines, first, last, blocks)
}

/**
 * The branches a block selection covers, the ones Tab and Shift-Tab move together, and the lines it
 * runs over. The snap reads the same branches, so what is highlighted is what the keys move. Null for
 * a caret, a text range and a prose selection.
 */
export function selectedBranches(state: EditorState): { branches: { start: number; end: number }[]; firstLine: number; lastLine: number } | null {
    const main = state.selection.main
    if (!isBlockRange(state, main)) return null
    const { first, last } = touchedLines(state.doc, main)
    return { branches: branchesIn(state, first, last), firstLine: first, lastLine: last }
}

/**
 * The last line of the branches rooted within lines `first`…`last`, or `last` itself when that is
 * further: a blank, prose or heading line after them. Only the last branch can reach past `last`,
 * since an earlier one ends before the next root starts.
 */
function branchesEnd(state: EditorState, first: number, last: number): number {
    const branches = branchesIn(state, first, last)
    return branches.length ? Math.max(last, branches[branches.length - 1].end) : last
}

/** The 0-based indexes of the first and last lines `range` touches. */
function touchedLines(doc: Text, range: SelectionRange): { first: number; last: number } {
    return { first: doc.lineAt(range.from).number - 1, last: doc.lineAt(range.to).number - 1 }
}

/** Whether lines `first`…`last` start inside a block and reach a line of another block, or of none. */
function spansBlocks(owners: readonly OutlineLine[], first: number, last: number): boolean {
    const owner = owners[first].owner
    if (owner < 0) return false // starts in prose: character-precise whatever it reaches
    for (let n = first + 1; n <= last; n++) if (owners[n].owner !== owner) return true
    return false
}

/**
 * Whether `range` is block-granular: it starts inside an outliner block and reaches another one (the
 * same test the filter below snaps on). A range inside one block, a range within one line and a prose
 * selection are character-precise.
 */
export function isBlockRange(state: EditorState, range: SelectionRange): boolean {
    if (range.empty) return false
    const { first, last } = touchedLines(state.doc, range)
    return first !== last && spansBlocks(lineOwners(state), first, last)
}

/**
 * Whether the main selection is a block-granular one ({@link isBlockRange}). The caret has no meaning
 * when whole blocks are selected, so it is hidden; a text range keeps its caret.
 */
export function isBlockSelection(state: EditorState): boolean {
    return isBlockRange(state, state.selection.main)
}

/**
 * The block the main selection lies inside when it runs across more than one of that block's lines
 * (its bullet line and a continuation, or on into its code): the 0-based index of the block's bullet
 * line. Null for a caret, a range within one line, a block selection and a prose selection. Tab and
 * Shift-Tab act on this block, as they do from a caret on its bullet line.
 */
export function rangeBlockOwner(state: EditorState): number | null {
    const main = state.selection.main
    if (main.empty) return null
    const { first, last } = touchedLines(state.doc, main)
    if (first === last) return null
    const owners = lineOwners(state)
    const owner = owners[first].owner
    return owner >= 0 && !spansBlocks(owners, first, last) ? owner : null
}

/**
 * `main` snapped to whole blocks, when it is a block selection that does not already cover them;
 * null otherwise (a caret, a text range, a prose selection, or one already whole). The first block is
 * taken back to its bullet line and the last on through its remaining continuation and code lines;
 * the lines between are whole already. Then every selected block brings its descendants: the end runs
 * on to the end of the last selected branch ({@link branchesEnd}), its children, a paragraph it resumes
 * after them (as CommonMark writes it) and their code included, so the highlight is what Tab moves and
 * what a delete removes. The drag direction is kept, so Shift-arrow keeps extending naturally.
 */
export function snappedBlockSelection(state: EditorState, main: SelectionRange): EditorSelection | null {
    if (!isBlockRange(state, main)) return null
    const { doc } = state
    const owners = lineOwners(state)
    let { first, last } = touchedLines(doc, main)
    const top = owners[first].owner
    while (first > 0 && owners[first - 1].owner === top) first--
    const bottom = owners[last].owner
    if (bottom >= 0) while (last + 1 < owners.length && owners[last + 1].owner === bottom) last++
    last = branchesEnd(state, first, last)
    const from = doc.line(first + 1).from
    const to = doc.line(last + 1).to
    const forward = main.head >= main.anchor
    const anchor = forward ? from : to
    const head = forward ? to : from
    if (anchor === main.anchor && head === main.head) return null // already whole
    return EditorSelection.single(anchor, head)
}

/**
 * The own text of the block whose bullet is line `owner`: from its content column (past the marker
 * and any checkbox) to the end of its last continuation or code line, children left out. What a
 * shrinking Shift-arrow leaves when one block is all that would remain, as a drag that comes back
 * into one block leaves a text range.
 */
function ownText(state: EditorState, owners: readonly OutlineLine[], owner: number, headFirst: boolean): EditorSelection {
    let end = owner
    while (end + 1 < owners.length && owners[end + 1].owner === owner) end++
    const bullet = state.doc.line(owner + 1)
    const from = bullet.from + contentStart(bullet.text)
    const to = state.doc.line(end + 1).to
    return headFirst ? EditorSelection.single(to, from) : EditorSelection.single(from, to)
}

/**
 * A selection made downwards, less its last branch: whole, as Tab would move it, and with any blank or
 * prose lines before it. When only the start block's branch would remain, the start block's own text.
 * Null when the head is on a blank or prose line after the last branch: CodeMirror's line move takes it
 * back one line, as Shift+Down brought it, and the snap keeps that.
 */
function withoutLastBranch(state: EditorState, main: SelectionRange, first: number, last: number): EditorSelection | null {
    const owners = lineOwners(state)
    const branches = branchesIn(state, first, last)
    if (branches.length === 0 || last > branches[branches.length - 1].end) return null
    if (branches.length >= 2) {
        const end = branches[branches.length - 2].end
        const shrunk = EditorSelection.range(main.anchor, state.doc.line(end + 1).to)
        if (isBlockRange(state, shrunk)) return EditorSelection.create([shrunk])
    }
    return ownText(state, owners, owners[first].owner, false)
}

/**
 * A selection made upwards, less its top block: that block's own lines only, so its children stay
 * selected, as a drag back down into its first child leaves them. Blank and prose lines below the
 * block go with it. When one block would remain, that block's own text; null when nothing would.
 * The next block starts at a line the outline walk reads as a bullet (one that owns itself), never at
 * a `- ` line in code or one led by a character the walk does not read as indentation.
 */
function withoutTopBlock(state: EditorState, main: SelectionRange, first: number, last: number): EditorSelection | null {
    const owners = lineOwners(state)
    const top = owners[first].owner
    let next = first
    while (next <= last && owners[next].owner === top) next++
    while (next <= last && owners[next].owner !== next) next++
    if (next > last) return null
    const shrunk = EditorSelection.range(main.anchor, state.doc.line(next + 1).from)
    return isBlockRange(state, shrunk) ? EditorSelection.create([shrunk]) : ownText(state, owners, owners[next].owner, true)
}

/**
 * Shift-Up and Shift-Down over a block selection, when the press shrinks it: the head comes back
 * towards the anchor by a whole branch (Shift-Up on a selection made downwards) or a whole block
 * (Shift-Down on one made upwards), never by a line the snap would take straight back. A growing
 * press, a caret and a text range fall through to CodeMirror's line move, which the snap then widens
 * to whole branches (Logseq: Shift-Down adds the next block with its children, Shift-Up steps up
 * through the children of the branch above).
 */
function shrinkBlockSelection(dir: 'up' | 'down'): StateCommand {
    return ({ state, dispatch }) => {
        const main = state.selection.main
        if (state.selection.ranges.length > 1 || !isBlockRange(state, main)) return false
        const madeUpwards = main.head < main.anchor
        if (madeUpwards !== (dir === 'down')) return false // a growing press
        const { first, last } = touchedLines(state.doc, main)
        const selection = dir === 'up' ? withoutLastBranch(state, main, first, last) : withoutTopBlock(state, main, first, last)
        if (!selection) return false
        dispatch(state.update({ selection, userEvent: 'select', scrollIntoView: true }))
        return true
    }
}

/** Shift-Up over a block selection made downwards: drop its last branch. */
export const shrinkBlockSelectionUp: StateCommand = shrinkBlockSelection('up')

/** Shift-Down over a block selection made upwards: drop its top block, its children kept. */
export const shrinkBlockSelectionDown: StateCommand = shrinkBlockSelection('down')

/**
 * Where a block selection's replacement starts when the selection takes the first block's marker:
 * that block's line, and the indent and marker typing over it keeps (a task's, open again). Null when
 * the selection starts after the marker, which an ordinary replace keeps anyway.
 */
function keptLead(state: EditorState, main: SelectionRange): { from: number; lead: string } | null {
    const owner = lineOwners(state)[state.doc.lineAt(main.from).number - 1].owner
    const bullet = state.doc.line(owner + 1)
    if (main.from >= bullet.from + contentStart(bullet.text)) return null
    return { from: bullet.from, lead: bullet.text.slice(0, lineIndent(bullet.text)) + newBulletMarker(bullet.text) }
}

/**
 * The block selection replaced by `text`, as typing over it replaces it: the blocks go, and one block
 * takes the first one's place, at its indent and with its marker (a task's open again), `text` its
 * content and the caret after it. A line break leaves the block empty, so Enter over the selection
 * leaves one empty block. The selection starts at column 0, so an ordinary replace would take the
 * first block's indent and marker too, and the block after the selection would be left indented
 * under a line of prose: no parent. Null for a caret, a text range and a prose selection. A selection
 * that starts after the first block's marker keeps what is before it, as an ordinary replace does.
 */
export function blockSelectionReplacement(state: EditorState, text: string, range: SelectionRange = state.selection.main): { changes: ChangeSpec; selection: EditorSelection } | null {
    if (!isBlockRange(state, range)) return null
    const typed = text.includes('\n') ? '' : text
    const kept = keptLead(state, range)
    const from = kept ? kept.from : range.from
    const insert = (kept?.lead ?? '') + typed
    return { changes: { from, to: range.to, insert }, selection: EditorSelection.single(from + insert.length) }
}

/**
 * A block selection a keyboard collapsed to a caret before typing over it, until the next change.
 * GBoard, reading the editor through an EditContext (Chrome on Android), types over a selection in
 * three steps: it moves the caret to the selection's end, deletes the range it had selected, and
 * inserts its text at the caret. By the deletion the editor's selection is a caret, so the deletion is
 * matched against the block selection remembered here ({@link typedOverBlocks}). Any edit, or any
 * other move of the selection, forgets it.
 */
const collapsedBlockSelection = StateField.define<{ from: number; to: number } | null>({
    create: () => null,
    update(value, tr) {
        if (tr.docChanged) return null
        if (!tr.selection) return value
        const before = tr.startState.selection.main
        return tr.newSelection.main.empty && isBlockRange(tr.startState, before) ? { from: before.from, to: before.to } : null
    },
})

/**
 * The block selection a transaction types over, and the text it leaves there: the main selection when
 * it is a block selection the transaction replaces ({@link replacedSelectionText}), or a block selection
 * a keyboard collapsed just before, when the transaction replaces exactly that range. Null otherwise.
 */
export function typedOverBlocks(tr: Transaction): { range: SelectionRange; text: string } | null {
    const main = tr.startState.selection.main
    if (isBlockRange(tr.startState, main)) {
        const text = replacedSelectionText(tr)
        return text === null ? null : { range: main, text }
    }
    const collapsed = tr.startState.field(collapsedBlockSelection, false)
    if (!collapsed || !main.empty || !tr.docChanged) return null
    let count = 0
    let text: string | null = null
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        count += 1
        if (fromA === collapsed.from && toA === collapsed.to) text = inserted.toString()
    })
    const range = EditorSelection.range(collapsed.from, collapsed.to)
    return count === 1 && text !== null && isBlockRange(tr.startState, range) ? { range, text } : null
}

/**
 * The text a transaction leaves where the main selection was, when every change it makes lies inside
 * the selection: how typing over a selection reads, whether the change spans the whole selection or
 * is trimmed to what differs. CodeMirror trims what it reads from the page (a keypress, an input
 * method's text) to the smallest change, so a typed `t` over a selection that ends in `t` arrives as
 * "delete all but that last t". Null for a caret, when a change reaches outside the selection, and
 * when nothing selected is deleted: a line inserted at the selection's end (CodeMirror's Mod-Enter) is
 * not typing over it.
 */
export function replacedSelectionText(tr: Transaction): string | null {
    const sel = tr.startState.selection.main
    if (sel.empty || !tr.docChanged) return null
    let inside = true
    let deletes = false
    tr.changes.iterChangedRanges((fromA, toA) => {
        if (fromA < sel.from || toA > sel.to) inside = false
        if (toA > fromA) deletes = true
    })
    return inside && deletes ? tr.newDoc.sliceString(tr.changes.mapPos(sel.from, -1), tr.changes.mapPos(sel.to, 1)) : null
}

export function blockSelection(): Extension {
    return [blockSelectionFilter(), resnapAfterEdit, hideCaretForBlockSelection, collapsedBlockSelection, compositionOverBlocks]
}

/**
 * An IME composition over a block selection: on Android every word GBoard types is one, as are the
 * words of a Chinese or Japanese input method. The editor never changes text beside a composition in
 * progress, since a change there can break it, so the deleteHeal filter's rewrite of a typed character
 * cannot be made to a composition's changes. How the replacement is made depends on whether the
 * keyboard says a key is coming, and on how CodeMirror reads input:
 *
 * - A phone keyboard (and a desktop input method) announces each key with a keydown whose key code is
 *   229 before any text arrives. No composition has started then, on either path, so the blocks are
 *   replaced by an empty block at once and the word types into it from its first letter.
 * - Through an EditContext (Chrome on Android), the composition events fire on the context. The blocks
 *   are replaced by an empty block when the composition starts, before it has any text, and it types
 *   into that block.
 * - Through the content element (a desktop input method, and browsers without an EditContext), the
 *   browser has already fixed the range it composes into when `compositionstart` fires, and changing
 *   the text then doubles letters. So the composition replaces the selection from column 0 as typed,
 *   the first block's indent and marker are remembered ({@link lostLead}), and they are put back in
 *   front of the composed text once the composition has ended.
 */
const lostLead = StateEffect.define<{ pos: number; lead: string } | null>()

/**
 * The indent and marker a composition took from the first selected block, and where to put them back.
 * Kept only through the composition's own changes: any other edit (an undo, a collaborator's change)
 * means the line is no longer the one the composition typed, and it is forgotten.
 */
const pendingLead = StateField.define<{ pos: number; lead: string } | null>({
    create: () => null,
    update(value, tr) {
        for (const effect of tr.effects) if (effect.is(lostLead)) return effect.value
        if (!value || !tr.docChanged) return value
        if (!tr.isUserEvent('input.type.compose')) return null
        // Text the composition types at the line's start goes after the lead, so the position stays put.
        return { pos: tr.changes.mapPos(value.pos, -1), lead: value.lead }
    },
})

/** A composition's first change over a block selection that took its marker: remember what it took. */
const rememberLostLead = EditorState.transactionExtender.of((tr) => {
    if (!tr.isUserEvent('input.type.compose') || !tr.docChanged) return null
    const over = typedOverBlocks(tr)
    const kept = over && keptLead(tr.startState, over.range)
    return kept && { effects: lostLead.of({ pos: kept.from, lead: kept.lead }) }
})

/**
 * The transaction that puts the remembered indent and marker back, once no composition is in progress
 * (`compositionStarted` is the view's); null while one is, or when nothing is remembered. It carries
 * the composition's own user event, which CodeMirror's history always joins to the step before it, so
 * one undo takes the composition and the restored marker together, even after a click ended it.
 */
export function lostLeadRestore(state: EditorState, compositionStarted: boolean): TransactionSpec | null {
    const pending = state.field(pendingLead, false)
    if (!pending || compositionStarted) return null
    // Only at the start of a line: anything else means the text was edited since, and is left alone.
    if (state.doc.lineAt(pending.pos).from !== pending.pos) return { effects: lostLead.of(null) }
    return { changes: { from: pending.pos, insert: pending.lead }, effects: lostLead.of(null), userEvent: 'input.type.compose' }
}

/**
 * Restore outside the update that noticed the composition end, so every update listener sees the
 * composition's last change before the restore. The collaborative history joins it by being told to.
 */
function restoreLostLead(view: EditorView): void {
    const spec = lostLeadRestore(view.state, view.compositionStarted)
    if (!spec) return
    const { joinNext } = view.state.facet(editorHistory)
    if (joinNext && spec.changes) joinNext(() => view.dispatch(spec))
    else view.dispatch(spec)
}

function replaceForComposition(view: EditorView): void {
    const replacement = blockSelectionReplacement(view.state, '')
    if (replacement) view.dispatch({ ...replacement, userEvent: 'delete.selection', scrollIntoView: true })
}

const compositionOverBlocks = [
    pendingLead,
    rememberLostLead,
    EditorView.domEventHandlers({
        keydown(event, view) {
            // 229 is the key code of a key an input method handles; text follows it, composed or not.
            if (event.keyCode === 229 && !view.compositionStarted) replaceForComposition(view)
            return false
        },
    }),
    EditorView.updateListener.of((update) => {
        if (update.state.field(pendingLead, false)) queueMicrotask(() => restoreLostLead(update.view))
    }),
    // The composition's last change can reach the editor before compositionend, leaving no update after
    // it to restore from; CodeMirror flushes what is left within a few milliseconds of the event.
    EditorView.domEventObservers({
        compositionend(_event, view) {
            setTimeout(() => restoreLostLead(view), 50)
        },
    }),
    ViewPlugin.fromClass(
        class {
            private context: EventTarget | null = null
            private readonly onStart = () => replaceForComposition(this.view)

            constructor(private readonly view: EditorView) {
                this.attach()
            }

            update() {
                this.attach()
            }

            destroy() {
                this.context?.removeEventListener('compositionstart', this.onStart)
            }

            /** Follow the EditContext CodeMirror has on the content element (it attaches one only where it reads input through it). */
            private attach() {
                const context = (this.view.contentDOM as HTMLElement & { editContext?: EventTarget | null }).editContext ?? null
                if (context === this.context) return
                this.context?.removeEventListener('compositionstart', this.onStart)
                context?.addEventListener('compositionstart', this.onStart)
                this.context = context
            }
        },
    ),
]

const hideCaretForBlockSelection = [
    EditorView.editorAttributes.compute(['selection'], (state) => ({ class: isBlockSelection(state) ? BLOCK_SELECTED_CLASS : '' })),
    // drawSelection shows the caret with `&.cm-focused > .cm-scroller > .cm-cursorLayer .cm-cursor` (five
    // classes); one more class here outranks it.
    EditorView.baseTheme({ [`&.${BLOCK_SELECTED_CLASS}.cm-focused > .cm-scroller > .cm-cursorLayer .cm-cursor`]: { display: 'none' } }),
]

function blockSelectionFilter(): Extension {
    return EditorState.transactionFilter.of((tr) => {
        if (!tr.selection || !tr.changes.empty) return tr // only pure selection moves (no doc edit)
        const snapped = snappedBlockSelection(tr.startState, tr.newSelection.main) // doc unchanged (no doc edit)
        return snapped ? withSelection(tr, snapped) : tr
    })
}

/**
 * The filter above snaps pure selection moves only, so a document change can leave a block selection
 * short of whole branches, and the snap is re-asserted after one. Undo and redo are dispatched past
 * every transaction filter (`filter: false`), and a redo maps the selection it restores forward
 * through the change it re-applies: redoing a Tab over a block selection lands the selection's start
 * after the re-inserted indent, two columns into the first line, and a Backspace from there would
 * leave the indent behind as stray spaces. An edit from elsewhere (a collaborator's, or an agent's) can
 * add a child under the last selected block, which Tab would then move unhighlighted. Tab and Shift-Tab
 * snap their own selection in the same transaction (the outliner keymap), so this finds them whole.
 */
const resnapAfterEdit = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return
    const snapped = snappedBlockSelection(update.state, update.state.selection.main)
    if (snapped) update.view.dispatch({ selection: snapped, userEvent: 'select' })
})
