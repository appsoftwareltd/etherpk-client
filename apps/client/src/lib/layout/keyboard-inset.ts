/**
 * How much of the screen a phone's soft keyboard covers. The keyboard overlays the layout viewport
 * and does not shrink it (Android Chrome since 108, iOS Safari), so only the visual viewport tells.
 * Something pinned to the bottom of the window takes this much off its height to end above the keyboard.
 */
export function watchKeyboardInset(onChange: (inset: number) => void): () => void {
    const viewport = window.visualViewport
    if (!viewport) return () => {}
    const update = () => onChange(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop))
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
        viewport.removeEventListener('resize', update)
        viewport.removeEventListener('scroll', update)
    }
}
