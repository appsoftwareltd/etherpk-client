/**
 * Augmentation: the **`#` task-tag helper** — a popover over the [[Task Tag]] actions
 * (ADR 0032's grammar), on the same `popoverMenu` chrome as the `/` Command Menu and
 * wikilink completion.
 *
 * Two decisions worth knowing:
 *
 * 1. **It only fires on a task line.** A `#` anywhere else is prose — the grammar says so —
 *    and offering to insert a tag that the parser would then ignore would be worse than
 *    offering nothing.
 * 2. **It writes into the leading run, not at the cursor.** Tags are metadata *only* in the
 *    contiguous run after the checkbox, so a `#` typed at the end of a sentence still sets
 *    the tag where it counts; the typed `#query` is removed. That is AS Notes' behaviour too,
 *    and it means the user never has to know where the run is.
 *
 * The pure trigger/ranking logic is in `task-tag-complete-core.ts`; this is the CM binding.
 */

import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import { applyTaskTag } from '../../task-tags'
import { isInCode } from '../../wikilink/code-ranges'
import { analysisFor } from '../analysis/editor-analysis'
import { openDateCalendar } from './date-calendar'
import { type PopoverBase, type PopoverRow, popoverMenu } from './popover-menu'
import { openTaskTagContext, rankTaskTagItems, type TaskTagItem } from './task-tag-complete-core'
import { openWikilinkContext } from './wikilink-complete-core'

interface MenuState extends PopoverBase {
    items: TaskTagItem[]
    /** Document range of the typed `#query`, removed when a row is chosen. */
    from: number
    to: number
}

const svg = (paths: string) =>
    `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`

const FLAG = svg('<path d="M4 14V3h7l-1.5 2.5L11 8H4"/>')
const CLOCK = svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.2"/>')
const CALENDAR = svg('<rect x="2.5" y="3" width="11" height="11" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v2M10.5 2v2"/>')

function iconFor(item: TaskTagItem): string {
    if (item.action.kind === 'date') return CALENDAR
    if (item.action.kind === 'priority') return FLAG
    return CLOCK
}

export function taskTagCompletion(): Extension {
    function compute(state: EditorView['state']): MenuState | null {
        const sel = state.selection.main
        if (!sel.empty) return null
        const cursor = sel.head
        const line = state.doc.lineAt(cursor)

        // Only where a tag would actually BE metadata (decision 1 above).
        if (applyTaskTag(line.text, { kind: 'waiting' }) === null) return null

        const prefix = state.sliceDoc(line.from, cursor)
        const ctx = openTaskTagContext(prefix)
        if (!ctx) return null
        const from = line.from + ctx.hash
        const analysis = analysisFor(state)
        if (isInCode(analysis.codeRanges, from, cursor) || analysis.frontmatterEnd >= from) return null
        // Inside an open `[[` the user is naming a concept, not tagging — the `/` menu
        // stands down there for the same reason.
        if (openWikilinkContext(prefix)) return null

        const items = rankTaskTagItems(ctx.query)
        if (items.length === 0) return null
        return { anchor: from, selected: 0, items, from, to: cursor }
    }

    function rows(menu: MenuState): PopoverRow[] {
        return menu.items.map((item) => ({
            label: item.label,
            detail: item.detail,
            icon: iconFor(item),
            dataAttrs: { kind: item.action.kind },
        }))
    }

    function accept(view: EditorView, menu: MenuState, index: number): boolean {
        const item = menu.items[index]
        if (!item) return false

        // Remove the typed `#query` first, in its own transaction, so both arms below then
        // reason about a line that no longer contains it.
        view.dispatch({ changes: { from: menu.from, to: menu.to, insert: '' }, userEvent: 'input.complete' })

        const line = view.state.doc.lineAt(menu.from)
        if (item.action.kind === 'date') {
            // The calendar owns the rest: it rewrites the run when a day is picked. Anchored
            // where the `#` was — any position on the line resolves to the same line, and
            // this one is where the user is looking.
            view.dispatch({
                effects: openDateCalendar.of({
                    pos: menu.from,
                    target: { kind: 'task-tag', tag: item.action.tag },
                }),
            })
            return true
        }

        const next = applyTaskTag(line.text, item.action)
        if (next === null) return true
        view.dispatch({
            changes: { from: line.from, to: line.to, insert: next },
            selection: { anchor: line.from + next.length },
            userEvent: 'input.complete',
        })
        return true
    }

    return popoverMenu<MenuState>({
        testid: 'task-tag-menu',
        classPrefix: 'gk-task-tag',
        compute,
        rows,
        accept,
    })
}
