/**
 * The Table Grid (CONTEXT.md → Table Grid): a table's pipe-text replaced by a rendered `<table>`,
 * the first block replace-widget (Dual Mode Editor.md → Inline markdown formatting). A pure
 * decoration over unaltered markdown (ADR 0001). Built directly as a composed CM extension — it
 * does NOT use the (deferred) contribution registry.
 *
 * A table is edited in its grid (ADR 0205). A press on a cell, or the caret arriving on the
 * table's lines, puts the caret in a cell, and the editor of that cell is drawn in it
 * (table-cell-editor.ts); the grid stays drawn. The table's text shows only when its author asks
 * for it with Edit as text, until the caret leaves the table (`tablesAsTextField`,
 * table-cell.ts). A document that takes no edit keeps the older rule: the caret on the table's
 * lines shows its text, and a press on the grid puts the caret at its start.
 *
 * A table that is a bullet's content (`- | a | b |`, rows indented under it) keeps the `- `
 * marker as real text and renders the grid **inline** after it, filling the content column —
 * so the bullet keeps its dot and stays a list item, as a bullet image does (image-embed.ts).
 *
 * A cell shows what a line off the caret shows: links, marks and hidden syntax, from the same parts
 * the read-only surfaces draw (inline-parts.ts). Its links carry the classes and attributes the
 * editor's own click handlers act on, so a click on one opens it here as it does on a line.
 */

import { EditorState, type Extension, Prec, type Text, type Transaction } from '@codemirror/state'
import { EditorView, keymap, WidgetType } from '@codemirror/view'

import { displayNameForRef } from '../../../storage/fs/asset-store'
import { type InlinePart, inlineParts } from '../../inline-parts'
import { type Align, cellDisplaySource, findTables, type MarkdownTable } from '../../markdown-table'
import { addColumns, addRows, tableWidth } from '../../markdown-table-edit'
import { type CellAddress, type CellRect, HEADER_ROW, rectHolds, rectSize } from '../../table-cells'
import { analysisFor } from '../analysis/editor-analysis'
import { activeCell, cellBlock, cellBlockField, cellCaret, editTableAsText, fromCell, gridEditable, selectCells, tableAt, tableDrawnAsGrid, tablesAsTextField, tableStartingAt } from '../table-cell'
import { arrowIntoTable, selectCellsTo } from '../table-cell-keys'
import { editTableAtCaret } from '../table-edit'
import { blockWidgetField } from './base-renderer'
import { BLOCK_WIDGET_SPACING, BULLET_BLOCK_DROP, blockWidgetIndent } from './content-clamp'
import { LINK_SELECTORS } from './link-cursor'
import { INLINE_MARK_CLASS } from './markdown-format'
import { revealCellFocus } from './reveal-policy'
import { CONTROL_ATTRIBUTE, type GridControl, gridControlCell, gridControls, LIVE_CLASS, SCROLL_CLASS } from './table-grid-controls'
import { CELL_EDITOR_CLASS, type CellEditorOptions, cellEditorAttached, cellEditorHostElement, cellEditorOf, focusCellNext, tableCellEditor } from './table-cell-editor'
import { refreshWikilinks } from './wikilink'

export interface MarkdownTableOptions {
    /** Whether a linked concept has no page yet: its link in a cell is dashed, as on a line. */
    isMissing?: (concept: string) => boolean
    /** What the editor of the cell being edited is given (table-cell-editor.ts). */
    cell?: CellEditorOptions
    /**
     * Raise the menu of a row or a column of a grid, at a point of the page: the View opens its
     * Context Menu there. Absent, the handles on the grid's borders are drawn and do nothing.
     */
    menu?: (kind: 'row' | 'column', about: GridMenuAbout, x: number, y: number) => void
}

/** What a row's or a column's menu is offered and labelled by. */
export interface GridMenuAbout {
    /** The row is the header. */
    header: boolean
    /** How many columns the table has. */
    columns: number
    /** The column's alignment. */
    align: Align
    /** How many body rows and how many columns the menu's removal acts on: those of the block of cells selected, or one. */
    selectedRows: number
    selectedColumns: number
}

/** The class of the cell being edited, which holds the cell's editor in place of its drawn text. */
const EDITING_CLASS = 'cm-md-table__cell--editing'

