/**
 * The editor of the cell being edited in a Table Grid (CONTEXT.md → Table Grid, ADR 0205).
 *
 * A table is drawn as a grid in place of its text, so the caret cannot be drawn in it. While the
 * document's caret is in a cell (`activeCell`, table-cell.ts) a second, small editor is mounted in
 * that cell of the grid and takes the keyboard. It holds the cell's text and nothing else:
 *
 * - **The document editor stays the only holder of the text.** A change typed in the cell is sent
 *   to the document editor as the same change at the cell's place in its row ({@link fromCell}), so
 *   it passes every guard there, joins the document's own undo history and reaches other devices
 *   as typing on a line does. What the document then holds is what the cell shows: a change the
 *   document refused or altered is put right in the cell, and another member's edit to the same
 *   cell arrives the same way.
 * - **The document's selection follows the cell's.** The Commands, the Command Bar and the table
 *   edits all read the document editor (`getActiveEditorView`), where the caret is in the cell's
 *   text, so each behaves as it does with the caret on a table's row. Only what opens at the caret
 *   (the Command Menu, a completion list, the Date Picker) opens in the cell's own editor, which
 *   {@link cellInputView} names.
 * - **One at a time.** The editor is made when the caret enters a cell and destroyed when it
 *   leaves, with the features a line has that make sense in one cell (`cellEditorExtensions`,
 *   editor-extensions.ts).
 *
 * The keys that move between cells are here too (Editor Content Rules.md → Tables): Tab and
 * Shift+Tab, Enter, the arrows at a cell's edge, and Escape.
 */

import { Annotation, type ChangeSet, type ChangeSpec, EditorState, type Extension, Facet, Prec, type StateCommand, Transaction, type TransactionSpec } from '@codemirror/state'
import { type Command, drawSelection, EditorView, type KeyBinding, keymap, tooltips, ViewPlugin, type ViewUpdate } from '@codemirror/view'

import { parseInertHtml } from '#lib/security/trusted-types.js'

import { cellsAsHtml, cellsAsMarkdown, cellsOfMarkdownTable, cellsOfTabbedText, cleanCellText, emptyCellGuards, HEADER_ROW } from '../../table-cells'
import { editorAnalysis } from '../analysis/editor-analysis'
import { selectAll } from '@codemirror/commands'

import { editorDefaultKeymap } from '../editor-default-keymap'
import { editorHistory, redoCommand, undoCommand } from '../editor-history'
import { isFindReplace, isFindSelect } from '../../find/find-edit'
import { minimalReplacement } from '../minimal-replacement'
import { type ActiveCell, activeCell, cellBlock, cellEditorHost, cellEditorRange, fromCell, gridInputsChanged } from '../table-cell'
import {
    allCellsSelected,
    cellAbove,
    cellAfter,
    cellBefore,
    cellBelow,
    cellBelowOrNewRow,
    clearSelectedCells,
    collapseCells,
    extendCells,
    leaveTable,
    nextCell,
    pasteCellsAtCaret,
    previousCell,
    selectAllCells,
    selectedCells,
} from '../table-cell-keys'
import { toggleBold, toggleHighlight, toggleItalic } from '../wrap-selection'
import { codeHighlighting, markdownWithCodeHighlight } from './code-highlight'
import { closePopovers } from './popover-menu'
import { cellFocusField, cellHasKeyboard, revealCellFocus } from './reveal-policy'

/** The class of the element the cell's editor is drawn in, inside its cell of the grid. */
export const CELL_EDITOR_CLASS = 'cm-table-cell-editor'

/** What the document editor's View gives the cell's editor. */
export interface CellEditorOptions {
    /** The document editor's features a cell keeps (`cellEditorExtensions`, editor-extensions.ts). Absent, a plain editor. */
    extensions?: () => Extension
    /** The cell's editor took the keyboard: the View makes its document and editor the active ones, as on the document editor's focus. */
    onFocus?: (documentView: EditorView) => void
}

