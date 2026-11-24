/**
 * The part of the window a phone's soft keyboard leaves on the screen.
 *
 * Where the browser can, the keyboard resizes the page itself (`interactive-widget=resizes-content`
 * in app.html: Chrome and Firefox on Android). The window is then as tall as what the keyboard
 * leaves, everything pinned to it follows, and this reports nothing covered.
 *
 * Elsewhere (Safari on iOS) the keyboard lies over a window that keeps its height, and only the
 * visual viewport tells. It gets shorter, and the browser may also move the page up under it to
 * show the caret, which carries the top of the window off the screen. So there are two numbers:
 * how much of the window's foot is covered, and how far down the window the screen now starts.
 * Something that fills the window takes both off, and ends up filling the screen.
 */

/** What is off the screen at each end of the window, in px. */
export interface VisibleWindow {
    /** How far below the window's top the screen starts: the browser moved the page up by this much. */
    top: number
    /** How much of the window's foot the keyboard covers. */
    bottom: number
}

/** The numbers of `window.visualViewport` this reads. */
interface Viewport {
    height: number
    offsetTop: number
    scale: number
}

/** A pinch has zoomed the page when the scale is further from 1 than a browser's rounding. */
const ZOOMED = 0.01

/**
 * What is off the screen at each end of a window `windowHeight` tall, given its visual viewport.
 * Nothing while the page is zoomed: a pinch shows part of the page too, and a workspace that
 * followed it would lay itself out again inside whatever the person zoomed in on.
 */
export function visibleWindow(windowHeight: number, viewport: Viewport): VisibleWindow {
    if (Math.abs(viewport.scale - 1) > ZOOMED) return { top: 0, bottom: 0 }
    const top = Math.max(0, viewport.offsetTop)
    // Less than a px is a browser's bars on the move, not a keyboard.
    const bottom = windowHeight - viewport.height - top
    return { top, bottom: bottom < 1 ? 0 : bottom }
}

/**
 * Follow the part of the window on the screen: `onChange` is called now and whenever it changes,
 * with how much of the window's foot the keyboard covers and how far down the window the screen
 * starts. Returns what stops it.
 */
export function watchKeyboardInset(onChange: (inset: number, top: number) => void): () => void {
    const viewport = window.visualViewport
    if (!viewport) return () => {}
    const update = () => {
        const { top, bottom } = visibleWindow(window.innerHeight, viewport)
        onChange(bottom, top)
    }
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
        viewport.removeEventListener('resize', update)
        viewport.removeEventListener('scroll', update)
    }
}