/** The class of a cell in the block of cells selected. */
const SELECTED_CLASS = 'cm-md-table__cell--selected'

/** A span with a class, attributes and text: the shape of every clickable part. */
function span(className: string, attributes: Record<string, string>, text: string): HTMLElement {
    const el = document.createElement('span')
    el.className = className
    for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value)
    el.textContent = text
    return el
}

/**
 * One part of a cell. A wikilink and a hyperlink are the marks wikilink.ts and markdown-link.ts
 * decorate a line with, so their click handlers act on them here too. The rest is text: an asset's
 * label, an image's alt text (its file name when it has none), and inline maths as its source.
 */
function partNode(part: InlinePart, missing: ReadonlySet<string>): Node {
    switch (part.kind) {
        case 'wikilink':
            return span(
                missing.has(part.concept) ? 'cm-wikilink cm-wikilink--missing' : 'cm-wikilink',
                { 'data-augmentation': 'wikilink', 'data-concept': part.concept },
                part.text,
            )
        case 'link':
            return span('cm-md-link', { 'data-augmentation': 'md-link', 'data-href': part.href }, part.text)
        case 'file-link':
            return span('cm-md-link cm-md-link--file', { 'data-augmentation': 'md-link', 'data-file-path': part.path }, part.text)
        case 'image':
            return document.createTextNode(part.alt || displayNameForRef(part.url))
        default:
            return document.createTextNode(part.text)
    }
}

/** A cell's parts as the grid shows them: an escaped pipe is a pipe. */
function cellParts(source: string): InlinePart[] {
    return inlineParts(cellDisplaySource(source))
}

/** Fill a cell with its source's parts, each inside the spans of the marks over it. */
function fillCell(cell: HTMLElement, source: string, missing: ReadonlySet<string>): void {
    for (const part of cellParts(source)) {
        let node = partNode(part, missing)
        for (const mark of [...(part.marks ?? [])].reverse()) {
            const wrap = document.createElement('span')
            wrap.className = INLINE_MARK_CLASS[mark]
            wrap.appendChild(node)
            node = wrap
        }
        cell.appendChild(node)
    }
}

/** The concepts a table's cells link to that have no page yet, header included. */
function missingIn(table: MarkdownTable, isMissing: ((concept: string) => boolean) | undefined): Set<string> {
    const missing = new Set<string>()
    if (!isMissing) return missing
    for (const cell of [...table.header, ...table.rows.flat()]) {
        for (const part of cellParts(cell)) {
            if (part.kind === 'wikilink' && isMissing(part.concept)) missing.add(part.concept)
        }
    }
    return missing
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
    return a.size === b.size && [...a].every((item) => b.has(item))
}

/** Whether two tables have the same rows and columns, whatever their cells hold. */
function sameShape(a: MarkdownTable, b: MarkdownTable): boolean {
    return a.header.length === b.header.length && a.rows.length === b.rows.length && a.rows.every((row, i) => row.length === b.rows[i].length)
}

function sameCell(a: CellAddress | null, b: CellAddress | null): boolean {
    return a === b || (a !== null && b !== null && a.row === b.row && a.column === b.column)
}

function sameRect(a: CellRect | null, b: CellRect | null): boolean {
    return a === b || (a !== null && b !== null && a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right)
}

/** The widget each grid's element was last drawn from, so the next one changes only what differs. */
const drawn = new WeakMap<HTMLElement, TableWidget>()

class TableWidget extends WidgetType {
    constructor(
        readonly table: MarkdownTable,
        /** Source offset the grid starts at: how its element names its table, and where a press puts the caret in a document that takes no edit. */
        readonly from: number,
        /** Where its first line's text starts (`blockWidgetIndent`): a block grid pads itself to it. Null at column 0. */
        readonly indent: string | null,
        /** Inline variant: the table is a bullet's content, rendered after the marker (no padding). */
        readonly inline: boolean,
        /** The cells' linked concepts with no page yet: a page created elsewhere redraws the grid. */
        readonly missing: ReadonlySet<string>,
        /** The cell being edited, which holds the cell's editor (table-cell-editor.ts), or null. */
        readonly active: CellAddress | null,
        /** Whether the table is edited in its grid: a cell shows the text cursor and takes a press. */
        readonly editable: boolean,
        /** The block of cells selected in this table, which are drawn selected, or null. */
        readonly selected: CellRect | null,
    ) {
        super()
    }

