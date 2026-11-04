/**
 * A finger or a stylus dragged over a PDF's text selects it, while Highlight text is on. A browser does
 * this for a mouse, but takes the same drag on a touch screen for a scroll, and leaves selecting to a
 * long press. A second finger gives the gesture back to `pdf-pinch.ts`, which zooms and moves the page.
 */
export interface TextDragHandlers {
    /** Whether a pointer of this type selects text just now. */
    takes(pointerType: string): boolean
    /** It came off the page, with whatever it selected still selected. */
    done(): void
}

interface Caret {
    node: Node
    offset: number
}

type CaretDocument = Document & {
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?(x: number, y: number): Range | null
}

/** The place in the PDF's text under a point, if the point is over any of its text. */
function textCaretAt(x: number, y: number): Caret | null {
    const from = document as CaretDocument
    const position = from.caretPositionFromPoint?.(x, y)
    const range = position ? null : from.caretRangeFromPoint?.(x, y)
    const caret = position ? { node: position.offsetNode, offset: position.offset } : range ? { node: range.startContainer, offset: range.startOffset } : null
    return caret?.node.nodeType === Node.TEXT_NODE && caret.node.parentElement?.closest('.textLayer') ? caret : null
}

export function listenForTextDrag(element: HTMLElement, handlers: TextDragHandlers, signal: AbortSignal): void {
    let pointerId: number | null = null
    /** Where the selection starts: the first text the drag reached, which may not be where it began. */
    let anchor: Caret | null = null

    const extendTo = (event: PointerEvent) => {
        const caret = textCaretAt(event.clientX, event.clientY)
        if (!caret) return
        anchor ??= caret
        window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, caret.node, caret.offset)
    }
    const drop = () => {
        pointerId = null
        anchor = null
    }

    element.addEventListener(
        'pointerdown',
        (event) => {
            if (!event.isPrimary || event.pointerType === 'mouse' || !handlers.takes(event.pointerType)) return
            // A stylus can reach a page as a mouse does, which would start selecting in its own way,
            // and then take a drag from inside this selection for dragging the text somewhere.
            event.preventDefault()
            pointerId = event.pointerId
            anchor = null
            extendTo(event)
        },
        { signal },
    )
    element.addEventListener(
        'dragstart',
        (event) => {
            if (pointerId !== null) event.preventDefault()
        },
        { signal },
    )
    element.addEventListener(
        'pointermove',
        (event) => {
            if (event.pointerId === pointerId) extendTo(event)
        },
        { signal },
    )
    element.addEventListener(
        'pointerup',
        (event) => {
            if (event.pointerId !== pointerId) return
            drop()
            handlers.done()
        },
        { signal },
    )
    element.addEventListener(
        'pointercancel',
        (event) => {
            if (event.pointerId !== pointerId) return
            drop()
            window.getSelection()?.removeAllRanges()
        },
        { signal },
    )
    // Pointer events come first, so a drag this took is known by now. Without this a browser would
    // scroll with it, or wait for a long press to select in its own way.
    element.addEventListener(
        'touchstart',
        (event) => {
            if (pointerId === null) return
            if (event.touches.length === 1) {
                event.preventDefault()
                return
            }
            drop()
            window.getSelection()?.removeAllRanges()
        },
        { passive: false, signal },
    )
}
