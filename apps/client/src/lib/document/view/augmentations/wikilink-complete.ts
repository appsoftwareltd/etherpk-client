/**
 * Augmentation: a `[[`-triggered completion popover for wikilinks (Dual Mode Editor.md
 * → Wikilink completion). Built on the shared `popoverMenu` primitive (the same hand-rolled
 * `showTooltip` list the Command Menu uses), so the chrome is styled with Tailwind + the
 * site's `--gk-*` tokens and matches the wider app. The pure context/ranking/insertion logic
 * lives in `wikilink-complete-core.ts`; this file is the CM binding: `compute` detects the
 * `[[` context and ranks rows, and `accept` inserts `[[Name]]` only (page creation stays
 * lazy via open-concept.ts).
 */

import { type Extension, MapMode, StateField, type Transaction } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import { iconSvg } from '$lib/surface/icons'

import type { ConceptCandidate } from '../../index-db'
import { isInCode } from '../../wikilink/code-ranges'
import { analysisFor } from '../analysis/editor-analysis'
import { type PopoverBase, type PopoverRow, popoverMenu } from './popover-menu'
import {
    closingBracketOffset,
    enclosingLinkClose,
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

/**
 * The `]]` of every link the user has typed a `[` inside, as document positions, each kept while
 * a `]]` is still there. Text alone cannot say whose the `]]` is in `[[Physics [[Quan|]]`: the link
 * just typed inside Physics, or an existing Quan inside a Physics not yet closed
 * (`[[[[Phy|sics]] Quantum`). Typing `[[` into `[[Physics |]]` is what made the first, so the `]]`
 * Physics had then stays Physics's, and accepting `Quantum` closes only the new link. Taking it
 * for the inner link's left Physics unclosed, and the edit then proposed no rename (ADR 0065).
 */
const enclosingLinkCloses = StateField.define<readonly number[]>({
    create: () => [],
    update(closes, tr) {
        if (!tr.docChanged) return closes
        const kept: number[] = []
        for (const at of closes) {
            const mapped = tr.changes.mapPos(at, 1, MapMode.TrackDel)
            if (mapped !== null && tr.state.sliceDoc(mapped, mapped + 2) === ']]') kept.push(mapped)
        }
        for (const close of typedInsideLinks(tr)) if (!kept.includes(close)) kept.push(close)
        return kept
    },
})

/** The `]]` positions, in the new document, of the links this transaction typed a `[` inside. */
function typedInsideLinks(tr: Transaction): number[] {
    if (!tr.isUserEvent('input')) return []
    const closes: number[] = []
    tr.changes.iterChanges((fromA, _toA, _fromB, _toB, inserted) => {
        if (!inserted.toString().includes('[')) return
        const line = tr.startState.doc.lineAt(fromA)
        const column = enclosingLinkClose(line.text, fromA - line.from)
        if (column >= 0) closes.push(tr.changes.mapPos(line.from + column, 1))
    })
    return closes
}

/** The open menu: the `[[` it belongs to, the ranked rows, and the highlighted row. */
interface MenuState extends PopoverBase {
    /** Doc position just past the `[[` — where the inserted text starts. */
    from: number
    /** Where the replaced text ends: past the link's own `]]` when it has one, else the caret. */
    to: number
    items: WikilinkCompletion[]
    /** No candidates YET — the index is still building; show a loading row, accept nothing. */
    loading?: boolean
}

/** The icon each kind of row carries, from the shared table (`surface/icons.ts`). */
const ROW_ICONS: Record<WikilinkCompletion['kind'], string> = {
    page: 'page',
    journal: 'calendar',
    alias: 'alias',
    pageless: 'pageless',
    create: 'new-page',
}

const rowIcon = (name: string) => iconSvg(name, { strokeWidth: 1.3 })

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
        const suffix = state.sliceDoc(cursor, line.to)
        let close = closingBracketOffset(suffix)
        // In an inner slot, a `]]` an enclosing link had when a `[` was typed inside it is that
        // link's: the link being completed has none of its own yet (enclosingLinkCloses).
        if (close >= 0 && ctx.nested && state.field(enclosingLinkCloses).includes(cursor + close - 2)) close = -1
        const query = queryForWikilinkCompletion(ctx, suffix, close)
        const replace = { from: line.from + ctx.queryFrom, to: close >= 0 ? cursor + close : cursor }

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
            if (options.loading?.()) return { anchor, ...replace, items: [], loading: true, selected: 0 }
            return null
        }
        return { anchor, ...replace, items, selected: 0 }
    }

    function rows(menu: MenuState): PopoverRow[] {
        if (menu.loading) {
            return [
                {
                    label: 'Loading suggestions…',
                    icon: rowIcon(ROW_ICONS.pageless),
                    dataAttrs: { 'data-concept-kind': 'loading' },
                },
            ]
        }
        return menu.items.map((row) => ({
            label: row.label,
            detail: row.detail || undefined,
            icon: rowIcon(ROW_ICONS[row.kind]),
            dataAttrs: { 'data-concept-kind': row.kind },
        }))
    }

    /** Insert the row at `index`, consuming the link's own trailing `]]` (`menu.to`). */
    function accept(view: EditorView, menu: MenuState, index: number): boolean {
        if (menu.loading) return false
        const row = menu.items[index]
        if (!row) return false
        view.dispatch({
            changes: { from: menu.from, to: menu.to, insert: row.insert },
            selection: { anchor: menu.from + row.insert.length }, // cursor after the `]]`
            userEvent: 'input.complete',
        })
        return true
    }

    // A field read during another's update is resolved first, so the menu sees this transaction's closes.
    return [
        enclosingLinkCloses,
        popoverMenu<MenuState>({
            testid: 'wikilink-completion',
            classPrefix: 'gk-wl-complete',
            compute,
            rows,
            accept,
        }),
    ]
}