    eq(other: TableWidget): boolean {
        return (
            this.from === other.from &&
            this.indent === other.indent &&
            this.inline === other.inline &&
            this.editable === other.editable &&
            sameCell(this.active, other.active) &&
            sameRect(this.selected, other.selected) &&
            sameSet(this.missing, other.missing) &&
            JSON.stringify(this.table) === JSON.stringify(other.table)
        )
    }

    toDOM(view: EditorView): HTMLElement {
        const wrap = document.createElement('div')
        wrap.setAttribute('data-augmentation', 'table')
        drawn.set(wrap, this)
        this.frame(wrap)
        // The table scrolls sideways inside the grid's element when it is wider than the pane, so
        // the controls on its borders, which belong to the element, are not cut off with it.
        const scroll = wrap.appendChild(document.createElement('div'))
        scroll.className = SCROLL_CLASS
        scroll.appendChild(this.build(view))
        this.controls(wrap, view)
        // Before the cell's own editor hears it (the capture phase): see `pressInCell`. No view: drawn for a test.
        if (view) wrap.addEventListener('mousedown', (event) => pressInCell(view, wrap, event), true)
        return wrap
    }

    /** The handles and plus buttons of a grid that is edited: placed for the cell being edited (table-grid-controls.ts). */
    private controls(wrap: HTMLElement, view: EditorView): void {
        // No view: drawn for a test that reads the cells alone.
        if (this.editable && view) gridControls(wrap).drawn(view, this.active)
    }

    /**
     * Draw this table into the element another was drawn in, changing only the cells that differ.
     * The cell being edited is left as it is: its editor has the keyboard, and typing in it changes
     * the table on every key.
     */
    updateDOM(dom: HTMLElement, view: EditorView): boolean {
        const before = drawn.get(dom)
        const table = dom.querySelector<HTMLTableElement>('table')
        if (!before || !table?.parentElement || before.editable !== this.editable) return false
        drawn.set(dom, this)
        this.frame(dom)
        if (sameShape(before.table, this.table)) this.patch(table, view, before)
        else table.parentElement.replaceChildren(this.build(view))
        this.controls(dom, view)
        return true
    }

    /** The grid's own element: its classes, the table it stands for and its indent. */
    private frame(wrap: HTMLElement): void {
        // The class that shows the controls is the controls' own to set, and is kept.
        const live = wrap.className.split(' ').includes(LIVE_CLASS)
        wrap.className = ['cm-md-table', this.inline ? 'cm-md-table--inline' : 'cm-md-table--block', this.editable ? 'cm-md-table--editable' : '', live ? LIVE_CLASS : ''].filter(Boolean).join(' ')
        wrap.setAttribute('data-table-from', String(this.from))
        wrap.style.paddingLeft = !this.inline && this.indent ? this.indent : ''
    }

    private source(address: CellAddress): string {
        return (address.row === HEADER_ROW ? this.table.header[address.column] : this.table.rows[address.row]?.[address.column]) ?? ''
    }

    /** The editor's element, when `address` is the cell being edited and its editor exists. */
    private hostFor(address: CellAddress, view: EditorView): HTMLElement | null {
        return sameCell(this.active, address) ? cellEditorHostElement(view) : null
    }

    /** A new table element: every cell drawn, the cell being edited holding the cell's editor. */
    private build(view: EditorView): HTMLElement {
        const table = document.createElement('table')
        const row = (parent: HTMLElement, tag: 'th' | 'td', index: number, width: number) => {
            const tr = parent.appendChild(document.createElement('tr'))
            for (let column = 0; column < width; column++) {
                const address = { row: index, column }
                const cell = tr.appendChild(document.createElement(tag))
                cell.setAttribute('data-row', String(index))
                cell.setAttribute('data-col', String(column))
                const align = this.table.align[column]
                if (align) cell.style.textAlign = align
                const host = this.hostFor(address, view)
                cell.className = this.classOf(address, host !== null)
                if (host) this.hold(cell, host, view)
                else fillCell(cell, this.source(address), this.missing)
            }
        }
        row(table.appendChild(document.createElement('thead')), 'th', HEADER_ROW, this.table.header.length)
        const body = table.appendChild(document.createElement('tbody'))
        this.table.rows.forEach((cells, index) => row(body, 'td', index, cells.length))
        return table
    }

