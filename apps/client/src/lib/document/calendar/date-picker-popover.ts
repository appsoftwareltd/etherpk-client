/**
 * `context.dialogs.pickDate`: the Date Picker panel (`date-picker.ts`) drawn by the Client beside an
 * element an extension names, the Task Editor's Due field for one. The same panel, keys and test
 * hooks as the editor's Date Picker; what differs is who has the keyboard. The editor's calendar
 * never takes focus, because the caret must stay in the document. This one has no document behind
 * it, so it takes focus as it opens, its cells carry a roving tab stop, and it gives focus back to
 * the anchor as it closes (the date picker dialog of the WAI-ARIA Authoring Practices).
 *
 * Mounted on the page's body at `--z-menu`, which `layers.css` keeps above every dialog level, so it
 * is drawn over the dialog its anchor is in. It handles Escape itself and marks the key handled,
 * so the dialog below does not close on the same press (Dialog.svelte skips a handled Escape).
 */

import { createDatePicker, placeDatePicker } from './date-picker'
import { DATE_PICKER_MOVES, parseISODate, shiftMonth } from './month-grid-core'

export interface DatePickerPopoverOptions {
    anchor: HTMLElement
    value?: string
    label?: string
}

/** The calendar open now, or null: one at a time, wherever it was asked for. */
let openNow: { anchor: HTMLElement; dismiss(): void } | null = null

/**
 * Open the calendar beside `options.anchor`. Resolves to the day picked, `YYYY-MM-DD`, or undefined
 * when it closes without one. Asked again with the anchor of the calendar open now, it closes that
 * calendar, so the button that opened it closes it too.
 */
export function pickDateBeside(options: DatePickerPopoverOptions): Promise<string | undefined> {
    const toggled = openNow?.anchor === options.anchor
    openNow?.dismiss()
    if (toggled) return Promise.resolve(undefined)
    return new Promise((resolve) => openPopover(options, resolve))
}

function openPopover(options: DatePickerPopoverOptions, resolve: (value: string | undefined) => void): void {
    const { anchor } = options
    let focused = parseISODate(options.value ?? '') ?? new Date()
    let frame = 0
    let done = false

    const root = document.createElement('div')
    root.className = 'fixed top-0 left-0 z-(--z-menu)'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-label', options.label ?? 'Choose a date')
    const grid = createDatePicker({
        focusable: true,
        onPick: (iso) => finish(iso, true),
        onPage: (delta) => show(shiftMonth(focused, delta)),
    })
    root.appendChild(grid.dom)

    /** Paint `next` as the focused day and move focus onto it: the roving tab stop's other half. */
    function show(next: Date): void {
        focused = next
        grid.render({ focused, mode: 'days' })
        grid.focusSelected()
    }

    /**
     * Keep beside the anchor on every frame while open. A scroll in any container, a dialog
     * growing, or the anchor leaving the page (its dialog closed) all show up here, which is
     * simpler than listening for each one.
     */
    function follow(): void {
        if (!anchor.isConnected) return finish(undefined, false)
        const { top, left } = placeDatePicker(
            anchor.getBoundingClientRect(),
            { width: root.offsetWidth, height: root.offsetHeight },
            { width: window.innerWidth, height: window.innerHeight },
        )
        root.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
        frame = requestAnimationFrame(follow)
    }

    function onKeydown(event: KeyboardEvent): void {
        if (event.altKey || event.ctrlKey || event.metaKey) return
        if (Object.hasOwn(DATE_PICKER_MOVES, event.key)) {
            event.preventDefault()
            show(DATE_PICKER_MOVES[event.key](focused))
        } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            finish(undefined, true)
        } else if (event.key === 'Tab') {
            // Focus goes back to the anchor and the key's own move carries on from there, so Tab
            // reaches the control after the field, as it would had the calendar never opened.
            finish(undefined, true)
        }
        // Enter and Space reach the focused day's button, whose click picks it.
    }

    /** A press anywhere but the calendar closes it. A press on the anchor is left to the anchor. */
    function onPointerDown(event: PointerEvent): void {
        const target = event.target as Node | null
        if (target && (root.contains(target) || anchor.contains(target))) return
        finish(undefined, false)
    }

    function finish(value: string | undefined, returnFocus: boolean): void {
        if (done) return
        done = true
        cancelAnimationFrame(frame)
        document.removeEventListener('pointerdown', onPointerDown, true)
        root.removeEventListener('keydown', onKeydown)
        grid.destroy()
        root.remove()
        if (openNow === entry) openNow = null
        if (returnFocus && anchor.isConnected) anchor.focus()
        resolve(value)
    }

    const entry = { anchor, dismiss: () => finish(undefined, false) }
    openNow = entry
    root.addEventListener('keydown', onKeydown)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.body.appendChild(root)
    // Painted before it is placed, so the first placement knows its size; focused once placed.
    grid.render({ focused, mode: 'days' })
    follow()
    grid.focusSelected()
}
