/**
 * Two fingers zoom and move the PDF. Written here rather than taken from pdf.js's `TouchManager`, which
 * swallows the first finger's `pointerdown` to keep its own editor from starting on a pinch: that would
 * also swallow a finger drawing, a dragged signature and a tap. One finger is left entirely alone, so the
 * browser scrolls with it, unless it is drawing, and then two fingers are the way to move the page. The scroller's `touch-action` keeps the browser from pinching the app.
 */
export interface PinchChange {
    /** The point between the fingers now, in screen pixels. */
    origin: [number, number]
    /** How far that point moved since the last change, in screen pixels. */
    pan: [number, number]
    /** How much the fingers have spread since they took hold: 1 is not at all. */
    zoom: number
}

export interface PinchHandlers {
    onStart(): void
    /** The fingers moved, told at most once a frame. */
    onMove(change: PinchChange): void
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

/** A spread smaller than this is the fingers settling, not a zoom. */
const MIN_CHANGE_PX = 2

export interface Spread {
    distance: number
    origin: [number, number]
}

/**
 * Two fingers from taking hold to lifting. Each move is noted, and {@link take} gives what they add up
 * to since the last one, so that a frame's worth of moves is one change to the page. The zoom is
 * measured from where the fingers took hold, never step by step: each step rounded would drift.
 */
export class Pinch {
    /** The distance a zoom is measured from, once the fingers have moved apart or together enough to mean one. */
    private from: number | null = null
    private readonly started: number
    private taken: [number, number]
    private latest: Spread
    private moved = false

    constructor(start: Spread) {
        this.started = start.distance
        this.taken = start.origin
        this.latest = start
    }

    move(spread: Spread): void {
        this.latest = spread
        this.moved = true
        // From here, not from where they took hold, so the page does not jump by the slop.
        if (this.from === null && Math.abs(spread.distance - this.started) >= MIN_CHANGE_PX && spread.distance > 0) this.from = spread.distance
    }

    /** What the moves since the last take add up to, or null when there were none. */
    take(): PinchChange | null {
        if (!this.moved) return null
        this.moved = false
        const { origin, distance } = this.latest
        const pan: [number, number] = [origin[0] - this.taken[0], origin[1] - this.taken[1]]
        this.taken = origin
        return { origin, pan, zoom: this.from === null ? 1 : distance / this.from }
    }
}

function spreadOf(touches: TouchList): Spread {
    const [a, b] = [touches[0], touches[1]]
    return {
        distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        origin: [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2],
    }
}

export function listenForPinch(element: HTMLElement, handlers: PinchHandlers, signal: AbortSignal): void {
    let pinch: Pinch | null = null
    let frame: number | null = null
    const options = { passive: false, signal }
    const tell = () => {
        frame = null
        const change = pinch?.take()
        if (change) handlers.onMove(change)
    }
    const drop = () => {
        if (frame !== null) cancelAnimationFrame(frame)
        frame = null
        pinch = null
    }
    element.addEventListener(
        'touchstart',
        (event) => {
            if (event.touches.length !== 2) return
            event.preventDefault()
            pinch = new Pinch(spreadOf(event.touches))
            handlers.onStart()
        },
        options,
    )
    element.addEventListener(
        'touchmove',
        (event) => {
            if (!pinch || event.touches.length !== 2) return
            event.preventDefault()
            pinch.move(spreadOf(event.touches))
            // A screen can report several moves for each frame it draws, and each change lays out every page.
            frame ??= requestAnimationFrame(tell)
        },
        options,
    )
    const finish = (event: TouchEvent) => {
        if (!pinch || event.touches.length >= 2) return
        // The last moves, whose frame has not come: where the fingers lifted is where the page stays.
        tell()
        drop()
        handlers.onEnd()
    }
    element.addEventListener('touchend', finish, { signal })
    element.addEventListener('touchcancel', finish, { signal })
    signal.addEventListener('abort', drop)
}