    /** A cell's classes: the one being edited, and one in the block selected. */
    private classOf(address: CellAddress, editing: boolean): string {
        return [editing ? EDITING_CLASS : '', this.selected && rectHolds(this.selected, address) ? SELECTED_CLASS : ''].filter(Boolean).join(' ')
    }

    /** Put the cell's editor in `cell`. Moving its element takes the keyboard from it, and it asks for it back. */
    private hold(cell: HTMLElement, host: HTMLElement, view: EditorView): void {
        if (host.parentElement === cell) return
        const focused = host.contains(host.ownerDocument.activeElement)
        cell.replaceChildren(host)
        cellEditorAttached(view, focused)
    }

    /** The same rows and columns as before: each cell that differs is drawn again, in place. */
    private patch(table: HTMLTableElement, view: EditorView, before: TableWidget): void {
        const redrawAll = !sameSet(before.missing, this.missing)
        for (const cell of table.querySelectorAll<HTMLElement>('[data-col]')) {
            const address = { row: Number(cell.dataset.row), column: Number(cell.dataset.col) }
            cell.style.textAlign = this.table.align[address.column] ?? ''
            const host = this.hostFor(address, view)
            const wasEdited = cell.classList.contains(EDITING_CLASS)
            cell.className = this.classOf(address, host !== null)
            if (host) {
                this.hold(cell, host, view)
                continue
            }
            if (!redrawAll && !wasEdited && before.source(address) === this.source(address)) continue
            cell.replaceChildren()
            fillCell(cell, this.source(address), this.missing)
        }
    }

    /** What happens inside the cell's editor is its own: the document editor does not read its keys and presses. */
    ignoreEvent(event: Event): boolean {
        const target = event.target
        const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
        return element?.closest(`.${CELL_EDITOR_CLASS}`) != null
    }
}

// A block widget from the state (base-renderer.ts): the grid stands in for the table. In a document
// that is edited the grid stays while the caret is in it, with the caret's cell drawn as the one
// being edited, and the pipe-source shows only on request. In one that is not, a caret anywhere on
// the table's lines reveals the source. On a bullet line the marker stays and the grid is inline
// after it (the parser's `headerStart`). The wikilink augmentation's index refresh rebuilds it too,
// so a cell's link stops being dashed once its page exists, as the same link on a line does.
function tableField(options: MarkdownTableOptions) {
    return blockWidgetField<MarkdownTable>({
        blocks: (state) => analysisFor(state).tables,
        lines: (t) => ({ first: t.startLine + 1, last: t.endLine + 1 }),
        markerLength: (t) => t.headerStart,
        // A bullet's grid holds the editor of the cell being edited, which must stay in the page while it is typed in.
        besideHiddenText: true,
        collapsed: (t, state) => (gridEditable(state) ? tableDrawnAsGrid(state, t) : undefined),
        widget: (t, state, from) => {
            const inline = t.headerStart > 0
            const cell = activeCell(state)
            const active = cell && cell.tableFrom === from ? { row: cell.row, column: cell.column } : null
            const block = active ? cellBlock(state) : null
            return new TableWidget(t, from, inline ? null : blockWidgetIndent(state, from), inline, missingIn(t, options.isMissing), active, gridEditable(state), block?.rect ?? null)
        },
        rebuildOn: (tr) => tr.effects.some((effect) => effect.is(refreshWikilinks) || effect.is(editTableAsText) || effect.is(selectCells)),
    })
}

/** How far from the caret's line a table being typed is looked for: its rows above and below, as text. */
const TYPED_TABLE_REACH = 200

/** Whether a line can be a row of a table: it has a pipe, or it is a delimiter row written without one. */
function rowLike(text: string): boolean {
    return text.includes('|') || /^\s*:?-+:?\s*$/.test(text)
}

/** Whether `tr` is the person typing or deleting in the document itself, in an editor that edits tables in their grid. */
function typesInDocument(tr: Transaction): boolean {
    if (!tr.docChanged || tr.annotation(fromCell)) return false
    return (tr.isUserEvent('input.type') || tr.isUserEvent('delete')) && gridEditable(tr.startState)
}

