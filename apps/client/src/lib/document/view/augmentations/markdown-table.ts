/**
 * The table grid widget — the first block replace-widget (Dual Mode Editor.md →
 * Inline markdown formatting). When the cursor is not on the table's lines, the raw
 * pipe-text is replaced by a rendered `<table>`; clicking the grid (or moving the
 * caret onto its lines) reveals the raw source for editing. A pure decoration over
 * unaltered markdown (ADR 0001). Built directly as a composed CM extension — it does
 * NOT use the (deferred) contribution registry.
 *
 * A table that is a bullet's content (`- | a | b |`, rows indented under it) keeps the `- `
 * marker as real text and renders the grid **inline** after it, filling the content column —
 * so the bullet keeps its dot and stays a list item, as a bullet image does (image-embed.ts).
 */

import { type Extension } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'

import { type Align, type MarkdownTable } from '../../markdown-table'
import { analysisFor } from '../analysis/editor-analysis'
import { blockWidgetField } from './base-renderer'
import { BLOCK_WIDGET_SPACING,BULLET_BLOCK_DROP, hangWidthForPos } from './content-clamp'

class TableWidget extends WidgetType {
    constructor(
        readonly table: MarkdownTable,
        /** Source offset of the table's first line — used to place the caret on click. */
        readonly from: number,
        /** Content-column clamp in characters (ADR 0020) — pads the widget to align inside a bullet. */
        readonly hangWidth: number,
        /** Inline variant: the table is a bullet's content, rendered after the marker (no padding). */
        readonly inline: boolean,
    ) {
        super()
    }

    eq(other: TableWidget): boolean {
        return (
            this.from === other.from &&
            this.hangWidth === other.hangWidth &&
            this.inline === other.inline &&
            JSON.stringify(this.table) === JSON.stringify(other.table)
        )
    }

    toDOM(): HTMLElement {
        const wrap = document.createElement('div')
        wrap.className = this.inline ? 'cm-md-table cm-md-table--inline' : 'cm-md-table cm-md-table--block'
        wrap.setAttribute('data-augmentation', 'table')
        wrap.setAttribute('data-table-from', String(this.from))
        if (!this.inline && this.hangWidth > 0) wrap.style.paddingLeft = `${this.hangWidth}ch`
        const table = wrap.appendChild(document.createElement('table'))
        const styleCell = (cell: HTMLElement, align: Align) => {
            if (align) cell.style.textAlign = align
        }
        const thead = table.appendChild(document.createElement('thead'))
        const hrow = thead.appendChild(document.createElement('tr'))
        this.table.header.forEach((h, i) => {
            const th = hrow.appendChild(document.createElement('th'))
            th.textContent = h
            styleCell(th, this.table.align[i] ?? null)
        })
        const tbody = table.appendChild(document.createElement('tbody'))
        for (const row of this.table.rows) {
            const tr = tbody.appendChild(document.createElement('tr'))
            row.forEach((c, i) => {
                const td = tr.appendChild(document.createElement('td'))
                td.textContent = c
                styleCell(td, this.table.align[i] ?? null)
            })
        }
        return wrap
    }

    ignoreEvent(): boolean {
        return false // let mousedown reach the editor handler (to place the caret)
    }
}

// A block widget from the state (base-renderer.ts): the grid stands in for the table while the
// caret is on none of its lines; a caret anywhere on them reveals the raw pipe-source. On a
// bullet line the marker stays and the grid is inline after it (the parser's `headerStart`).
const tableField = blockWidgetField<MarkdownTable>({
    blocks: (state) => analysisFor(state).tables,
    lines: (t) => ({ first: t.startLine + 1, last: t.endLine + 1 }),
    markerLength: (t) => t.headerStart,
    widget: (t, state, from) => {
        const inline = t.headerStart > 0
        return new TableWidget(t, from, inline ? 0 : hangWidthForPos(state, from), inline)
    },
})

const clickToEdit = EditorView.domEventHandlers({
    mousedown(event, view) {
        const el = (event.target as HTMLElement | null)?.closest('[data-table-from]')
        const from = el?.getAttribute('data-table-from')
        if (from == null) return false
        event.preventDefault()
        view.dispatch({ selection: { anchor: Number(from) } })
        view.focus()
        return true
    },
})

const theme = EditorView.baseTheme({
    '.cm-md-table': { overflowX: 'auto' },
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
    '.cm-md-table table': { borderCollapse: 'collapse', width: '100%' },
    '.cm-md-table th, .cm-md-table td': {
        border: '1px solid var(--gk-border-soft, rgba(0,0,0,0.2))',
        padding: '2px 8px',
    },
    '.cm-md-table th': { background: 'var(--gk-surface-2, rgba(0,0,0,0.06))', fontWeight: '700' },
})

/** The table grid widget augmentation (Dual Mode Editor.md). */
export function markdownTableAugmentation(): Extension {
    return [tableField, clickToEdit, theme]
}