/** Marks a transaction of the cell's editor that brings it in line with the document, and is not sent back. */
const cellSync = Annotation.define<boolean>()

/** How long after a press on the document's text its caret may still be on its way there (a touch screen places it late). */
const PRESS_SETTLES_MS = 700

/** A range of the document, or of the cell's text. */
interface Range {
    from: number
    to: number
}

function clamp(value: number, low: number, high: number): number {
    return Math.max(low, Math.min(value, high))
}

/** What transactions of the cell's editor changed, for sending on: their changes as one, and the last user event among them. */
interface CellChanges {
    changes: ChangeSet | null
    userEvent: string | undefined
}

/** What `transactions` changed in the cell's editor, or null when they changed neither its text nor its selection, or only brought it in line with the document. */
function cellChanges(transactions: readonly Transaction[]): CellChanges | null {
    let changes: ChangeSet | null = null
    let moved = false
    let userEvent: string | undefined
    for (const tr of transactions.filter((each) => !each.annotation(cellSync))) {
        if (tr.docChanged) changes = changes ? changes.compose(tr.changes) : tr.changes
        moved ||= tr.selection !== undefined
        userEvent = tr.annotation(Transaction.userEvent) ?? userEvent
    }
    return changes || moved ? { changes, userEvent } : null
}

class CellEditor {
    /** The element the cell's editor is drawn in. The grid's widget puts it in the cell (`markdown-table.ts`). */
    readonly host: HTMLElement
    /** The cell's editor, while the caret is in a cell. */
    nested: EditorView | null = null
    private cell: ActiveCell | null = null
    /** The range of the document the cell's editor shows: the cell's text, with any spaces typed at its ends. */
    private range: Range | null = null
    /** The cell's editor is being brought in line with the document: its transactions are not sent back. */
    private syncing = false
    /** Give the cell's editor the keyboard once it is in the page. */
    private wantFocus = false
    /** Give the document editor the keyboard back: the caret left the grid while the cell had it. */
    private returnFocus = false
    /** How far the change being sent on moves the start of the cell's text: a pipe written in front of it. */
    private ownShift = 0
    /** When a press last landed on the document's own text, outside every grid. */
    private pressedOutside = 0
    private destroyed = false

    constructor(
        readonly view: EditorView,
        private readonly options: CellEditorOptions,
    ) {
        this.host = view.dom.ownerDocument.createElement('div')
        this.host.className = CELL_EDITOR_CLASS
        // The grid is inside the document editor's own editable text. Without this the cell's editor would
        // be one more part of that text, and the keyboard given to it would go to the document editor.
        this.host.contentEditable = 'false'
        this.adopt(view.state, null)
    }

    update(update: ViewUpdate): void {
        if (update.docChanged || update.selectionSet || update.transactions.some(gridInputsChanged)) this.adopt(update.state, update)
    }

    destroy(): void {
        this.destroyed = true
        this.nested?.destroy()
        this.nested = null
    }

    /** The editor that has the caret: the cell's while one is drawn in the page, else the document's. */
    inputView(): EditorView {
        return this.nested && this.host.isConnected ? this.nested : this.view
    }

    /** Ask for the keyboard to go to the cell the caret is put in next: a press on a cell asked for it. */
    focusNext(): void {
        this.wantFocus = true
    }

    // ── Following the document ────────────────────────────────────────────────────────────

    /** Bring the cell's editor in line with `state`: make it, move it to another cell, renew its text, or remove it. */
    private adopt(state: EditorState, update: ViewUpdate | null): void {
        const shift = this.ownShift
        this.ownShift = 0
        const next = activeCell(state)
        if (!next) {
            this.unmount()
            return
        }
        const own = this.isOwn(update)
        const same = this.sameCell(next, update, own)
        const selection = state.selection.main
        const range = cellEditorRange(next, selection, same ? this.kept(update, own, shift) : null)
        this.show(state.sliceDoc(range.from, range.to), selection.anchor - range.from, selection.head - range.from, same, update)
        this.cell = next
        this.range = range
        // A caret on a divider or on the delimiter row is drawn in a cell: the document's is put where the cell's is.
        if (Math.min(selection.anchor, selection.head) < range.from || Math.max(selection.anchor, selection.head) > range.to) this.settleSelection()
    }

