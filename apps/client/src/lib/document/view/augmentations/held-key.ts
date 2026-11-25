/**
 * A key that moved the keyboard somewhere else while it was held down: Enter on a picture or on an
 * action button, which leaves the keyboard in the text. Its repeats would be typed there, so they are
 * dropped until the key comes up.
 */
export function ignoreHeldKey(page: Document, pressed: Pick<KeyboardEvent, 'key'>): void {
    const drop = (event: KeyboardEvent) => {
        // Another press is the person's own, of this key or any other.
        if (!event.repeat) return stop()
        if (event.key !== pressed.key) return
        event.preventDefault()
        event.stopImmediatePropagation()
    }
    const stop = () => {
        page.removeEventListener('keydown', drop, true)
        page.removeEventListener('keyup', stop, true)
    }
    page.addEventListener('keydown', drop, true)
    page.addEventListener('keyup', stop, true)
}
