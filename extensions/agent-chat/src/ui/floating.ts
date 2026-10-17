/**
 * A list that opens against a control, in the browser's top layer (the Popover API), so the inline
 * panel's own edges never clip it however long it is. It opens below the control, or above when
 * there is more room there, never wider than the window, and follows the control as the page or
 * the document scrolls, until `stop` is called.
 */

/** The most a list grows to before it scrolls. */
const MAX_HEIGHT = 320
/** Room kept between the list and the window's edges. */
const EDGE = 8
const GAP = 4

export function placeAgainst(trigger: HTMLElement, popup: HTMLElement): { stop(): void } {
    const place = () => {
        const rect = trigger.getBoundingClientRect()
        const below = window.innerHeight - rect.bottom - GAP - EDGE
        const above = rect.top - GAP - EDGE
        const wanted = Math.min(popup.scrollHeight, MAX_HEIGHT)
        const up = below < wanted && above > below
        popup.style.maxHeight = `${Math.max(96, Math.min(MAX_HEIGHT, up ? above : below))}px`
        popup.style.minWidth = `${rect.width}px`
        popup.style.maxWidth = `${window.innerWidth - EDGE * 2}px`
        popup.style.left = `${Math.max(EDGE, Math.min(rect.left, window.innerWidth - popup.offsetWidth - EDGE))}px`
        popup.style.top = up ? `${Math.max(EDGE, rect.top - GAP - popup.offsetHeight)}px` : `${rect.bottom + GAP}px`
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return {
        stop() {
            window.removeEventListener('scroll', place, true)
            window.removeEventListener('resize', place)
        },
    }
}

/** Calls `close` on a press outside every element given, until the returned function is called. */
export function onPressOutside(elements: () => (HTMLElement | null)[], close: () => void): () => void {
    const listener = (event: PointerEvent) => {
        const target = event.target as Node | null
        if (target && elements().some((element) => element?.contains(target))) return
        close()
    }
    document.addEventListener('pointerdown', listener, true)
    return () => document.removeEventListener('pointerdown', listener, true)
}

/**
 * Classes that undo the browser's own popover box, so the list is placed by `placeAgainst`, and
 * draw it as EtherPK's menus and a select's own list are drawn (`gk-menu`, ADR 0151).
 */
export const POPUP_CLASSES = 'gk-menu fixed m-0 overflow-y-auto overscroll-contain [inset:auto]'