    /** Whether every transaction of `update` is the cell's own, sent on from its editor. */
    private isOwn(update: ViewUpdate | null): boolean {
        if (!this.nested || !this.range || !update || update.transactions.length === 0) return false
        return update.transactions.every((tr) => tr.annotation(fromCell) === true)
    }

    /** Whether the caret is still in the cell being edited: the same row and column of the same table. */
    private sameCell(next: ActiveCell, update: ViewUpdate | null, own: boolean): boolean {
        if (!this.nested || !this.cell || this.cell.row !== next.row || this.cell.column !== next.column) return false
        if (own) return true
        const from = this.cell.tableFrom
        if (!update) return from === next.tableFrom
        return update.changes.mapPos(from, -1) === next.tableFrom || update.changes.mapPos(from, 1) === next.tableFrom
    }

    /**
     * The range the cell's editor showed, as it is after `update`. The cell's own change leaves it
     * where it was, as long as the editor's text now is, and `shift` further on when a pipe was
     * written in front of it. Any other change carries it: another member's edit to the cell, or a
     * Command's insert at the caret.
     */
    private kept(update: ViewUpdate | null, own: boolean, shift: number): Range | null {
        if (!this.range || !this.nested) return null
        if (own) return { from: this.range.from + shift, to: this.range.from + shift + this.nested.state.doc.length }
        if (!update) return this.range
        return { from: update.changes.mapPos(this.range.from, -1), to: update.changes.mapPos(this.range.to, 1) }
    }

    /** Show `text` in the cell's editor with the selection at `anchor` and `head`, in the editor that is there or a new one. */
    private show(text: string, anchor: number, head: number, same: boolean, update: ViewUpdate | null): void {
        const within = (offset: number) => clamp(offset, 0, text.length)
        if (same) this.sync(text, within(anchor), within(head))
        else this.mount(text, within(anchor), within(head), update?.view.hasFocus ?? false)
        // Find put the selection on a match in this cell while the keyboard is in its box: that is
        // not the person typing here, so nothing opens at the caret (popover-menu.ts has the same rule).
        if (update?.transactions.some((tr) => isFindSelect(tr) || isFindReplace(tr))) this.nested?.dispatch({ effects: closePopovers.of(null), annotations: cellSync.of(true) })
    }

    private mount(text: string, anchor: number, head: number, documentFocused: boolean): void {
        const hadFocus = this.nested?.hasFocus ?? false
        this.nested?.destroy()
        this.host.replaceChildren()
        this.nested = new EditorView({
            parent: this.host,
            root: this.view.root as Document | ShadowRoot,
            state: EditorState.create({ doc: text, selection: { anchor, head }, extensions: this.extensions() }),
            dispatchTransactions: (transactions, nested) => this.sendOn(transactions, nested),
        })
        this.wantFocus ||= hadFocus || documentFocused
        this.returnFocus = false
    }

    private unmount(): void {
        if (this.nested) {
            this.returnFocus = this.nested.hasFocus
            this.nested.destroy()
            this.nested = null
            this.host.replaceChildren()
            this.host.remove()
            this.cellFocusChanged()
        }
        this.cell = null
        this.range = null
        this.wantFocus = false
    }