/** The table among the row-like lines round line `at` of `doc` that holds that line, with the number of its first line. */
function tableRoundLine(doc: Text, at: number): { table: MarkdownTable; first: number } | null {
    let first = at
    let last = at
    while (first > 1 && at - first < TYPED_TABLE_REACH && rowLike(doc.line(first - 1).text)) first--
    while (last < doc.lines && last - at < TYPED_TABLE_REACH && rowLike(doc.line(last + 1).text)) last++
    const table = findTables(doc.sliceString(doc.line(first).from, doc.line(last).to)).find((found) => first + found.startLine <= at && first + found.endLine >= at)
    return table ? { table, first } : null
}

/**
 * The table that came into being under the caret as `tr` typed or deleted: the caret's line is a
 * row of a table now, and was no table's before. A table written by hand becomes one the moment
 * its delimiter row is complete, with the caret still on that row and the next row yet to type.
 * Answers where its grid would start, in the transaction's start document, as
 * {@link editTableAsText} takes it.
 *
 * It reads the rows round the caret with the parser itself, since the document's own reading
 * (`EditorAnalysis`) is of the state this transaction has yet to make.
 */
export function tableTypedAtCaret(tr: Transaction): number | null {
    if (!typesInDocument(tr)) return null
    const head = tr.newSelection.main.head
    const caretLine = tr.newDoc.lineAt(head)
    const back = tr.changes.invertedDesc
    if (!rowLike(caretLine.text) || tableAt(tr.startState, back.mapPos(head, -1))) return null
    const found = tableRoundLine(tr.newDoc, caretLine.number)
    return found ? back.mapPos(tr.newDoc.line(found.first + found.table.startLine).from + found.table.headerStart, 1) : null
}

// A table being written by hand keeps showing its text: the grid would take the caret into a cell
// with the row half typed. It is drawn once the caret leaves it, as Edit as text ends.
const typedTableStaysText = EditorState.transactionExtender.of((tr) => {
    const start = tableTypedAtCaret(tr)
    return start === null ? null : { effects: editTableAsText.of(start) }
})

/** Put the caret in a cell of the table whose grid starts at `from`, and the keyboard in the cell's editor. */
function caretInto(view: EditorView, from: number, cell: CellAddress): boolean {
    const table = tableStartingAt(view.state, from)
    const pos = table ? cellCaret(view.state, table, cell) : null
    if (pos === null) return false
    focusCellNext(view)
    view.dispatch({
        selection: { anchor: pos },
        userEvent: 'select.pointer',
        // The cell is about to take the keyboard. Said now, because a part editor has no cell to
        // edit until it or one of its cells has it (reveal-policy.ts).
        effects: revealCellFocus.of(true),
    })
    return true
}

/** Put the caret in the cell a press landed on, at the place in its text nearest the press. */
function pressCell(view: EditorView, from: number, cellElement: HTMLElement, event: MouseEvent): void {
    if (!caretInto(view, from, { row: Number(cellElement.dataset.row), column: Number(cellElement.dataset.col) })) return
    // The cell shows its markdown now, so the place under the pointer is asked of its own editor.
    const nested = cellEditorOf(view)
    const at = nested?.posAtCoords({ x: event.clientX, y: event.clientY }, false)
    if (nested && at != null && at !== nested.state.selection.main.head) nested.dispatch({ selection: { anchor: at }, userEvent: 'select.pointer' })
}

/** The menu of the row or the column the caret is in, raised under its handle. */
function raiseMenu(view: EditorView, options: MarkdownTableOptions, kind: 'row' | 'column', button: HTMLElement): void {
    const cell = activeCell(view.state)
    if (!cell) return
    const box = button.getBoundingClientRect()
    const block = cellBlock(view.state)
    const bodyRows = block ? Math.max(0, Math.min(block.rect.bottom, cell.table.rows.length - 1) - Math.max(block.rect.top, 0) + 1) : 0
    const about: GridMenuAbout = {
        header: cell.row === HEADER_ROW,
        columns: tableWidth(cell.table),
        align: cell.table.align[cell.column] ?? null,
        selectedRows: Math.max(1, bodyRows),
        selectedColumns: block ? rectSize(block.rect).columns : 1,
    }
    options.menu?.(kind, about, box.left, box.bottom + 4)
}

/**
 * A press on one of the grid's controls (table-grid-controls.ts). The caret goes to the cell the
 * handles stand for first, so the row or column acted on is the caret's, as it is for every table
 * Command. A plus adds at the end; a handle raises its menu under itself.
 */
