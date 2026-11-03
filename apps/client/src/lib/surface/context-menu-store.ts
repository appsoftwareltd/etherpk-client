/**
 * Open-state for the single hosted [[Context Menu]], plus the long-press gesture that raises
 * it on touch.
 *
 * A plain observable (not a `$state` rune) for the same reason as `asset-picker.ts`: the
 * callers include a delegated listener over dockview's tab DOM, which is not a Svelte
 * component at all.
 */

import type { ContextMenuTarget } from './context-menu'

export interface ContextMenuState {
    open: boolean
    x: number
    y: number
    target: ContextMenuTarget | null
}

let state: ContextMenuState = { open: false, x: 0, y: 0, target: null }
const listeners = new Set<(s: ContextMenuState) => void>()

function emit(): void {
    for (const listener of listeners) listener(state)
}

export function subscribeContextMenu(listener: (s: ContextMenuState) => void): () => void {
    listeners.add(listener)
    listener(state)
    return () => listeners.delete(listener)
}

export function getContextMenuState(): ContextMenuState {
    return state
}

export function openContextMenu(target: ContextMenuTarget, x: number, y: number): void {
    state = { open: true, x, y, target }
    emit()
}

export function closeContextMenu(): void {
    if (!state.open) return
    state = { open: false, x: 0, y: 0, target: null }
    emit()
}

/** How long a touch must be held, and how far it may drift, to count as a long press. */
const LONG_PRESS_MS = 500
const LONG_PRESS_SLOP_PX = 10

/** Options for {@link attachContextMenu}. */
export interface AttachContextMenuOptions {
    /**
     * Keep the browser's own menu, with Copy, for a press inside a text selection the person made
     * before it: for an element whose text is there to be read and copied, such as a [[Backlink]]'s
     * reference. Judged when the press starts, because a right-click on macOS selects the word
     * under the pointer before the menu event arrives, and a touch hold selects one on Android.
     */
    keepSelection?: boolean
}

/**
 * Attach right-click and long-press to an element, both raising the menu for `target()`. A
 * `target()` of null declines: nothing is prevented, so the browser's own menu shows and a touch
 * hold selects text as it would. That is how an element whose rows may all be absent (a phone,
 * where no Pane is beside another) stays out of the way.
 *
 * The long-press half is fiddlier than it looks and each guard earns its place:
 *  - **movement cancels** it, or every scroll that starts on a row opens a menu;
 *  - **the following `click` is suppressed**, or the row activates under the open menu (on a
 *    tab, the tab switches out from under it);
 *  - the caller must set `touch-action: manipulation` and `user-select: none` on the element,
 *    or iOS Safari's text-selection callout takes the gesture first.
 */
export function attachContextMenu(
    el: HTMLElement,
    target: () => ContextMenuTarget | null,
    options: AttachContextMenuOptions = {},
): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined
    let start: { x: number; y: number } | null = null
    let fired = false
    /** Whether the press now under way started inside an earlier selection; null with no press. */
    let pressInSelection: boolean | null = null

    const clear = () => {
        if (timer) clearTimeout(timer)
        timer = undefined
        start = null
    }

    /** Whether a press at (x, y) leaves the browser's menu to the person's own selection. */
    const keepsSelection = (x: number, y: number) => options.keepSelection === true && (pressInSelection ?? pointInSelection(x, y))

    const onContextMenu = (event: MouseEvent) => {
        const keep = keepsSelection(event.clientX, event.clientY)
        pressInSelection = null
        if (keep) return
        const raised = target()
        if (!raised) return
        event.preventDefault()
        event.stopPropagation()
        openContextMenu(raised, event.clientX, event.clientY)
    }

    const onPointerDown = (event: PointerEvent) => {
        // Only a press that can raise a menu: a right button, or a finger that may be held.
        const raising = event.button === 2 || event.pointerType === 'touch'
        pressInSelection = options.keepSelection && raising ? pointInSelection(event.clientX, event.clientY) : null
        if (event.pointerType !== 'touch') return
        fired = false
        start = { x: event.clientX, y: event.clientY }
        timer = setTimeout(() => {
            clear()
            if (keepsSelection(event.clientX, event.clientY)) return
            const raised = target()
            if (!raised) return
            fired = true
            openContextMenu(raised, event.clientX, event.clientY)
        }, LONG_PRESS_MS)
    }

    const onPointerMove = (event: PointerEvent) => {
        if (!start) return
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP_PX) clear()
    }

    const onClick = (event: MouseEvent) => {
        if (!fired) return
        // The long press already acted; swallow the click it generated.
        fired = false
        event.preventDefault()
        event.stopPropagation()
    }

    el.addEventListener('contextmenu', onContextMenu)
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', clear)
    el.addEventListener('pointercancel', clear)
    el.addEventListener('click', onClick, true)

    return () => {
        clear()
        el.removeEventListener('contextmenu', onContextMenu)
        el.removeEventListener('pointerdown', onPointerDown)
        el.removeEventListener('pointermove', onPointerMove)
        el.removeEventListener('pointerup', clear)
        el.removeEventListener('pointercancel', clear)
        el.removeEventListener('click', onClick, true)
    }
}

/** Whether (x, y) is on the text of the page's current selection, when it selects anything. */
function pointInSelection(x: number, y: number): boolean {
    const selection = typeof window === 'undefined' ? null : window.getSelection()
    if (!selection || selection.isCollapsed) return false
    for (let i = 0; i < selection.rangeCount; i++) {
        for (const rect of selection.getRangeAt(i).getClientRects()) {
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true
        }
    }
    return false
}
