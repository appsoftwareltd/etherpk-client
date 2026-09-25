/**
 * The **Table Size Picker** (CONTEXT.md → *Table Size Picker*; Dual Mode Editor.md → *Command
 * Menu*, "Table"): a grid of cells shown in a CM `showTooltip` popover at the caret, opened by
 * the `table.insert` Command from the Command Menu or the Command Bar's table button. The
 * author grows a highlighted rectangle — arrow keys, or hovering a cell — and accepts it with
 * Enter or a tap on a cell, which inserts a table of that many columns and body rows where the
 * caret's line puts it (`../../table-insert.ts`). Esc, or any other edit or caret move,
 * dismisses it and changes nothing.
 *
 * A sibling of the list popover and of the date calendar (`date-calendar.ts`), built the same
 * way: the grid never takes DOM focus — the caret has to stay where it is, because the caret's
 * line is what the insertion reads — so this file owns the whole keyboard model as a CM keymap,
 * and the cells refuse focus on pointerdown. The precedent for the shape is the table-size grid
 * of Word, Google Docs and Obsidian's table editor.
 */

import { type EditorState, type Extension, Prec, StateEffect, StateField, type TransactionSpec } from '@codemirror/state'
import { EditorView, keymap, showTooltip, type Tooltip, type TooltipView } from '@codemirror/view'

import { planTableInsert } from '../../table-insert'
import {
    TABLE_SIZE_DEFAULT,
    TABLE_SIZE_MAX,
    type TableSize,
    clampTableSize,
    stepTableSize,
    tableSizeLabel,
} from './table-size-picker-core'

/** Open the picker anchored at `pos`, highlighting the default size. */
export const openTableSizePicker = StateEffect.define<{ pos: number }>()
const setSize = StateEffect.define<TableSize>()
const closePicker = StateEffect.define<null>()

export interface TableSizePickerState {
    /** The popover's anchor. The insertion itself reads the caret's line. */
    pos: number
    size: TableSize
}

/** The dispatch surface the picker needs: a live view, or a headless editor in tests. */
type Dispatcher = { state: EditorState; dispatch: (spec: TransactionSpec) => void }

const P = 'gk-cmd-tsize'
const CELL = `${P}__cell`

const field = StateField.define<TableSizePickerState | null>({
    create: () => null,
    update(value, tr) {
        for (const e of tr.effects) {
            if (e.is(openTableSizePicker)) value = { pos: e.value.pos, size: TABLE_SIZE_DEFAULT }
            else if (e.is(setSize) && value) value = { ...value, size: clampTableSize(e.value) }
            else if (e.is(closePicker)) value = null
        }
        // A doc/selection change that isn't ours dismisses the picker.
        if ((tr.docChanged || tr.selection) && !tr.effects.some((e) => e.is(openTableSizePicker) || e.is(setSize)))
            return null
        return value
    },
    provide: (f) =>
        showTooltip.from(f, (picker): Tooltip | null =>
            picker ? { pos: picker.pos, above: false, strictSide: false, arrow: false, create: render } : null,
        ),
})

/** The picker's state, or null while it is closed. */
export function tableSizePickerState(state: EditorState): TableSizePickerState | null {
    return state.field(field, false) ?? null
}

/** Insert a `size` table where the caret's line puts it, and close the picker. */
export function acceptTableSize(view: Dispatcher, size: TableSize = tableSizePickerState(view.state)?.size ?? TABLE_SIZE_DEFAULT): boolean {
    const { state } = view
    const line = state.doc.lineAt(state.selection.main.head)
    const plan = planTableInsert(line, clampTableSize(size).cols, clampTableSize(size).rows)
    view.dispatch({
        changes: { from: plan.from, to: plan.to, insert: plan.insert },
        selection: { anchor: plan.selectFrom, head: plan.selectTo },
        effects: closePicker.of(null),
        userEvent: 'input.complete',
    })
    return true
}

/** Grow or shrink the highlighted size; false when the picker is closed. */
export function stepTableSizePicker(view: Dispatcher, dCols: number, dRows: number): boolean {
    const picker = tableSizePickerState(view.state)
    if (!picker) return false
    view.dispatch({ effects: setSize.of(stepTableSize(picker.size, dCols, dRows)) })
    return true
}

