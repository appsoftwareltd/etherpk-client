/**
 * The Date Picker calendar (Dual Mode Editor.md → *Command Menu*, "Date Picker"). The shared
 * month grid (`../../calendar/month-grid.ts`) shown in a CM `showTooltip` popover, opened by the
 * `date.pick` Command from the Command Menu. Arrow keys move the focused day, PageUp/PageDown
 * page the month, Enter inserts `[[YYYY-MM-DD]]` at the stored position, Esc cancels. Focus
 * defaults to today, and days that already have a [[Document]] behind them are bold.
 *
 * A sibling of the list popover (the grid does not fit the `popoverMenu` list primitive). The
 * grid never takes DOM focus here — the caret has to stay where it is — so this file owns the
 * whole keyboard model, as a CM keymap; the [[Journal Calendar]] in the Sidebar owns its own.
 */

import { type Extension, Prec, StateEffect, StateField } from '@codemirror/state'
import { EditorView, keymap, showTooltip, type Tooltip, type TooltipView } from '@codemirror/view'

import { createMonthGrid } from '../../calendar/month-grid'
import { formatISODate, shiftDate, shiftMonth } from '../../calendar/month-grid-core'
import { applyTaskTag } from '../../task-tags'

/**
 * What the picked date is for. The calendar is one widget with two callers: the Command
 * Menu's Date Picker, which writes a `[[YYYY-MM-DD]]` wikilink, and the `#` task-tag helper,
 * which sets a dated [[Task Tag]] on the line — a rewrite of the leading run, not an
 * insertion at a point. Carrying the intent as data (rather than a callback in editor state)
 * keeps the field plainly inspectable.
 */
export type DatePickerTarget =
    | { kind: 'wikilink' }
    | { kind: 'task-tag'; tag: 'due' | 'scheduled' | 'completion' }

/** Open the calendar, applying the chosen date at `pos`. Focus starts at today. */
export const openDateCalendar = StateEffect.define<{ pos: number; target?: DatePickerTarget }>()
const setFocus = StateEffect.define<Date>()
const closeCalendar = StateEffect.define<null>()

interface CalendarState {
    /** Where the date lands: the insertion point, or a position on the task line to rewrite. */
    pos: number
    target: DatePickerTarget
    /** The currently-focused day. */
    focused: Date
}

const P = 'gk-cmd-cal'

export interface DateCalendarOptions {
    /**
     * True when a [[Document]] already resolves to that day — painted bold, so picking a date
     * shows where the graph's journal entries actually are. Asked about resolution rather than
     * document kind, exactly as the Sidebar's calendar asks it (ADR 0056).
     */
    hasEntry?: (iso: string) => boolean
}

export function dateCalendar(options: DateCalendarOptions = {}): Extension {
    const field = StateField.define<CalendarState | null>({
        create: () => null,
        update(value, tr) {
            for (const e of tr.effects) {
                if (e.is(openDateCalendar))
                    value = {
                        pos: e.value.pos,
                        target: e.value.target ?? { kind: 'wikilink' },
                        focused: new Date(),
                    }
                else if (e.is(setFocus) && value) value = { ...value, focused: e.value }
                else if (e.is(closeCalendar)) value = null
            }
            // A doc/selection change that isn't ours dismisses the calendar.
            if ((tr.docChanged || tr.selection) && !tr.effects.some((e) => e.is(openDateCalendar) || e.is(setFocus)))
                return null
            return value
        },
        provide: (f) =>
            showTooltip.from(f, (cal): Tooltip | null =>
                cal
                    ? { pos: cal.pos, above: false, strictSide: false, arrow: false, create: render }
                    : null,
            ),
    })

    function accept(view: EditorView, iso: string): boolean {
        const cal = view.state.field(field)
        if (!cal) return false

        if (cal.target.kind === 'task-tag') {
            // A dated [[Task Tag]] belongs in the leading run, wherever the caret happened to
            // be — so this replaces the whole line rather than inserting at `pos`.
            const line = view.state.doc.lineAt(cal.pos)
            const next = applyTaskTag(line.text, { kind: cal.target.tag, value: iso })
            if (next === null) {
                view.dispatch({ effects: closeCalendar.of(null) })
                return true
            }
            view.dispatch({
                changes: { from: line.from, to: line.to, insert: next },
                selection: { anchor: line.from + next.length },
                effects: closeCalendar.of(null),
                userEvent: 'input.complete',
            })
            return true
        }

        const insert = `[[${iso}]]`
        view.dispatch({
            changes: { from: cal.pos, to: cal.pos, insert },
            selection: { anchor: cal.pos + insert.length },
            effects: closeCalendar.of(null),
            userEvent: 'input.complete',
        })
        return true
    }

    function shiftFocus(view: EditorView, fn: (d: Date) => Date): boolean {
        const cal = view.state.field(field)
        if (!cal) return false
        view.dispatch({ effects: setFocus.of(fn(cal.focused)) })
        return true
    }

    function close(view: EditorView): boolean {
        if (!view.state.field(field)) return false
        view.dispatch({ effects: closeCalendar.of(null) })
        return true
    }

    function render(view: EditorView): TooltipView {
        const dom = document.createElement('div')
        dom.className = P

        const grid = createMonthGrid({
            hasEntry: options.hasEntry,
            // Never focusable: a focused cell would pull the caret out of the document, and the
            // keymap below is already driving the grid from wherever the caret is.
            focusable: false,
            testId: 'command-menu-calendar',
            onPick: (iso) => void accept(view, iso),
            onPage: (delta) => void shiftFocus(view, (d) => shiftMonth(d, delta)),
        })
        dom.appendChild(grid.dom)

        function paint(cal: CalendarState | null): void {
            if (!cal) return
            grid.render({ focused: cal.focused, mode: 'days' })
        }

        paint(view.state.field(field))
        return {
            dom,
            update(update) {
                paint(update.state.field(field))
            },
            destroy() {
                grid.destroy()
            },
        }
    }

    const calendarKeymap = Prec.highest(
        keymap.of([
            { key: 'ArrowRight', run: (v) => shiftFocus(v, (d) => shiftDate(d, 1)) },
            { key: 'ArrowLeft', run: (v) => shiftFocus(v, (d) => shiftDate(d, -1)) },
            { key: 'ArrowDown', run: (v) => shiftFocus(v, (d) => shiftDate(d, 7)) },
            { key: 'ArrowUp', run: (v) => shiftFocus(v, (d) => shiftDate(d, -7)) },
            { key: 'PageDown', run: (v) => shiftFocus(v, (d) => shiftMonth(d, 1)) },
            { key: 'PageUp', run: (v) => shiftFocus(v, (d) => shiftMonth(d, -1)) },
            {
                key: 'Enter',
                run: (v) => {
                    const cal = v.state.field(field)
                    return cal ? accept(v, formatISODate(cal.focused)) : false
                },
            },
            { key: 'Escape', run: close },
        ]),
    )

    const theme = EditorView.baseTheme({
        [`.cm-tooltip.${P}`]: { background: 'transparent', border: 'none', padding: '0' },
        // The grid brings its own border and surface; the popover adds the elevation.
        [`.cm-tooltip.${P} .gk-cal`]: { boxShadow: 'var(--gk-shadow)' },
    })

    return [field, calendarKeymap, theme]
}
