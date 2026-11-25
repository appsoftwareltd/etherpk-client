/**
 * A picture's controls and a double click on it.
 *
 * The click that selects a picture raises its actions and its resize handle, perhaps right under the
 * pointer. A double click there is Edit as text, as it is anywhere on the picture, so its second
 * press must land on the picture: on a control it would open the delete dialog, or take the size hint
 * away. The controls let the pointer through until the press is over with, which is when the pointer
 * moves off the place (nobody reaches a control without moving) or a double click can no longer come.
 */

import { withinClickSlop } from './click-slop'

/** The box's class while its controls let the pointer through. */
const PRESSED = 'cm-md-image--pressed'

/** The longest double click a system can be set to take (Windows' slowest). */
const DOUBLE_CLICK_MS = 900

/** What ends the hold on each box's controls, while there is one. */
const held = new WeakMap<HTMLElement, () => void>()

/** Keep the controls in `wrap` from the pointer until the press at `press` cannot start a double click there. */
export function holdControlsThroughDoubleClick(wrap: HTMLElement, press: MouseEvent): void {
    held.get(wrap)?.()
    const page = wrap.ownerDocument
    wrap.classList.add(PRESSED)
    const release = () => {
        clearTimeout(timer)
        page.removeEventListener('pointermove', moved, true)
        wrap.classList.remove(PRESSED)
        held.delete(wrap)
    }
    const moved = (event: MouseEvent) => {
        if (!withinClickSlop(press, event)) release()
    }
    const timer = setTimeout(release, DOUBLE_CLICK_MS)
    page.addEventListener('pointermove', moved, true)
    held.set(wrap, release)
}
