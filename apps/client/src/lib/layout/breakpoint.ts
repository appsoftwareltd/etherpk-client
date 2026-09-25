/**
 * The single source of truth for the viewport width at which the Layout swaps
 * presenters: dockview (desktop) at or above it, the single-active-View mobile
 * presenter below it. There is no Tailwind config to anchor this, so it lives
 * here and is consumed by both the workspace's `matchMedia` query and any CSS
 * that needs the same value.
 *
 * 1024px is the documented `lg` breakpoint (ADR 0005): below it, dockview with
 * two sidebars is too cramped to be usable.
 */
export const LAYOUT_BREAKPOINT_PX = 1024

/** The media query that is true on the desktop (dockview) side of the breakpoint. */
export const DESKTOP_MEDIA_QUERY = `(min-width: ${LAYOUT_BREAKPOINT_PX}px)`

/**
 * Whether the current viewport wants the mobile presenter. Guarded for SSR /
 * environments without `matchMedia` (treated as desktop — dockview is the
 * default and the workspace only mounts in the browser anyway).
 */
export function prefersMobileLayout(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return !window.matchMedia(DESKTOP_MEDIA_QUERY).matches
}

/**
 * Subscribe to breakpoint crossings. Invokes `onChange(isMobile)` whenever the
 * viewport crosses {@link LAYOUT_BREAKPOINT_PX}, debounced so a drag that
 * overshoots the boundary and returns does not swap twice. Returns an unsubscribe.
 * No-op (returns a no-op) when `matchMedia` is unavailable.
 */
export function watchMobileLayout(onChange: (isMobile: boolean) => void, debounceMs = 200): () => void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
    const mql = window.matchMedia(DESKTOP_MEDIA_QUERY)
    let timer: ReturnType<typeof setTimeout> | undefined
    const handler = () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => onChange(!mql.matches), debounceMs)
    }
    mql.addEventListener('change', handler)
    return () => {
        if (timer) clearTimeout(timer)
        mql.removeEventListener('change', handler)
    }
}
