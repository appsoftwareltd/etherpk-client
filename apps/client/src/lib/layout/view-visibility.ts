/**
 * Whether a [[View]] is on screen, for a View that must do no work while it is not.
 *
 * The desktop presenter keeps every tab mounted (`defaultRenderer: 'always'` in the dockview
 * adapter) so a tab switch never loses an editor's state. The cost of that is that a mounted View
 * cannot tell from its own lifecycle whether anyone can see it. Three things decide it, and all
 * three must hold:
 *
 * - **tab**: the View's tab is in front in its Pane. dockview reports this per panel, and hides a
 *   background tab with `visibility: hidden`, which no size or intersection check can see.
 * - **size**: the View's box has a width and a height. A collapsed Sidebar is pinned to width 0
 *   rather than hidden, so dockview still calls its front tab visible.
 * - **page**: the browser tab is visible (`document.visibilityState`).
 *
 * Plain TypeScript rather than runes, so it is Node-tested and either presenter can drive it. A
 * Svelte View reads it through `createSubscriber` (svelte/reactivity).
 */

export type VisibilityCondition = 'tab' | 'size' | 'page'

/** What a View reads. */
export interface ViewVisibility {
    readonly onScreen: boolean
    /** Called with the new value each time `onScreen` changes, never for a repeat. */
    subscribe(listener: (onScreen: boolean) => void): () => void
}

/** What a presenter drives. */
export interface ViewVisibilityControl extends ViewVisibility {
    set(condition: VisibilityCondition, holds: boolean): void
}

export function createViewVisibility(initial: Partial<Record<VisibilityCondition, boolean>> = {}): ViewVisibilityControl {
    const conditions: Record<VisibilityCondition, boolean> = { tab: true, size: true, page: true, ...initial }
    const listeners = new Set<(onScreen: boolean) => void>()
    const compute = () => conditions.tab && conditions.size && conditions.page
    let onScreen = compute()
    return {
        get onScreen() {
            return onScreen
        },
        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        set(condition, holds) {
            conditions[condition] = holds
            const next = compute()
            if (next === onScreen) return
            onScreen = next
            for (const listener of [...listeners]) listener(next)
        },
    }
}

/** Follow the browser tab's visibility into `visibility` until the returned stop is called. */
export function watchPageVisibility(
    visibility: ViewVisibilityControl,
    page: EventTarget & { readonly visibilityState: DocumentVisibilityState } = document,
): () => void {
    const update = () => visibility.set('page', page.visibilityState === 'visible')
    update()
    page.addEventListener('visibilitychange', update)
    return () => page.removeEventListener('visibilitychange', update)
}

/**
 * Follow whether `element` has a box. A Sidebar collapsing pins its Pane to width 0, which this
 * sees as the View's own box shrinking to nothing. ResizeObserver reports a rendered element's
 * box once as soon as it is observed, so a caller may start the condition false and let that
 * first report settle it. Where `ResizeObserver` is missing the condition is set holding, so a
 * View there behaves as one without the check.
 */
export function watchViewSize(
    visibility: ViewVisibilityControl,
    element: Element,
    Observer: typeof ResizeObserver | undefined = globalThis.ResizeObserver,
): () => void {
    if (!Observer) {
        visibility.set('size', true)
        return () => {}
    }
    const observer = new Observer((entries) => {
        const box = entries[entries.length - 1]?.contentRect
        if (box) visibility.set('size', box.width > 0 && box.height > 0)
    })
    observer.observe(element)
    return () => observer.disconnect()
}