function pressControl(view: EditorView, options: MarkdownTableOptions, wrap: HTMLElement, button: HTMLElement): void {
    const from = Number(wrap.getAttribute('data-table-from'))
    const control = button.getAttribute(CONTROL_ATTRIBUTE) as GridControl
    const at = gridControlCell(wrap) ?? { row: HEADER_ROW, column: 0 }
    const here = activeCell(view.state)
    const there = here !== null && here.tableFrom === from && here.row === at.row && here.column === at.column
    if (!there && !caretInto(view, from, at)) return
    if (control === 'add-row') editTableAtCaret(view, (hit) => addRows(hit.table, 1), (hit) => ({ bodyRow: hit.table.rows.length, column: 0 }))
    else if (control === 'add-column') editTableAtCaret(view, (hit) => addColumns(hit.table, tableWidth(hit.table) - 1, 1), (hit) => ({ bodyRow: -2, column: tableWidth(hit.table) }))
    else raiseMenu(view, options, control, button)
}

/** The cell of the grid in `wrap` under the pointer, or null. */
function cellUnderPointer(wrap: HTMLElement, event: MouseEvent): CellAddress | null {
    const over = wrap.ownerDocument.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-col]')
    return over && wrap.contains(over) ? { row: Number(over.dataset.row), column: Number(over.dataset.col) } : null
}

/**
 * Follow the pointer while the button of a press on a cell stays down: over another cell of the
 * same grid, the block from the caret's cell to that one is selected, and back over the caret's
 * cell none is.
 */
function dragCells(view: EditorView, wrap: HTMLElement): void {
    const page = wrap.ownerDocument
    const move = (event: MouseEvent) => {
        if (!(event.buttons & 1)) return stop()
        const head = cellUnderPointer(wrap, event)
        const here = activeCell(view.state)
        if (!head || !here) return
        const block = cellBlock(view.state)?.block
        const current = block && !block.all ? block.head : here
        if (current.row !== head.row || current.column !== head.column) selectCellsTo(view, head)
    }
    const stop = () => {
        page.removeEventListener('mousemove', move)
        page.removeEventListener('mouseup', stop)
    }
    page.addEventListener('mousemove', move)
    page.addEventListener('mouseup', stop)
}

/**
 * A press inside the cell being edited is the cell's own editor's, and the document editor never
 * hears it. It ends a block that was selected, and dragged out of the cell it starts one.
 */
function pressInCell(view: EditorView, wrap: HTMLElement, event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null
    if (event.button !== 0 || event.shiftKey || !target?.closest(`.${CELL_EDITOR_CLASS}`)) return
    if (cellBlock(view.state)) view.dispatch({ effects: selectCells.of(null) })
    dragCells(view, wrap)
}

/** A press on a cell of a grid that is edited: the caret goes into it, or with Shift the block reaches to it. */
function pressGridCell(view: EditorView, wrap: HTMLElement, from: number, cellElement: HTMLElement, event: MouseEvent): void {
    // Shift and a press: the block from the caret's cell to this one, in the same table.
    const here = activeCell(view.state)
    if (event.shiftKey && here && here.tableFrom === from) {
        selectCellsTo(view, { row: Number(cellElement.dataset.row), column: Number(cellElement.dataset.col) })
        return
    }
    pressCell(view, from, cellElement, event)
    dragCells(view, wrap)
}

/** A press on the grid of a table in a document that takes no edit: the caret at the table's start shows its text. */
function pressReadOnlyGrid(view: EditorView, from: number, event: MouseEvent): boolean {
    event.preventDefault()
    view.dispatch({ selection: { anchor: from } })
    view.focus()
    return true
}

/**
 * The grid a press landed on, or null where the press is not the grid's. A plain click on a link in
 * a cell is the link's: its own augmentation opens it. With the mod key held the click edits the
 * cell, as the same click on a link in a line edits it.
 */
function pressedGrid(event: MouseEvent): { wrap: HTMLElement; target: HTMLElement } | null {
    const target = event.target as HTMLElement | null
    if (!target || (!(event.metaKey || event.ctrlKey) && target.closest(LINK_SELECTORS.join(', ')))) return null
    const wrap = target.closest<HTMLElement>('[data-table-from]')
    return wrap ? { wrap, target } : null
}

