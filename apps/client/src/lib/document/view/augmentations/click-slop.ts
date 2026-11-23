/**
 * How far the pointer may wander between a press and its release and still be a click.
 *
 * A press that reveals a line's hidden syntax moves the text under the pointer, so a pointer
 * gesture that follows the pointer from the press would select from where the press landed to
 * wherever the reflow put the text. The gestures that start with such a press (beside a rendered
 * link, on an image's line) stay a click until the pointer has moved this far.
 */

/** In px, on either axis. */
export const CLICK_SLOP = 4

/** Whether the pointer at `event` is still within a click's reach of the press at `start`. */
export function withinClickSlop(start: MouseEvent, event: MouseEvent): boolean {
    return Math.max(Math.abs(event.clientX - start.clientX), Math.abs(event.clientY - start.clientY)) < CLICK_SLOP
}
