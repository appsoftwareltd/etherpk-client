/**
 * Two fingers zoom and move the PDF. Written here rather than taken from pdf.js's `TouchManager`, which
 * swallows the first finger's `pointerdown` to keep its own editor from starting on a pinch: that would
 * also swallow a finger drawing, a dragged signature and a tap. One finger is left entirely alone, so the
 * browser scrolls with it, unless it is drawing, and then two fingers are the way to move the page. The scroller's `touch-action` keeps the browser from pinching the app.
 */
export interface PinchHandlers {
    onStart(): void
    /** The fingers moved: scale by `factor` about the point between them. */
    onPinch(origin: [number, number], factor: number): void
    /** The point between them moved by this much, in screen pixels. */
    onPan(dx: number, dy: number): void
    onEnd(): void
}

/** One event's movement counts for no more than this. A mouse wheel reports 100 or more for one step. */
const WHEEL_STEP_LIMIT_PX = 20
const WHEEL_ZOOM_RATE = 0.01
/** A wheel in lines or pages reports a small number that means a large movement. */
const WHEEL_UNIT_PX: Record<number, number> = { 0: 1, 1: 40, 2: 800 }

/**
 * How much one wheel event scales the PDF. A trackpad pinch reports small movements, which it
 * follows, and the limit makes a mouse wheel's one large report a single even step.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
    const moved = deltaY * (WHEEL_UNIT_PX[deltaMode] ?? 1)
    return Math.exp(-Math.max(-WHEEL_STEP_LIMIT_PX, Math.min(WHEEL_STEP_LIMIT_PX, moved)) * WHEEL_ZOOM_RATE)
}

/** Moves smaller than this are the fingers settling, not a zoom. */
const MIN_CHANGE_PX = 2

function spreadOf(touches: TouchList): { distance: number; origin: [number, number] } {
    const [a, b] = [touches[0], touches[1]]
    return {
        distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        origin: [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2],
    }
}

export function listenForPinch(element: HTMLElement, handlers: PinchHandlers, signal: AbortSignal): void {
    let last: number | null = null
    let lastOrigin: [number, number] = [0, 0]
    const options = { passive: false, signal }
    element.addEventListener(
        'touchstart',
        (event) => {
            if (event.touches.length !== 2) return
            event.preventDefault()
            const spread = spreadOf(event.touches)
            last = spread.distance
            lastOrigin = spread.origin
            handlers.onStart()
        },
        options,
    )
    element.addEventListener(
        'touchmove',
        (event) => {
            if (last === null || event.touches.length !== 2) return
            event.preventDefault()
            const { distance, origin } = spreadOf(event.touches)
            handlers.onPan(origin[0] - lastOrigin[0], origin[1] - lastOrigin[1])
            lastOrigin = origin
            if (Math.abs(distance - last) < MIN_CHANGE_PX || last === 0) return
            handlers.onPinch(origin, distance / last)
            last = distance
        },
        options,
    )
    const finish = (event: TouchEvent) => {
        if (last === null || event.touches.length >= 2) return
        last = null
        handlers.onEnd()
    }
    element.addEventListener('touchend', finish, { signal })
    element.addEventListener('touchcancel', finish, { signal })
}
