/**
 * The shared **popover menu** primitive (Dual Mode Editor.md → *Command Menu*). A
 * hand-rolled, cursor-anchored list popover on CodeMirror's `showTooltip` facet: a
 * `StateField` holding the open menu, a high-precedence keymap (↑/↓/Enter/Tab/Esc), mouse
 * handling (mousedown to accept, mousemove to highlight), and an imperative DOM styled
 * with Tailwind + the site's `--gk-*` tokens. Extracted from the wikilink completion
 * popover so both it and the Command Menu (the `/` slash menu) render the same chrome —
 * icon · label · detail rows — and own their keymap (Enter accepts instantly).
 *
 * The primitive is generic over a caller **menu state** `S` (anything carrying an
 * `anchor` doc position and a `selected` row index). The caller supplies `compute` (state
 * → menu | null), `rows` (menu → the rendered rows), and `accept` (do the side effect).
 * CM owns the positioning; we own the DOM.
 */

import { type EditorState, type Extension, Prec, StateEffect, StateField } from '@codemirror/state'
import { EditorView, keymap, showTooltip, tooltips, type Tooltip, type TooltipView } from '@codemirror/view'

/** The minimum a caller's menu state must carry: where to anchor, and the highlighted row. */
export interface PopoverBase {
    /** Opening marker: the preferred horizontal anchor, stable while the query is typed. */
    anchor: number
    /** Index of the highlighted row. */
    selected: number
}

/** One rendered row: an optional icon (inner `<svg>` markup), a label, and a detail hint. */
export interface PopoverRow {
    label: string
    detail?: string
    /** Inner markup for the row icon (a full `<svg>…</svg>`); omitted ⇒ no icon slot. */
    icon?: string
    /** Extra `data-*` attributes set on the row element (e.g. a kind for styling/tests). */
    dataAttrs?: Record<string, string>
}

export interface PopoverMenuOptions<S extends PopoverBase> {
    /** `data-testid` on the listbox element. */
    testid: string
    /** BEM-ish class prefix for the surface (`gk-wl-complete`, `gk-cmd-menu`, …). */
    classPrefix: string
    /** Recompute the menu from editor state, or null to close it. */
    compute(state: EditorState): S | null
    /** The rows to render for `menu`, in order (length defines navigation wrap-around). */
    rows(menu: S): PopoverRow[]
    /** Accept the row at `index`: mutate the doc / run side effects. Returns whether handled. */
    accept(view: EditorView, menu: S, index: number): boolean
}

const TAILWIND_MENU =
    'relative overflow-y-auto rounded-md border ' +
    'border-[var(--gk-border-soft)] bg-[var(--gk-surface-1)] py-1 shadow-[var(--gk-shadow)]'
const TAILWIND_ITEM =
    'flex cursor-pointer select-none items-center gap-2 px-2.5 py-1.5 text-sm text-[var(--gk-text-default)]'
const TAILWIND_ITEM_SELECTED = 'bg-[var(--gk-surface-2)]'

// Share one facet across the completion extensions. The browser viewport alone is too wide
// for a docked document: a tooltip there can spill into its neighbour and create pane overflow.
const paneTooltips = tooltips({
    tooltipSpace(view) {
        const scroll = view.scrollDOM
        const rect = scroll.getBoundingClientRect()
        const viewport = view.dom.ownerDocument.documentElement
        const left = rect.left + scroll.clientLeft * view.scaleX
        const top = rect.top + scroll.clientTop * view.scaleY
        return {
            left: Math.max(0, left),
            right: Math.min(viewport.clientWidth, left + scroll.clientWidth * view.scaleX),
            top: Math.max(0, top),
            bottom: Math.min(viewport.clientHeight, top + scroll.clientHeight * view.scaleY),
        }
    },
})