function pressToEdit(options: MarkdownTableOptions) {
    return EditorView.domEventHandlers({
        mousedown(event, view) {
            const pressed = pressedGrid(event)
            if (!pressed) return false
            const { wrap, target } = pressed
            const from = Number(wrap.getAttribute('data-table-from'))
            if (!gridEditable(view.state)) return pressReadOnlyGrid(view, from, event)
            if (event.button !== 0) return false
            // The press is the grid's: the keyboard stays where it is unless a cell takes it.
            event.preventDefault()
            const control = target.closest<HTMLElement>(`[${CONTROL_ATTRIBUTE}]`)
            const cellElement = target.closest<HTMLElement>('[data-col]')
            if (control) pressControl(view, options, wrap, control)
            else if (cellElement) pressGridCell(view, wrap, from, cellElement, event)
            return true
        },
    })
}

// The caret steps into a grid from the line above or below it, where the view's own motion would
// step over it (table-cell-keys.ts). The same place in the order as the fences' arrows (fence-render.ts).
const arrows = Prec.high(
    keymap.of([
        { key: 'ArrowDown', run: arrowIntoTable(1) },
        { key: 'ArrowUp', run: arrowIntoTable(-1) },
    ]),
)

const theme = EditorView.baseTheme({
    // The grid's element is where its border controls are placed from; the table scrolls inside it.
    '.cm-md-table': { position: 'relative' },
    [`.${SCROLL_CLASS}`]: { overflowX: 'auto' },
    // The block table's spacing from the lines around it, as padding (BLOCK_WIDGET_SPACING says why). The
    // bullet variant is an inline box inside its line, whose line box already holds its margins (below).
    '.cm-md-table--block': { padding: `${BLOCK_WIDGET_SPACING} 0` },
    // Inline variant (a bullet's table): an inline-block right after the marker, top-aligned with the dot
    // and as wide as the content column. The clamp (content-clamp.ts) hangs the marker in the line's
    // padding, so `100%` of the line's content box is exactly the room to the right of it — and a
    // sub-pixel overshoot there (the hang is a measured, rounded width) would wrap the whole grid under
    // the dot. The 1px negative right margin shrinks the box the line-breaker measures (nothing
    // follows the grid, so it is invisible) while the painted box still reaches the right edge.
    '.cm-md-table--inline': {
        display: 'inline-block',
        verticalAlign: 'top',
        width: '100%',
        margin: `${BULLET_BLOCK_DROP} -1px 0.2em 0`,
    },
    // A table is as wide as its content needs, up to the width of the text, where its cells wrap. A
    // table made to fill the width shares the spare room out in proportion to each column's content,
    // so typing in one cell widened its column by more than was typed and took the room from the others.
    '.cm-md-table table': { borderCollapse: 'collapse' },
    // A cell keeps its words whole. The editor's content wrapping (`overflow-wrap: anywhere`) would
    // let the table size a column below its longest word and split it; with `break-word` a column is
    // at least as wide as its longest word instead, and a table wider than the pane scrolls sideways
    // (`overflowX` above). A hyperlink still wraps anywhere, since a url has no words to keep and
    // would otherwise push the whole table wide.
    // A cell is at least a line of text tall, so a row of empty cells is a row a press can land in
    // (a table cell's `height` is the least it may be, padding and border included, and its text
    // still makes it taller). It is one line of text with the cell's 2px of padding above and below
    // and its 1px border, so a cell is no taller with its editor in it than empty.
    '.cm-md-table th, .cm-md-table td': {
        border: '1px solid var(--gk-border-soft, rgba(0,0,0,0.2))',
        padding: '2px 8px',
        height: 'calc(var(--gk-line-pitch, 1.7em) + 5px)',
        // A column with nothing in it yet is still wide enough to press and to show its handle.
        minWidth: '4em',
        overflowWrap: 'break-word',
        wordBreak: 'normal',
    },
    '.cm-md-table .cm-md-link': { overflowWrap: 'anywhere' },
    '.cm-md-table th': { background: 'var(--gk-surface-2, rgba(0,0,0,0.06))', fontWeight: '700' },
    // The controls on a grid's borders (table-grid-controls.ts): out of the flow, each centred on the
    // point it is given, drawn only while the caret or the pointer is in the grid. The handle is a
    // thin pill on the border and the plus a small disc, both larger to the pointer than they look.
    '.cm-md-table__control': {
        position: 'absolute',
        zIndex: '1',
        display: 'none',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0',
        border: '1px solid var(--gk-control-border)',
        background: 'var(--gk-surface-0)',
        color: 'var(--gk-text-muted)',
        cursor: 'pointer',
        transform: 'translate(-50%, -50%)',
    },
    [`.${LIVE_CLASS} .cm-md-table__control:not([hidden])`]: { display: 'flex' },
    '.cm-md-table__control::before': { content: '""', position: 'absolute', inset: '-8px' },
    '.cm-md-table__control:hover': { borderColor: 'var(--gk-text-strong)', background: 'var(--gk-surface-2)', color: 'var(--gk-text-strong)' },
    '.cm-md-table__control--column': { width: '30px', height: '12px', borderRadius: '6px' },
    // Outside the left border, so it never covers the row's first words.
    '.cm-md-table__control--row': { width: '12px', height: '26px', borderRadius: '6px', transform: 'translate(calc(-100% - 3px), -50%)' },
    '.cm-md-table__control--row svg': { transform: 'rotate(90deg)' },
    // A bullet's grid has its dot to its left: the handle sits on the border there.
    '.cm-md-table--inline .cm-md-table__control--row': { transform: 'translate(-50%, -50%)' },
    '.cm-md-table__control--add-row, .cm-md-table__control--add-column': { width: '18px', height: '18px', borderRadius: '50%' },
    // Mostly outside the right border: a table is as wide as its content, so the last column's text
    // reaches the cell's padding, which a disc centred on the border would cover.
    '.cm-md-table__control--add-column': { transform: 'translate(-25%, -50%)' },
    '@media (pointer: coarse)': {
        '.cm-md-table__control--column': { width: '40px', height: '16px', borderRadius: '8px' },
        '.cm-md-table__control--row': { width: '16px', height: '34px', borderRadius: '8px' },
        '.cm-md-table__control::before': { inset: '-14px' },
        // The table reaches the edge of a phone's screen: a column is added from the column's menu or the Command Bar.
        [`.${LIVE_CLASS} .cm-md-table__control--add-column:not([hidden])`]: { display: 'none' },
    },
    // A cell of the block selected, in the selection's own colour.
    [`.cm-md-table .${SELECTED_CLASS}`]: { background: 'var(--gk-selection)' },
    // A cell of a table edited in its grid takes the caret, so the pointer says so.
    '.cm-md-table--editable th, .cm-md-table--editable td': { cursor: 'text' },
    // The cell being edited, while its editor has the keyboard: the ring a focused control has.
    [`.cm-md-table .${EDITING_CLASS}:focus-within`]: { outline: '2px solid var(--gk-accent)', outlineOffset: '-2px' },
    // The cell's editor is drawn as the cell's own text: no frame, no padding and no scrolling of
    // its own, in the cell's font, weight and alignment. These outrank the document editor's theme,
    // whose rules for its content and lines reach an editor nested inside it.
    [`.cm-md-table .${CELL_EDITOR_CLASS} .cm-editor`]: { background: 'transparent', outline: 'none', height: 'auto' },
    [`.cm-md-table .${CELL_EDITOR_CLASS} .cm-scroller`]: { overflow: 'visible', fontFamily: 'inherit', lineHeight: 'inherit' },
    // A cell keeps its words whole while it is edited too (see the cells' rule above). The padding
    // and the height are marked important because the View gives its editor's content room at the
    // foot with rules that reach every content element under it (DocumentView.svelte).
    [`.cm-md-table .${CELL_EDITOR_CLASS} .cm-content`]: {
        padding: '0 !important',
        minHeight: '0 !important',
        lineHeight: 'inherit',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'break-word',
        wordBreak: 'normal',
    },
    [`.cm-md-table .${CELL_EDITOR_CLASS} .cm-line`]: { padding: '0', textIndent: '0' },
})

/** The Table Grid augmentation (Dual Mode Editor.md): the grid, the press that edits a cell, and the cell's editor. */
export function markdownTableAugmentation(options: MarkdownTableOptions = {}): Extension {
    return [tablesAsTextField, cellBlockField, typedTableStaysText, tableField(options), pressToEdit(options), arrows, tableCellEditor(options.cell), theme]
}