/** Dismiss the picker, changing nothing; false when it is closed. */
export function closeTableSizePicker(view: Dispatcher): boolean {
    if (!tableSizePickerState(view.state)) return false
    view.dispatch({ effects: closePicker.of(null) })
    return true
}

function render(view: EditorView): TooltipView {
    const dom = document.createElement('div')
    dom.className = P
    dom.dataset.testid = 'table-size-picker'

    const panel = document.createElement('div')
    panel.className =
        'rounded-md border border-(--gk-border-soft) bg-(--gk-surface-1) p-2 text-sm text-(--gk-text-default)'
    dom.appendChild(panel)

    const label = document.createElement('div')
    label.className = `${P}__label pb-1.5 text-sm text-(--gk-text-muted)`
    label.dataset.testid = 'table-size-picker-label'
    panel.appendChild(label)

    const grid = document.createElement('div')
    grid.className = `${P}__grid grid gap-0.5`
    grid.style.gridTemplateColumns = `repeat(${TABLE_SIZE_MAX}, 1.1rem)`
    panel.appendChild(grid)

    const cells: HTMLButtonElement[] = []
    for (let r = 1; r <= TABLE_SIZE_MAX; r++) {
        for (let c = 1; c <= TABLE_SIZE_MAX; c++) {
            const cell = document.createElement('button')
            cell.type = 'button'
            cell.tabIndex = -1
            cell.className = `${CELL} h-[1.1rem] w-[1.1rem] rounded-[3px] border`
            cell.dataset.cols = String(c)
            cell.dataset.rows = String(r)
            cell.setAttribute('aria-label', `${c} columns by ${r} rows`)
            // Never focusable: a focused cell would pull the caret out of the document, and the
            // insertion reads the caret's line.
            cell.addEventListener('pointerdown', (e) => e.preventDefault())
            // Hover previews the size; a pointer on a touch screen previews and accepts in one tap.
            cell.addEventListener('pointerenter', () => view.dispatch({ effects: setSize.of({ cols: c, rows: r }) }))
            cell.addEventListener('click', () => void acceptTableSize(view, { cols: c, rows: r }))
            grid.appendChild(cell)
            cells.push(cell)
        }
    }

    function paint(picker: TableSizePickerState | null): void {
        if (!picker) return
        label.textContent = tableSizeLabel(picker.size)
        for (const cell of cells) {
            const inside = Number(cell.dataset.cols) <= picker.size.cols && Number(cell.dataset.rows) <= picker.size.rows
            cell.classList.toggle('is-selected', inside)
            cell.classList.toggle('border-(--gk-accent)', inside)
            cell.classList.toggle('bg-(--gk-accent)', inside)
            cell.classList.toggle('border-(--gk-border-soft)', !inside)
            cell.classList.toggle('bg-(--gk-surface-2)', !inside)
        }
    }

    paint(view.state.field(field))
    return {
        dom,
        update(update) {
            paint(update.state.field(field))
        },
    }
}

const pickerKeymap = Prec.highest(
    keymap.of([
        { key: 'ArrowRight', run: (v) => stepTableSizePicker(v, 1, 0) },
        { key: 'ArrowLeft', run: (v) => stepTableSizePicker(v, -1, 0) },
        { key: 'ArrowDown', run: (v) => stepTableSizePicker(v, 0, 1) },
        { key: 'ArrowUp', run: (v) => stepTableSizePicker(v, 0, -1) },
        { key: 'Enter', run: (v) => (tableSizePickerState(v.state) ? acceptTableSize(v) : false) },
        { key: 'Escape', run: closeTableSizePicker },
    ]),
)

const theme = EditorView.baseTheme({
    [`.cm-tooltip.${P}`]: { background: 'transparent', border: 'none', padding: '0' },
    // The panel brings its own border and surface; the popover adds the elevation.
    [`.cm-tooltip.${P} > div`]: { boxShadow: 'var(--gk-shadow)' },
    [`.${CELL}.is-selected`]: { opacity: '0.85' },
})

export function tableSizePicker(): Extension {
    return [field, pickerKeymap, theme]
}