    /** Give the cell's editor the document's text and selection, where they differ. */
    private sync(text: string, anchor: number, head: number): void {
        const nested = this.nested!
        const change = minimalReplacement(nested.state.doc.toString(), text)
        const current = nested.state.selection.main
        if (!change && current.anchor === anchor && current.head === head) return
        this.syncing = true
        try {
            nested.dispatch({ ...(change ? { changes: change } : {}), selection: { anchor, head }, annotations: cellSync.of(true) })
        } finally {
            this.syncing = false
        }
    }

    /** Put the document's selection where the cell's editor has it, once the update in progress is done. */
    private settleSelection(): void {
        queueMicrotask(() => {
            if (this.destroyed || !this.nested || !this.range) return
            const { anchor, head } = this.nested.state.selection.main
            const { from } = this.range
            const main = this.view.state.selection.main
            if (main.anchor === from + anchor && main.head === from + head) return
            this.view.dispatch({ selection: { anchor: from + anchor, head: from + head }, annotations: fromCell.of(true) })
        })
    }

    // ── Sending the cell's changes on ─────────────────────────────────────────────────────

    /**
     * The cell's editor has transactions: apply them there, then send what they changed to the
     * document editor as one transaction of its own, at the cell's place. The document's guards and
     * filters have the last word, and what they leave is what the cell is then given back.
     */
    private sendOn(transactions: readonly Transaction[], nested: EditorView): void {
        nested.update(transactions)
        if (this.syncing || this.destroyed || nested !== this.nested || !this.range) return
        const sent = cellChanges(transactions)
        if (!sent) return
        this.view.dispatch(this.documentSpec(sent, nested, this.range))
        this.ownShift = 0
        // A transaction the document dropped whole leaves no update behind it: the cell is put right here.
        if (nested === this.nested && this.range && this.view.state.sliceDoc(this.range.from, this.range.to) !== nested.state.doc.toString()) this.adopt(this.view.state, null)
    }

    /** The document editor's transaction for what the cell's editor changed: the same changes at the cell's place, and its selection. */
    private documentSpec(sent: CellChanges, nested: EditorView, range: Range): TransactionSpec {
        const { from, to } = range
        const text = nested.state.doc.toString()
        const specs: ChangeSpec[] = []
        const guards = this.guards(sent.changes !== null && text.trim() === '')
        if (guards.before) specs.push({ from: this.cell!.open, insert: guards.before })
        sent.changes?.iterChanges((fromA, toA, _fromB, _toB, inserted) => specs.push({ from: from + fromA, to: from + toA, insert: inserted }))
        if (guards.after) specs.push({ from: this.cell!.close, insert: guards.after })
        // A backslash typed against the cell's closing pipe would escape it and join the next cell
        // to this one: a space keeps them apart.
        if (sent.changes && text.endsWith('\\') && this.view.state.sliceDoc(to, to + 1) === '|') specs.push({ from: to, insert: ' ' })
        const shift = guards.before.length
        this.ownShift = shift
        const { anchor, head } = nested.state.selection.main
        return {
            changes: specs,
            selection: { anchor: from + shift + anchor, head: from + shift + head },
            annotations: sent.userEvent === undefined ? [fromCell.of(true)] : [fromCell.of(true), Transaction.userEvent.of(sent.userEvent)],
        }
    }

    /**
     * The pipes the cell being edited needs written beside it to stay a cell once `emptied`
     * (`emptyCellGuards`): a row written without its outer pipes loses an end cell that is emptied.
     */
    private guards(emptied: boolean): { before: string; after: string } {
        const cell = this.cell
        if (!emptied || !cell) return { before: '', after: '' }
        const line = this.view.state.doc.lineAt(cell.from)
        return emptyCellGuards(line.text, cell.row === HEADER_ROW ? cell.table.headerStart : 0, cell.column)
    }

    // ── The keyboard ──────────────────────────────────────────────────────────────────────