export function popoverMenu<S extends PopoverBase>(opts: PopoverMenuOptions<S>): Extension {
    const { classPrefix: p } = opts

    const selectIndex = StateEffect.define<number>() // absolute highlight index
    const closeMenu = StateEffect.define<null>()

    const menuField = StateField.define<S | null>({
        create: (state) => opts.compute(state),
        update(value, tr) {
            for (const e of tr.effects) {
                if (e.is(closeMenu)) return null
                if (e.is(selectIndex) && value) value = { ...value, selected: e.value } as S
            }
            if (tr.docChanged || tr.selection) return opts.compute(tr.state)
            return value
        },
        provide: (f) =>
            showTooltip.compute([f, 'selection'], (state): Tooltip | null => {
                const menu = state.field(f)
                return menu
                    ? { pos: state.selection.main.head, above: false, strictSide: false, arrow: false, create: renderTooltip }
                    : null
            }),
    })

    function accept(view: EditorView, index?: number): boolean {
        const menu = view.state.field(menuField)
        if (!menu) return false
        return opts.accept(view, menu, index ?? menu.selected)
    }

    function move(view: EditorView, delta: number): boolean {
        const menu = view.state.field(menuField)
        if (!menu) return false
        const n = opts.rows(menu).length
        if (n === 0) return false
        view.dispatch({ effects: selectIndex.of((menu.selected + delta + n) % n) })
        return true
    }

    function close(view: EditorView): boolean {
        if (!view.state.field(menuField)) return false
        view.dispatch({ effects: closeMenu.of(null) })
        return true
    }

    function renderTooltip(view: EditorView): TooltipView {
        // CM adds `.cm-tooltip` to `dom`; the baseTheme below resets that wrapper and the
        // inner element carries the surface so Tailwind classes win cleanly.
        const dom = document.createElement('div')
        dom.className = p
        let queryRect: { top: number; bottom: number } | null = null

        const menuEl = document.createElement('div')
        menuEl.className = `${p}__menu ${TAILWIND_MENU}`
        menuEl.setAttribute('role', 'listbox')
        menuEl.setAttribute('data-testid', opts.testid)
        dom.appendChild(menuEl)

        function render(menu: S | null): void {
            if (!menu) return
            menuEl.replaceChildren()
            const rows = opts.rows(menu)
            rows.forEach((row, i) => {
                const item = document.createElement('div')
                item.className = `${p}__item ${TAILWIND_ITEM}` + (i === menu.selected ? ` ${TAILWIND_ITEM_SELECTED}` : '')
                item.setAttribute('role', 'option')
                item.setAttribute('aria-selected', String(i === menu.selected))
                item.setAttribute('data-index', String(i))
                for (const [k, v] of Object.entries(row.dataAttrs ?? {})) item.setAttribute(k, v)

                if (row.icon) {
                    const icon = document.createElement('span')
                    icon.className = `${p}__icon inline-flex w-4 h-4 flex-none text-[var(--gk-text-subtle)]`
                    icon.innerHTML = row.icon
                    item.appendChild(icon)
                }

                const label = document.createElement('span')
                label.className = `${p}__label min-w-0 flex-1 truncate`
                label.textContent = row.label
                item.appendChild(label)

                if (row.detail) {
                    const detail = document.createElement('span')
                    detail.className = `${p}__detail flex-none text-sm text-[var(--gk-text-muted)]`
                    detail.textContent = row.detail
                    item.appendChild(detail)
                }
                menuEl.appendChild(item)
            })
        }

        // Mousedown (not click) so the editor keeps focus; accept the clicked row.
        menuEl.addEventListener('mousedown', (event) => {
            const el = (event.target as HTMLElement | null)?.closest('[data-index]')
            if (!el) return
            event.preventDefault()
            accept(view, Number(el.getAttribute('data-index')))
        })
        // Hover moves the highlight (only when it actually changes).
        menuEl.addEventListener('mousemove', (event) => {
            const el = (event.target as HTMLElement | null)?.closest('[data-index]')
            if (!el) return
            const i = Number(el.getAttribute('data-index'))
            const menu = view.state.field(menuField)
            if (menu && menu.selected !== i) view.dispatch({ effects: selectIndex.of(i) })
        })

        render(view.state.field(menuField))
        return {
            dom,
            // CM's resize path caches the original height for this tooltip's lifetime. A
            // filtered list would keep that height, or be positioned using it after growing
            // the pane. Let CSS constrain the current content instead; CM still chooses its
            // side and position and remeasures whenever the wrapper's size changes.
            resize: false,
            getCoords(pos) {
                // Keep the menu steady horizontally, but include every visual line from the
                // opening marker to the caret when choosing below/above. Anchoring at `[[`
                // alone hides the rest of a wrapped query underneath the menu.
                const caret = view.coordsAtPos(pos)
                if (!caret) return { left: -1, right: -1, top: -1, bottom: -1 }
                const menu = view.state.field(menuField)
                const start = (menu && view.coordsAtPos(menu.anchor)) || caret
                const rect = { left: start.left, right: start.right, top: Math.min(start.top, caret.top), bottom: Math.max(start.bottom, caret.bottom) }
                queryRect = rect
                return rect
            },
            update(update) {
                render(update.state.field(menuField))
            },
            positioned(space) {
                // CM clamps the position but does not shrink a tooltip horizontally. Constrain
                // the wrapper, then let both label and detail truncate inside a narrow pane.
                dom.style.setProperty('--popover-space-width', `${Math.max(0, space.right - space.left) / view.scaleX}px`)
                if (queryRect) {
                    // Constrain to the larger space, letting CM choose the side. Using only
                    // its previous side's space can keep a tiny menu stuck there after resize.
                    // A max-height (not a fixed height) also shrinks with the filtered content.
                    const available = Math.max(0, queryRect.top - space.top, space.bottom - queryRect.bottom) / view.scaleY
                    dom.style.setProperty('--popover-space-height', `${available}px`)
                    // Preserve CM's insufficient-space hiding while opting out of its fixed
                    // height. Visibility keeps the wrapper measurable when room opens again.
                    dom.style.visibility = available < view.defaultLineHeight ? 'hidden' : ''
                }

                // scrollIntoView also scrolls ancestors, including the document pane. Only this
                // list owns highlight scrolling. Wait until CM has sized/positioned the tooltip
                // so the first render cannot scroll an off-screen, unmeasured wrapper into view.
                const selected = view.state.field(menuField)?.selected
                const item = selected === undefined ? undefined : menuEl.children[selected] as HTMLElement | undefined
                if (!item) return
                const bottom = item.offsetTop + item.offsetHeight
                if (item.offsetTop < menuEl.scrollTop) menuEl.scrollTop = item.offsetTop
                else if (bottom > menuEl.scrollTop + menuEl.clientHeight) menuEl.scrollTop = bottom - menuEl.clientHeight
            },
        }
    }

    // Active only while the menu is open; otherwise these keys fall through (each `run`
    // returns false when the field is null). Higher precedence than the outliner keymap.
    const completionKeymap = Prec.highest(
        keymap.of([
            { key: 'ArrowDown', run: (v) => move(v, 1) },
            { key: 'ArrowUp', run: (v) => move(v, -1) },
            { key: 'Enter', run: (v) => accept(v) },
            { key: 'Tab', run: (v) => accept(v) },
            { key: 'Escape', run: close },
        ]),
    )

    const theme = EditorView.baseTheme({
        // Strip CM's default tooltip chrome; the inner menu carries the surface.
        // Width limits belong on the wrapper CM measures. Limiting only the inner list can
        // leave an invisible wide wrapper that shifts a long suggestion too far to the left.
        [`.cm-tooltip.${p}`]: {
            background: 'transparent', border: 'none', padding: '0', width: 'max-content',
            minWidth: 'min(15rem, var(--popover-space-width, 100vw))',
            maxWidth: 'min(24rem, var(--popover-space-width, 100vw))',
            // Bound the height CM measures, not only the painted list. A percentage height on
            // that child is initially indefinite: CM caches the full unscrolled list height,
            // positions the wrapper far above the caret, then the smaller menu leaves a gap.
            display: 'flex', flexDirection: 'column',
            maxHeight: 'min(16rem, var(--popover-space-height, 16rem))',
        },
        // Flex sizing keeps the visible surface flush with the height-constrained wrapper
        // when neither side has 16rem available, and scrolls just the rows.
        [`.${p}__menu`]: { maxWidth: '100%', minHeight: '0', flex: '1 1 auto' },
        [`.${p}__detail`]: { minWidth: '0', maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    })

    return [paneTooltips, menuField, completionKeymap, theme]
}
