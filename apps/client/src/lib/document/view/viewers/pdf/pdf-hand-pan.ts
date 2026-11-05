/**
 * The Hand tool: a mouse dragging the page moves it, as a finger does. A finger and a stylus are left to
 * the browser. A press that does not move leaves the click to what is under it, so a link still opens.
 */

/** A movement shorter than this is a shaky click, not a drag. */
const DRAG_SLOP_PX = 4
/** What a press on it means something else: a dragged signature, a form field, a note. */
const KEEPS_ITS_PRESS = 'button, input, select, textarea, .etherpk-pdf-note, .etherpk-pdf-signature'

export function listenForHandPan(scroller: HTMLElement, isOn: () => boolean, signal: AbortSignal): void {
    let press: { pointerId: number; x: number; y: number; left: number; top: number } | null = null
    let dragged = false

    const onPointerDown = (event: PointerEvent) => {
        dragged = false
        if (!isOn() || event.pointerType !== 'mouse' || event.button !== 0) return
        if (event.target instanceof Element && event.target.closest(KEEPS_ITS_PRESS)) return
        press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: scroller.scrollLeft, top: scroller.scrollTop }
    }

    const onPointerMove = (event: PointerEvent) => {
        if (!press || event.pointerId !== press.pointerId) return
        const dx = event.clientX - press.x
        const dy = event.clientY - press.y
        if (!dragged && Math.hypot(dx, dy) < DRAG_SLOP_PX) return
        if (!dragged) {
            // Only now, because a captured pointer's click would never reach a link under it.
            dragged = true
            scroller.setPointerCapture(event.pointerId)
            scroller.toggleAttribute('data-panning', true)
        }
        scroller.scrollTo({ left: press.left - dx, top: press.top - dy })
    }

    const onPointerEnd = () => {
        press = null
        scroller.toggleAttribute('data-panning', false)
    }

    scroller.addEventListener('pointerdown', onPointerDown, { signal })
    scroller.addEventListener('pointermove', onPointerMove, { signal })
    scroller.addEventListener('pointerup', onPointerEnd, { signal })
    scroller.addEventListener('pointercancel', onPointerEnd, { signal })
    // The click a drag ends in, which is no press on what it ended over.
    scroller.addEventListener(
        'click',
        (event) => {
            if (!dragged) return
            dragged = false
            event.preventDefault()
            event.stopPropagation()
        },
        { capture: true, signal },
    )
    // A link would otherwise be picked up by the browser's own drag.
    scroller.addEventListener('dragstart', (event) => isOn() && event.preventDefault(), { signal })
}
