/**
 * Augmentation: a `[[`-triggered completion popover for wikilinks (Dual Mode Editor.md
 * → Wikilink completion). Built on the shared `popoverMenu` primitive (the same hand-rolled
 * `showTooltip` list the Command Menu uses), so the chrome is styled with Tailwind + the
 * site's `--gk-*` tokens and matches the wider app. The pure context/ranking/insertion logic
 * lives in `wikilink-complete-core.ts`; this file is the CM binding: `compute` detects the
 * `[[` context and ranks rows, and `accept` inserts `[[Name]]` only (page creation stays
 * lazy via open-concept.ts).
 */

import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import type { ConceptCandidate } from '../../index-db'
import { isInCode } from '../../wikilink/code-ranges'
import { analysisFor } from '../analysis/editor-analysis'
import { type PopoverBase, type PopoverRow, popoverMenu } from './popover-menu'
import {
    closingBracketOffset,
    openWikilinkContext,
    queryForWikilinkCompletion,
    rankWikilinkCompletions,
    type WikilinkCompletion,
} from './wikilink-complete-core'

export interface WikilinkCompletionOptions {
    /** The current candidate snapshot (from the active graph index). */
    concepts: () => readonly ConceptCandidate[]
    /** True while the index's initial build is still running (candidates incomplete). */
    loading?: () => boolean
}

/** The open menu: the `[[` it belongs to, the ranked rows, and the highlighted row. */
interface MenuState extends PopoverBase {
    /** Doc position just past the `[[` — where the inserted text starts. */
    from: number
    items: WikilinkCompletion[]
    /** No candidates YET — the index is still building; show a loading row, accept nothing. */
    loading?: boolean
}

// 16×16 line icons per row kind (lucide-ish).
const ICON_PATHS: Record<WikilinkCompletion['kind'], string> = {
    page: '<path d="M4 2h5l4 4v8.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5z"/><path d="M9 2v4h4"/>',
    journal: '<rect x="2.5" y="3" width="11" height="11" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v2M10.5 2v2"/>',
    alias: '<path d="M5 4v3.5a2 2 0 0 0 2 2h5"/><path d="M9.5 6.5l3 3-3 3"/>',
    pageless: '<path d="M4 2h5l4 4v8.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5z" stroke-dasharray="2 1.5"/><path d="M8 8.5v3M6.5 10h3"/>',
    create: '<circle cx="8" cy="8" r="6"/><path d="M8 5.5v5M5.5 8h5"/>',
}

const svg = (paths: string) =>
    `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`

export function wikilinkCompletion(options: WikilinkCompletionOptions): Extension {
    function compute(state: EditorView['state']): MenuState | null {
        const sel = state.selection.main
        const cursor = sel.head
        const line = state.doc.lineAt(cursor)
        const ctx = openWikilinkContext(state.sliceDoc(line.from, cursor))
        if (!ctx) return null
        // A range selection is a query only when it lies inside the slot with the caret at its
        // end: the word a wrap key has just enclosed in `[[ ]]` (wrap-selection.ts, ADR 0077),
        // which stays selected so a further press can stack. Any other range is not a query.
        if (!sel.empty && (sel.head !== sel.to || sel.from < line.from + ctx.queryFrom)) return null
        const query = queryForWikilinkCompletion(ctx, state.sliceDoc(cursor, line.to))

        const anchor = line.from + ctx.open
        const analysis = analysisFor(state)
        if (isInCode(analysis.codeRanges, anchor, cursor) || analysis.frontmatterEnd >= anchor) return null

        // Scoped concepts (names that nest a `[[…]]`) are offered at the top level but
        // hidden inside an inner slot, where inserting bracketed text would be confusing.
        const candidates = ctx.nested
            ? options.concepts().filter((c) => !c.display.includes('[['))
            : options.concepts()
        const items = rankWikilinkCompletions(candidates, query)
        if (items.length === 0) {
            // Nothing to offer — because there IS nothing, or because the index is still
            // deriving the graph. The second case must say so: an unresponsive `[[` on a
            // cold open read as the editor hanging (live, 2026-07-29).
            if (options.loading?.()) return { anchor, from: line.from + ctx.queryFrom, items: [], loading: true, selected: 0 }
            return null
        }
        return { anchor, from: line.from + ctx.queryFrom, items, selected: 0 }
    }

    function rows(menu: MenuState): PopoverRow[] {
        if (menu.loading) {
            return [
                {
                    label: 'Loading suggestions…',
                    icon: svg(ICON_PATHS.pageless),
                    dataAttrs: { 'data-concept-kind': 'loading' },
                },
            ]
        }
        return menu.items.map((row) => ({
            label: row.label,
            detail: row.detail || undefined,
            icon: svg(ICON_PATHS[row.kind]),
            dataAttrs: { 'data-concept-kind': row.kind },
        }))
    }

    /** Insert the row at `index`, consuming a trailing `]]`. */
    function accept(view: EditorView, menu: MenuState, index: number): boolean {
        if (menu.loading) return false
        const row = menu.items[index]
        if (!row) return false
        const cursor = view.state.selection.main.head
        const line = view.state.doc.lineAt(cursor)
        const close = closingBracketOffset(view.state.sliceDoc(cursor, line.to))
        const end = close >= 0 ? cursor + close : cursor
        view.dispatch({
            changes: { from: menu.from, to: end, insert: row.insert },
            selection: { anchor: menu.from + row.insert.length }, // cursor after the `]]`
            userEvent: 'input.complete',
        })
        return true
    }

    return popoverMenu<MenuState>({
        testid: 'wikilink-completion',
        classPrefix: 'gk-wl-complete',
        compute,
        rows,
        accept,
    })
}