    /** After the document editor has drawn: hand the keyboard to whichever editor is to have it. */
    afterUpdate(): void {
        if (this.returnFocus) {
            this.returnFocus = false
            if (!this.nested) this.view.focus()
        }
        // Drawing can move the grid's element in the page (a bullet's table is part of its line, which
        // is drawn again when the table's text changes), and an element that is moved loses the
        // keyboard to nothing at all. The cell had it, nothing else took it: it gets it back.
        const active = this.view.dom.ownerDocument.activeElement
        const dropped = this.nested !== null && !this.nested.hasFocus && cellHasKeyboard(this.view.state) && (!active || active === this.view.dom.ownerDocument.body)
        if (dropped && this.host.isConnected) this.wantFocus = true
        // The grid scrolled out of what the editor draws, and the cell's editor went with it: the
        // document editor takes the keyboard, with its caret in the cell's text, until the grid is drawn again.
        else if (dropped) this.view.focus()
        this.takeFocus()
    }

    /**
     * The grid's widget has put the host in a cell: the editor can take the keyboard now. `refocus`
     * says the move took the keyboard from it, as putting a focused element elsewhere does.
     */
    hostAttached(refocus: boolean): void {
        // The document editor has the keyboard with its caret in this cell: the grid was out of sight, and is drawn again.
        this.wantFocus ||= refocus || this.view.hasFocus
        if (this.wantFocus) queueMicrotask(() => this.takeFocus())
    }

    private takeFocus(): void {
        if (this.destroyed || !this.wantFocus || !this.nested || !this.host.isConnected) return
        this.wantFocus = false
        if (this.nested.hasFocus) return
        this.nested.focus()
        this.host.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }

    /**
     * The document editor took the keyboard while a cell is being edited: the keyboard belongs in the
     * cell, as when a dialog closes and hands the keyboard back to the editor. Not after a press on
     * the document's own text: the caret is on its way there, and on a touch screen it gets there
     * only after the keyboard does, since the browser places it and CodeMirror reads it afterwards.
     */
    documentFocused(): void {
        const afterPress = performance.now() - this.pressedOutside < PRESS_SETTLES_MS
        this.pressedOutside = 0
        if (afterPress) {
            // Only out of a cell: with no cell being edited the selection in the page is the document editor's own to read.
            if (this.nested) this.readPageSelection()
            return
        }
        queueMicrotask(() => {
            if (!this.destroyed && this.nested && this.host.isConnected && this.view.hasFocus) this.nested.focus()
        })
    }

    /**
     * Take the caret a finger's press put in the document's text as the document's selection, now.
     * The browser places it and CodeMirror reads it when the browser says it changed. Firefox says
     * so while the cell still has the keyboard, which CodeMirror takes to be no change of its own,
     * and then writes the selection it has, still in the cell, over the one the press made.
     */
    private readPageSelection(): void {
        const selection = this.view.dom.ownerDocument.getSelection()
        const { anchorNode, focusNode } = selection ?? {}
        if (!selection || !anchorNode || !focusNode) return
        const inText = (node: Node) => this.view.contentDOM.contains(node) && !(node instanceof Element ? node : node.parentElement)?.closest('.cm-md-table')
        if (!inText(anchorNode) || !inText(focusNode)) return
        const anchor = this.view.posAtDOM(anchorNode, selection.anchorOffset)
        const head = this.view.posAtDOM(focusNode, selection.focusOffset)
        const main = this.view.state.selection.main
        if (main.anchor !== anchor || main.head !== head) this.view.dispatch({ selection: { anchor, head }, userEvent: 'select.pointer' })
    }

    /** A press landed in the document editor: remembered when it is on the document's own text, outside every grid. */
    pressed(target: EventTarget | null): void {
        this.pressedOutside = target instanceof Element && !target.closest('.cm-md-table') ? performance.now() : 0
    }

    /** The cell's editor gained or lost the keyboard. Read once the event is over, so a move from cell to cell says so once. */
    cellFocusChanged(): void {
        queueMicrotask(() => {
            if (this.destroyed) return
            const focused = this.nested?.hasFocus ?? false
            if (cellHasKeyboard(this.view.state) !== focused) this.view.dispatch({ effects: revealCellFocus.of(focused) })
            if (focused) this.options.onFocus?.(this.view)
        })
    }

