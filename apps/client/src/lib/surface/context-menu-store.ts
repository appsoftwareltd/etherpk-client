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

/**
 * Attach right-click and long-press to an element, both raising the menu for `target()`.
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
    target: () => ContextMenuTarget,
): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined
    let start: { x: number; y: number } | null = null
    let fired = false

    const clear = () => {
        if (timer) clearTimeout(timer)
        timer = undefined
        start = null
    }

    const onContextMenu = (event: MouseEvent) => {
        event.preventDefault()
        event.stopPropagation()
        openContextMenu(target(), event.clientX, event.clientY)
    }

    const onPointerDown = (event: PointerEvent) => {
        if (event.pointerType !== 'touch') return
        fired = false
        start = { x: event.clientX, y: event.clientY }
        timer = setTimeout(() => {
            fired = true
            clear()
            openContextMenu(target(), event.clientX, event.clientY)
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
