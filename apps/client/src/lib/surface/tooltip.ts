/**
 * The Client's tooltips: the words of a control that shows only an icon, drawn in the theme's
 * menu colours rather than the browser's own `title` box, and shown on a touch screen too.
 *
 * A control opts in with `data-tooltip="Words"` (Style Guide, "Icons"). It keeps its `aria-label`
 * for a screen reader, and has no `title`, which would draw the browser's box as well.
 *
 * When one shows:
 *
 * - **Mouse, or a pen held over the screen:** after a short wait on the control, and at once when
 *   moving along a row of them. It goes when the pointer leaves or presses.
 * - **Finger, or a pen tap:** at once on the tap, for a moment ({@link BRIEF_MS}), so a person who
 *   cannot hover still learns what they just pressed.
 * - **Keyboard:** at once on a control reached with Tab, until the focus moves on.
 *
 * This file holds the rules, framework-free so they are tested in Node (`tooltip.test.ts`,
 * `tooltip.property.test.ts`). `ui/TooltipHost.svelte` turns the document's events into these
 * calls and draws the one tooltip.
 */

import { MENU_MARGIN, type MenuAnchor, type VisibleArea } from './menu-placement'

/** How long the pointer rests on a control before its tooltip shows. */
export const HOVER_DELAY_MS = 500
/** After a tooltip goes as the pointer leaves, how long the next control's shows without the wait. */
export const WARM_MS = 300
/** How long a tooltip shown for a tap stays. */
export const BRIEF_MS = 1500
/** The space between a tooltip and its control. */
export const TOOLTIP_GAP = 6

export type PointerKind = 'mouse' | 'pen' | 'touch'
/** `hover` for a resting pointer, `focus` for the keyboard, `brief` for a tap. */
export type TooltipMode = 'hover' | 'focus' | 'brief'

/** The timers the controller uses; the browser's, or a test's. */
export interface TooltipClock {
    now(): number
    set(fn: () => void, ms: number): unknown
    clear(handle: unknown): void
}

export const browserClock: TooltipClock = {
    now: () => performance.now(),
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * When a tooltip shows and when it goes, for targets of any type (an element in the browser, a
 * name in a test). It calls `show` and `hide` in turn, never two shows without a hide between.
 */
export class TooltipController<T> {
    #shown: { target: T; mode: TooltipMode } | null = null
    /** A hover waiting out its delay. */
    #waiting: { target: T; handle: unknown } | null = null
    /** The brief tooltip's end. */
    #ending: unknown = null
    /** When a hover tooltip last went as the pointer left, for the warm spell. */
    #leftAt = -Infinity

    constructor(
        private readonly out: { show(target: T, mode: TooltipMode): void; hide(): void },
        private readonly clock: TooltipClock = browserClock,
    ) {}

    /** The tooltip showing now, if any. */
    get current(): { target: T; mode: TooltipMode } | null {
        return this.#shown
    }

    /** The pointer came over a control. A finger passing over is not a hover. */
    enter(target: T, kind: PointerKind): void {
        if (kind === 'touch') return
        if (this.#shown?.target === target) return
        this.#cancelWaiting()
        const warm = this.#shown?.mode === 'hover' || this.clock.now() - this.#leftAt < WARM_MS
        if (warm) {
            this.#show(target, 'hover')
            return
        }
        const handle = this.clock.set(() => {
            this.#waiting = null
            this.#show(target, 'hover')
        }, HOVER_DELAY_MS)
        this.#waiting = { target, handle }
    }

    /** The pointer left a control. A tap's tooltip stays its moment; a lifted finger fires this too. */
    leave(target: T): void {
        if (this.#waiting?.target === target) this.#cancelWaiting()
        if (this.#shown?.target === target && this.#shown.mode === 'hover') {
            this.#hide()
            this.#leftAt = this.clock.now()
        }
    }

    /** A press anywhere: it answers the question the tooltip would, so the tooltip goes. */
    press(_kind: PointerKind): void {
        this.#cancelWaiting()
        if (this.#shown) this.#hide()
    }

    /** A press released on the control it began on. A mouse click shows nothing; a tap shows the words for a moment. */
    tap(target: T, kind: PointerKind): void {
        if (kind === 'mouse') return
        this.#cancelWaiting()
        this.#show(target, 'brief')
        this.#ending = this.clock.set(() => {
            this.#ending = null
            if (this.#shown?.target === target && this.#shown.mode === 'brief') this.#hide()
        }, BRIEF_MS)
    }

    /** A control reached with the keyboard. */
    focus(target: T): void {
        this.#cancelWaiting()
        this.#show(target, 'focus')
    }

    /** The focus left a control. */
    blur(target: T): void {
        if (this.#shown?.target === target && this.#shown.mode === 'focus') this.#hide()
    }

    /** Escape, a scroll, the window losing focus, the control going: put everything away. */
    dismiss(): void {
        this.#cancelWaiting()
        if (this.#shown) this.#hide()
    }

    #show(target: T, mode: TooltipMode): void {
        if (this.#shown) this.#hide()
        this.#shown = { target, mode }
        this.out.show(target, mode)
    }

    #hide(): void {
        if (this.#ending !== null) {
            this.clock.clear(this.#ending)
            this.#ending = null
        }
        this.#shown = null
        this.out.hide()
    }

    #cancelWaiting(): void {
        if (!this.#waiting) return
        this.clock.clear(this.#waiting.handle)
        this.#waiting = null
    }
}

/**
 * Where a tooltip of `size` goes for a control at `anchor`: centred on it, on the side asked for
 * when that side has room (below for a mouse, above for a finger, which would cover it below),
 * otherwise the other side, otherwise whichever has more room. Always inside the visible area.
 */
export function placeTooltip(
    anchor: MenuAnchor,
    size: { width: number; height: number },
    area: VisibleArea,
    prefer: 'above' | 'below',
): { x: number; y: number; side: 'above' | 'below' } {
    const minX = area.left + MENU_MARGIN
    const maxX = area.left + area.width - MENU_MARGIN - size.width
    const minY = area.top + MENU_MARGIN
    const maxY = area.top + area.height - MENU_MARGIN - size.height
    const spaceAbove = anchor.top - TOOLTIP_GAP - minY
    const spaceBelow = maxY + size.height - (anchor.bottom + TOOLTIP_GAP)
    const fits = { above: spaceAbove >= size.height, below: spaceBelow >= size.height }
    const other = prefer === 'above' ? 'below' : 'above'
    const side = fits[prefer] ? prefer : fits[other] ? other : spaceAbove > spaceBelow ? 'above' : 'below'
    const y = side === 'above' ? anchor.top - TOOLTIP_GAP - size.height : anchor.bottom + TOOLTIP_GAP
    const x = (anchor.left + anchor.right) / 2 - size.width / 2
    return { x: Math.round(clamp(x, minX, maxX)), y: Math.round(clamp(y, minY, maxY)), side }
}

/** `min` wins when the range is empty, so a tooltip wider than the area starts at its left margin. */
function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(value, max))
}
