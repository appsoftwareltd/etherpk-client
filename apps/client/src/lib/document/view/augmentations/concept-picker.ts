/**
 * The concept picker: a list of [[Concept]]s at the caret, one of which the user picks for a
 * [[Command]] to act on. A sibling of the Command Menu's calendar and size picker, opened by a
 * Command and never by typing; the first caller is `/kanban`, which offers the concepts the
 * caret's block answers to when there is more than one (ADR 0113). EtherPK's own, with the
 * Command Menu's keys.
 *
 * Built on the shared `popoverMenu`, so it has the Command Menu's chrome and keys: the arrows
 * move, Enter or Tab picks, Escape closes. Any edit or caret move closes it too, as does the
 * editor losing focus. Another popover's late answer refreshes every popover (the `#` helper's
 * Free Tags, asked for whenever the editor takes the focus), and leaves this one as it was.
 *
 * A request carries data only (the rows and the id of the Command to run), as the calendar's
 * target does. The Command runs with `{ ...args, concept }`.
 */
import { type Extension, StateEffect, StateField } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import { tryGetActiveCommandRegistry } from '../../../surface'
import { iconSvg } from '#lib/surface/icons.js'

import { type PopoverBase, popoverMenu, refreshPopovers } from './popover-menu'

export interface ConceptPickerRow {
    concept: string
    /** A short note beside the name: where the concept comes from. */
    detail?: string
}

export interface ConceptPickerRequest {
    /** Where the list opens: the caret. */
    pos: number
    rows: readonly ConceptPickerRow[]
    /** The Command a pick runs, with `{ ...args, concept }`. */
    command: string
    /** Anything else the Command needs, passed beside the concept picked. */
    args?: Record<string, unknown>
    /** What the list is for, read out by a screen reader: "Open a Kanban board for". */
    label: string
    /** The icon each row carries. */
    icon?: string
}

/** Sent only with a refresh, by `showConceptPicker`: on its own the popover would not recompute. */
const openConceptPicker = StateEffect.define<ConceptPickerRequest>()

/** Open the picker at `request.pos` in `view`, highlighting the first row. */
export function showConceptPicker(view: EditorView, request: ConceptPickerRequest): void {
    view.dispatch({ effects: [openConceptPicker.of(request), refreshPopovers.of(null)] })
}

interface PickerState extends PopoverBase {
    request: ConceptPickerRequest
}

export function conceptPicker(): Extension {
    // The request lasts until an edit or a caret move, which close the picker. A refresh in
    // between recomputes it from here and finds it still asked for: the request lived only in the
    // transaction that made it, and a Free Tags answer landing a moment after `/kanban` shut the
    // picker under the person's eyes. Only that transaction opens it (`opensOn`), so a refresh
    // after Escape, a pick or a blur leaves it shut although the request is still held.
    const requested = StateField.define<ConceptPickerRequest | null>({
        create: () => null,
        update(value, tr) {
            const opened = tr.effects.find((effect) => effect.is(openConceptPicker))
            if (opened) return opened.value
            return tr.docChanged || tr.selection ? null : value
        },
    })

    return [
        requested,
        popoverMenu<PickerState>({
            testid: 'concept-picker',
            classPrefix: 'gk-concept-picker',
            opensOn: (tr) => tr.effects.some((effect) => effect.is(openConceptPicker)),
            compute(state) {
                const request = state.field(requested, false)
                return request ? { anchor: request.pos, request, selected: 0 } : null
            },
            rows: (menu) =>
                menu.request.rows.map((row) => ({
                    label: row.concept,
                    detail: row.detail,
                    icon: iconSvg(menu.request.icon ?? 'default', { strokeWidth: 1.3 }),
                    dataAttrs: { 'data-concept': row.concept },
                })),
            label: (menu) => menu.request.label,
            accept(_view, menu, index) {
                const row = menu.request.rows[index]
                if (!row) return false
                // The popover closes itself after an accept that leaves it open, as this one does:
                // a pick changes nothing in the text.
                const registry = tryGetActiveCommandRegistry()
                if (registry?.has(menu.request.command)) void registry.execute(menu.request.command, { ...menu.request.args, concept: row.concept })
                return true
            },
        }),
    ]
}