    // ── The cell's editor ─────────────────────────────────────────────────────────────────

    private extensions(): Extension[] {
        return [
            cellEditorHost.of(this.view),
            // What opens at the caret is drawn in the document editor's own element, as its menus are. In
            // the cell's it would be cut off by the grid, which scrolls sideways and so clips what is in it.
            tooltips({ parent: this.view.dom }),
            // Above the cell's features' own keys, below an open menu's (popover-menu.ts binds at the highest).
            Prec.high(keymap.of(cellKeys(this.view))),
            cleanInput,
            drawSelection(),
            keymap.of([...editorDefaultKeymap]),
            // Undo and redo are the document's: the cell has no history of its own.
            editorHistory.of({
                undo: () => undoCommand(this.view),
                redo: () => redoCommand(this.view),
                undoDepth: () => this.view.state.facet(editorHistory).undoDepth(this.view.state),
                redoDepth: () => this.view.state.facet(editorHistory).redoDepth(this.view.state),
            }),
            markdownWithCodeHighlight(),
            codeHighlighting(),
            editorAnalysis(),
            EditorView.lineWrapping,
            EditorView.domEventHandlers({
                focus: () => (this.cellFocusChanged(), false),
                blur: () => (this.cellFocusChanged(), false),
            }),
            cellClipboard(this.view),
            // A cell that wraps onto another row of text makes its table taller: the document editor measures again.
            EditorView.updateListener.of((update) => {
                if (update.geometryChanged || update.heightChanged) this.view.requestMeasure()
            }),
            this.options.extensions?.() ?? [],
        ]
    }
}

/**
 * A cell holds one line with no bare pipe. Whatever is typed or pasted is made so before it is
 * sent on: a line break or a tab becomes a space, and a `|` is written `\|` (`cleanCellText`).
 */
const cleanInput = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || tr.annotation(cellSync)) return tr
    const text = tr.newDoc.toString()
    if (cleanCellText(text) === text) return tr
    const fixes: ChangeSpec[] = []
    for (let i = 0; i < text.length; i++) {
        const char = text[i]
        if (char === '\n' || char === '\r' || char === '\t') fixes.push({ from: i, to: i + 1, insert: ' ' })
        else if (char === '|' && text[i - 1] !== '\\') fixes.push({ from: i, insert: '\\' })
    }
    return [tr, { changes: fixes, sequential: true }]
})

const cellEditorOptions = Facet.define<CellEditorOptions, CellEditorOptions>({ combine: (values) => values[0] ?? {} })

const plugin = ViewPlugin.define((view) => new CellEditor(view, view.state.facet(cellEditorOptions)), {
    eventHandlers: {
        focus() {
            this.documentFocused()
        },
    },
    eventObservers: {
        pointerdown(event) {
            this.pressed(event.target)
        },
        touchstart(event) {
            this.pressed(event.target)
        },
        // A key is no part of a press: the keyboard arriving after one is somebody handing it back.
        keydown() {
            this.pressed(null)
        },
    },
})

/** The element the cell's editor is drawn in, for the grid's widget to put in the cell being edited. Null in an editor without one. */
export function cellEditorHostElement(view: EditorView): HTMLElement | null {
    const editor = view.plugin(plugin)
    return editor?.nested ? editor.host : null
}

/** Tell the cell's editor that its element is in the page, in the cell being edited, and whether moving it there took the keyboard from it. */
export function cellEditorAttached(view: EditorView, refocus: boolean): void {
    view.plugin(plugin)?.hostAttached(refocus)
}

/** Ask for the keyboard to go to the cell the caret is put in by the transaction dispatched next. */
export function focusCellNext(view: EditorView): void {
    view.plugin(plugin)?.focusNext()
}

