/**
 * The pointer rules of a Map Block's resize handle: one drag at a time, from a primary press to its
 * release or cancel. Escape, or the pointer being cancelled, cancels. They are an image's handle's
 * rules (`image-resize.ts` in the Client), kept here because an extension takes no new import from
 * the Client (ADR 0121). What a drag shows and what it writes are the owner's.
 *
 * A drag redraws its map through the editor. On a bullet's line that rebuilds the line, which takes
 * the handle out of the document and puts it back, and the browser lets go of its pointer capture
 * when it does. So the drag's events are heard on the window, wherever they land, and the capture,
 * which keeps a release outside the window from being missed, is taken again.
 */

/** What a handle's owner does at each step of a drag. */
export interface ResizeDrag {
    /** Whether a press or a double click counts now: false while the document cannot be written. */
    enabled(): boolean
    /** A press took the handle: read the size to start from, and show that a drag is on. */
    begin(): void
    /** The pointer is this far from where it was pressed. */
    move(x: number, y: number): void
    /** The drag is over, by a release or a cancel: put back whatever was changed to show it. */
    finish(): void
    /** The pointer came up, straight after `finish`: write what the drag ended at. */
    release(): void
    /** A double click: go back to the default size. */
    reset(): void
}

/** Make `handle` drive `drag`. Returns the way to stop, which ends a drag still running. */
export function attachResizeDrag(handle: HTMLElement, drag: ResizeDrag): () => void {
    let press: { pointerId: number; x: number; y: number } | null = null

    /** Let go of the pointer and the keyboard, and let the owner put things back. */
    const end = () => {
        if (!press) return
        if (handle.hasPointerCapture(press.pointerId)) handle.releasePointerCapture(press.pointerId)
        window.removeEventListener('keydown', onKey, true)
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', onRelease, true)
        window.removeEventListener('pointercancel', onCancel, true)
        press = null
        drag.finish()
    }
    const onKey = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return
        // The map's own Escape closes what is open on it, and the editor's leaves a block selection.
        event.preventDefault()
        event.stopPropagation()
        end()
    }
    const onPress = (event: PointerEvent) => {
        if (!event.isPrimary || event.button !== 0 || !drag.enabled()) return
        event.preventDefault()
        event.stopPropagation()
        press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
        handle.setPointerCapture(event.pointerId)
        drag.begin()
        window.addEventListener('keydown', onKey, true)
        window.addEventListener('pointermove', onMove, true)
        window.addEventListener('pointerup', onRelease, true)
        window.addEventListener('pointercancel', onCancel, true)
    }
    const onMove = (event: PointerEvent) => {
        if (!press || event.pointerId !== press.pointerId) return
        drag.move(event.clientX - press.x, event.clientY - press.y)
    }
    const onRelease = (event: PointerEvent) => {
        if (!press || event.pointerId !== press.pointerId) return
        end()
        drag.release()
    }
    const onCancel = (event: PointerEvent) => {
        if (press && event.pointerId === press.pointerId) end()
    }
    const onCaptureLost = () => {
        if (!press || !handle.isConnected) return
        try {
            handle.setPointerCapture(press.pointerId)
        } catch {
            // The pointer is gone: its `pointerup` or `pointercancel` ends the drag.
        }
    }
    const onDoubleClick = (event: MouseEvent) => {
        event.preventDefault()
        event.stopPropagation()
        if (drag.enabled()) drag.reset()
    }

    handle.addEventListener('pointerdown', onPress)
    handle.addEventListener('lostpointercapture', onCaptureLost)
    handle.addEventListener('dblclick', onDoubleClick)
    return () => {
        end()
        handle.removeEventListener('pointerdown', onPress)
        handle.removeEventListener('lostpointercapture', onCaptureLost)
        handle.removeEventListener('dblclick', onDoubleClick)
    }
}
