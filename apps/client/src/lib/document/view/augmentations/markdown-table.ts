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
 *
 * A cell shows what a line off the caret shows: links, marks and hidden syntax, from the same parts
 * the read-only surfaces draw (inline-parts.ts). Its links carry the classes and attributes the
 * editor's own click handlers act on, so a click on one opens it here as it does on a line.
 */

import { type Extension } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'

import { displayNameForRef } from '../../../storage/fs/asset-store'
import { type InlinePart, inlineParts } from '../../inline-parts'
import { type Align, type MarkdownTable } from '../../markdown-table'
import { analysisFor } from '../analysis/editor-analysis'
import { blockWidgetField } from './base-renderer'
import { BLOCK_WIDGET_SPACING, BULLET_BLOCK_DROP, hangWidthForPos } from './content-clamp'
import { LINK_SELECTORS } from './link-cursor'
import { INLINE_MARK_CLASS } from './markdown-format'
import { refreshWikilinks } from './wikilink'

export interface MarkdownTableOptions {
    /** Whether a linked concept has no page yet: its link in a cell is dashed, as on a line. */
    isMissing?: (concept: string) => boolean
}

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

/** Fill a cell with its source's parts, each inside the spans of the marks over it. */
function fillCell(cell: HTMLElement, source: string, missing: ReadonlySet<string>): void {
    for (const part of inlineParts(source)) {
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
        for (const part of inlineParts(cell)) {
            if (part.kind === 'wikilink' && isMissing(part.concept)) missing.add(part.concept)
        }
    }
    return missing
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
    return a.size === b.size && [...a].every((item) => b.has(item))
}

class TableWidget extends WidgetType {
    constructor(
        readonly table: MarkdownTable,
        /** Source offset of the table's first line — used to place the caret on click. */
        readonly from: number,
        /** Content-column clamp in characters (ADR 0020) — pads the widget to align inside a bullet. */
        readonly hangWidth: number,
        /** Inline variant: the table is a bullet's content, rendered after the marker (no padding). */
        readonly inline: boolean,
        /** The cells' linked concepts with no page yet: a page created elsewhere redraws the grid. */
        readonly missing: ReadonlySet<string>,
    ) {
        super()
    }

    eq(other: TableWidget): boolean {
        return (
            this.from === other.from &&
            this.hangWidth === other.hangWidth &&
            this.inline === other.inline &&
            sameSet(this.missing, other.missing) &&
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
            fillCell(th, h, this.missing)
            styleCell(th, this.table.align[i] ?? null)
        })
        const tbody = table.appendChild(document.createElement('tbody'))
        for (const row of this.table.rows) {
            const tr = tbody.appendChild(document.createElement('tr'))
            row.forEach((c, i) => {
                const td = tr.appendChild(document.createElement('td'))
                fillCell(td, c, this.missing)
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
// The wikilink augmentation's index refresh rebuilds it too, so a cell's link stops being dashed
// once its page exists, as the same link on a line does.
function tableField(options: MarkdownTableOptions) {
    return blockWidgetField<MarkdownTable>({
        blocks: (state) => analysisFor(state).tables,
        lines: (t) => ({ first: t.startLine + 1, last: t.endLine + 1 }),
        markerLength: (t) => t.headerStart,
        widget: (t, state, from) => {
            const inline = t.headerStart > 0
            return new TableWidget(t, from, inline ? 0 : hangWidthForPos(state, from), inline, missingIn(t, options.isMissing))
        },
        rebuildOn: (tr) => tr.effects.some((effect) => effect.is(refreshWikilinks)),
    })
}

const clickToEdit = EditorView.domEventHandlers({
    mousedown(event, view) {
        const target = event.target as HTMLElement | null
        // A plain click on a link in a cell is the link's: its own augmentation opens it. With the
        // mod key held the click edits the table, as the same click on a link in a line edits it.
        if (!(event.metaKey || event.ctrlKey) && target?.closest(LINK_SELECTORS.join(', '))) return false
        const el = target?.closest('[data-table-from]')
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
    // A cell keeps its words whole. The editor's content wrapping (`overflow-wrap: anywhere`) would
    // let the table size a column below its longest word and split it; with `break-word` a column is
    // at least as wide as its longest word instead, and a table wider than the pane scrolls sideways
    // (`overflowX` above). A hyperlink still wraps anywhere, since a url has no words to keep and
    // would otherwise push the whole table wide.
    '.cm-md-table th, .cm-md-table td': {
        border: '1px solid var(--gk-border-soft, rgba(0,0,0,0.2))',
        padding: '2px 8px',
        overflowWrap: 'break-word',
        wordBreak: 'normal',
    },
    '.cm-md-table .cm-md-link': { overflowWrap: 'anywhere' },
    '.cm-md-table th': { background: 'var(--gk-surface-2, rgba(0,0,0,0.06))', fontWeight: '700' },
    // Inline code's own wash is the header's background too; the code panel's grey shows on both.
    '.cm-md-table th .cm-md-code': { background: 'var(--gk-code-bg, rgba(127, 127, 127, 0.1))' },
})

/** The table grid widget augmentation (Dual Mode Editor.md). */
export function markdownTableAugmentation(options: MarkdownTableOptions = {}): Extension {
    return [tableField(options), clickToEdit, theme]
}