/** The cell's editor of `view`, the document editor, while a cell is being edited. */
export function cellEditorOf(view: EditorView): EditorView | null {
    return view.plugin(plugin)?.nested ?? null
}

/**
 * The editor that has the caret, for what opens at the caret (the Command Menu, the Date Picker):
 * the cell's editor while a cell of one of `view`'s tables is being edited, else `view` itself.
 */
export function cellInputView(view: EditorView): EditorView {
    // A test's stand-in over a state has no plugins to ask.
    const editor = typeof view.plugin === 'function' ? view.plugin(plugin) : null
    return editor?.inputView() ?? view
}

// ── Keys in a cell ───────────────────────────────────────────────────────────────────────────

/** Whether the caret is on the cell's first (`step` -1) or last (`step` 1) row of text, where a cell wraps. */
function onEdgeRow(nested: EditorView, step: 1 | -1): boolean {
    const here = nested.coordsAtPos(nested.state.selection.main.head)
    const edge = nested.coordsAtPos(step < 0 ? 0 : nested.state.doc.length)
    return !here || !edge || Math.abs(here.top - edge.top) < 2
}

/**
 * The cell's keys. Each moves the document's caret (table-cell-keys.ts), and the cell's editor
 * follows it to the cell it lands in. An arrow leaves the cell only from the edge of its text: Up
 * and Down from its first and last row of text, Left and Right from its start and end, and none of
 * them while text is selected.
 */
function cellKeys(main: EditorView): KeyBinding[] {
    const onDocument =
        (run: Command | StateCommand): Command =>
        () =>
            run(main)
    /** A key that leaves the cell only for a caret for which `atEdge` holds; otherwise it is the cell's own. */
    const fromEdge =
        (atEdge: (nested: EditorView) => boolean, run: StateCommand): Command =>
        (nested) =>
            nested.state.selection.main.empty && atEdge(nested) && run(main)
    const head = (nested: EditorView) => nested.state.selection.main.head
    const atStart = (nested: EditorView) => head(nested) === 0
    const atEnd = (nested: EditorView) => head(nested) === nested.state.doc.length
    /**
     * Shift and an arrow. With a block selected it grows or shrinks by a cell. With none, it selects
     * text inside the cell until the selection reaches the edge of the cell's text, and from there
     * the next press starts a block.
     */
    const extend =
        (atEdge: (nested: EditorView) => boolean, rows: -1 | 0 | 1, columns: -1 | 0 | 1): Command =>
        (nested) =>
            (cellBlock(main.state) !== null || atEdge(nested)) && extendCells(rows, columns)(main)
    /** Mod+A: the cell's text, then every cell of the table, then the document. */
    const selectMore: Command = (nested) => {
        const { from, to } = nested.state.selection.main
        if (from > 0 || to < nested.state.doc.length) return false
        if (!allCellsSelected(main.state)) return selectAllCells(main)
        collapseCells(main)
        main.focus()
        return selectAll(main)
    }
    return [
        // A block of cells first: the keys act on it while one is selected.
        { key: 'Escape', run: onDocument(collapseCells) },
        { key: 'Delete', run: onDocument(clearSelectedCells) },
        { key: 'Backspace', run: onDocument(clearSelectedCells) },
        { key: 'Shift-ArrowUp', run: extend((nested) => onEdgeRow(nested, -1), -1, 0) },
        { key: 'Shift-ArrowDown', run: extend((nested) => onEdgeRow(nested, 1), 1, 0) },
        { key: 'Shift-ArrowLeft', run: extend(atStart, 0, -1) },
        { key: 'Shift-ArrowRight', run: extend(atEnd, 0, 1) },
        { key: 'Mod-a', run: selectMore, preventDefault: true },
        { key: 'Tab', run: onDocument(nextCell), shift: onDocument(previousCell), preventDefault: true },
        // A cell is one line: Shift+Enter has no line break to make, and is kept from the browser.
        { key: 'Enter', run: onDocument(cellBelowOrNewRow), shift: () => true, preventDefault: true },
        { key: 'Escape', run: onDocument(leaveTable) },
        { key: 'ArrowUp', run: fromEdge((nested) => onEdgeRow(nested, -1), cellAbove) },
        { key: 'ArrowDown', run: fromEdge((nested) => onEdgeRow(nested, 1), cellBelow) },
        { key: 'ArrowLeft', run: fromEdge(atStart, cellBefore) },
        { key: 'ArrowRight', run: fromEdge(atEnd, cellAfter) },
        { key: 'Mod-z', run: onDocument(undoCommand), preventDefault: true },
        { key: 'Mod-y', mac: 'Mod-Shift-z', run: onDocument(redoCommand), preventDefault: true },
        { linux: 'Ctrl-Shift-z', run: onDocument(redoCommand), preventDefault: true },
        { key: 'Mod-b', run: onDocument(toggleBold), preventDefault: true },
        { key: 'Mod-i', run: onDocument(toggleItalic), preventDefault: true },
        { key: 'Mod-Shift-h', run: onDocument(toggleHighlight), preventDefault: true },
    ]
}

