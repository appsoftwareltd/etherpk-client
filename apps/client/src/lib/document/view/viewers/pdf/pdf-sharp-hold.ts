/**
 * Zoomed in far enough, pdf.js draws a page small and the part in view again at full size over it. It
 * draws that part again whenever the view moves a little off it, which on a tablet is a canvas of five
 * million pixels every few frames of a scroll. On an iPad each one ended the glide after a flick within
 * a tenth of a second, and a drag that began as one arrived stopped after its first step.
 *
 * So the sharp part is left as it is while a finger is on the PDF or the page is moving, and drawn once
 * when both have stopped. Until then what was not under it shows at the page's own, softer, size.
 */

/** How long the page has to have been still. pdf.js itself waits 100 ms after a scroll. */
export const REST_MS = 120
/** A page moving slower than this is still: a glide ends in seconds of a crawl nobody sees. */
export const SLOW_PX_PER_MS = 0.1

export interface SharpClock {
    now(): number
    setTimer(run: () => void, ms: number): unknown
    clearTimer(timer: unknown): void
}

/** When the sharp part may be drawn: `held` while it may not, and `onRest` called once it may again. */
export class SharpRest {
    private fingers = 0
    private moving = false
    private timer: unknown
    private waiting = false
    private last: { x: number; y: number; at: number } | null = null

    constructor(
        private readonly clock: SharpClock,
        private readonly onRest: () => void,
    ) {}

    get held(): boolean {
        return this.fingers > 0 || this.moving
    }

    /** The page is at a new place. */
    scrolled(x: number, y: number): void {
        const at = this.clock.now()
        const fast = !this.last || (Math.abs(x - this.last.x) + Math.abs(y - this.last.y)) / Math.max(1, at - this.last.at) > SLOW_PX_PER_MS
        this.last = { x, y, at }
        this.moving = true
        // A crawl does not put the rest off, or the sharp part would wait seconds for a page that looks still.
        if (fast || !this.waiting) this.wait()
    }

    /** How many fingers are on the PDF now. */
    touched(fingers: number): void {
        this.fingers = fingers
        if (fingers === 0 && !this.waiting) this.wait()
    }

    stop(): void {
        this.clock.clearTimer(this.timer)
        this.waiting = false
    }

    private wait(): void {
        this.clock.clearTimer(this.timer)
        this.waiting = true
        this.timer = this.clock.setTimer(() => {
            this.waiting = false
            this.moving = false
            // Under a finger it waits for the lift, which starts this again.
            if (this.fingers === 0) this.onRest()
        }, REST_MS)
    }
}

/** A pdf.js page, as far as this needs it. */
export interface SharpPage {
    updateVisibleArea(visibleArea: unknown): void
}

export interface SharpHold {
    /** Hold this page's sharp part while the PDF moves. Each page a viewer makes is given to this once. */
    hold(page: SharpPage): void
    /** Draw the sharp part now, whatever is moving: the zoom changed, and what is drawn is of the old one. */
    drawNow(): void
}

export function holdSharpPartWhileMoving(container: HTMLElement, viewer: { update(): void }, signal: AbortSignal): SharpHold {
    let through = false
    const drawNow = () => {
        through = true
        try {
            viewer.update()
        } finally {
            through = false
        }
    }
    const rest = new SharpRest({ now: () => performance.now(), setTimer: (run, ms) => setTimeout(run, ms), clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) }, drawNow)
    const options = { passive: true, signal }
    container.addEventListener('scroll', () => rest.scrolled(container.scrollLeft, container.scrollTop), options)
    // Ahead of the reader's own listeners, which may draw at the end of a pinch.
    for (const type of ['touchstart', 'touchend', 'touchcancel'] as const) container.addEventListener(type, (event) => rest.touched(event.touches.length), { ...options, capture: true })
    signal.addEventListener('abort', () => rest.stop())

    return {
        hold(page) {
            const update = page.updateVisibleArea.bind(page)
            // With no area the page has left the view and its sharp part is let go, which is never held.
            page.updateVisibleArea = (visibleArea) => {
                if (visibleArea && !through && rest.held) return
                update(visibleArea)
            }
        },
        drawNow,
    }
}