// ── Cells on the clipboard ───────────────────────────────────────────────────────────────────

/** Rows of cells in what was copied: an HTML table's (a spreadsheet's copy, a grid's own), or text that is rows. Null for words. */
function clipboardCells(data: DataTransfer): string[][] | null {
    const html = data.getData('text/html')
    if (/<table[\s>]/i.test(html)) {
        const table = parseInertHtml(html).querySelector('table')
        const rows = table ? [...table.querySelectorAll('tr')].map((row) => [...row.querySelectorAll('th, td')].map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim())) : []
        const filled = rows.filter((row) => row.length > 0)
        if (filled.length > 0) return filled
    }
    const text = data.getData('text/plain')
    return cellsOfTabbedText(text) ?? cellsOfMarkdownTable(text)
}

/**
 * Copy, cut and paste in a cell. A block of cells is copied as a table two ways, HTML for a
 * spreadsheet and markdown for a text field, and cut empties its cells. Rows of cells pasted go
 * into the grid's cells from the caret's cell, and one value over a block fills it; words pasted
 * with nothing selected go in at the caret, as the cell's editor does it by itself.
 */
function cellClipboard(main: EditorView): Extension {
    const copy = (event: ClipboardEvent, cut: boolean): boolean => {
        const selected = selectedCells(main.state)
        if (!selected || !event.clipboardData) return false
        event.clipboardData.setData('text/plain', cellsAsMarkdown(selected.cells, selected.align))
        event.clipboardData.setData('text/html', cellsAsHtml(selected.cells))
        event.preventDefault()
        if (cut) clearSelectedCells(main)
        return true
    }
    return EditorView.domEventHandlers({
        copy: (event) => copy(event, false),
        cut: (event) => copy(event, true),
        paste(event, nested) {
            if (!event.clipboardData) return false
            const block = cellBlock(main.state)
            const cells = clipboardCells(event.clipboardData) ?? (block ? [[event.clipboardData.getData('text/plain')]] : null)
            if (!cells) return false
            event.preventDefault()
            // One value with no block selected is words: in at the caret, over what is selected in the cell.
            if (!block && cells.length === 1 && cells[0].length === 1) nested.dispatch(nested.state.replaceSelection(cells[0][0]), { userEvent: 'input.paste' })
            else pasteCellsAtCaret(main, cells)
            return true
        },
    })
}

/** The editor of the cell being edited (Table Grid). `options` come from the document editor's View. */
export function tableCellEditor(options: CellEditorOptions = {}): Extension {
    return [cellEditorOptions.of(options), cellFocusField, plugin, EditorView.updateListener.of((update) => update.view.plugin(plugin)?.afterUpdate())]
}
