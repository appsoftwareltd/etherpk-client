/**
 * The [[Graph View]]'s hold on its extension context, and the one request its Commands hand to
 * a View that may not be mounted yet.
 *
 * Each View is mounted as a separate Svelte root, with no context to inherit, so it reads what the
 * extension was started with from here. The context is set as the extension starts in a graph and
 * cleared as it stops, so a View left over from a closing graph finds nothing rather than the next
 * graph's index.
 */
import type { ExtensionContext } from '@appsoftwareltd/etherpk-extension-api'

let current: ExtensionContext | null = null

export function setGraphViewContext(context: ExtensionContext | null): void {
    current = context
}

/** The open graph's context, or null between graphs. */
export function graphViewContext(): ExtensionContext | null {
    return current
}

// "Show in Graph View" names a concept for the whole graph to centre on. The whole graph may be
// mounted already, in which case it hears the request, or about to mount, in which case it takes
// the request as it starts.
let pendingFocus: string | null = null
const focusListeners = new Set<(concept: string) => void>()

/** Ask the whole graph to centre on `concept`. */
export function requestWholeGraphFocus(concept: string): void {
    if (focusListeners.size === 0) {
        pendingFocus = concept
        return
    }
    for (const listener of [...focusListeners]) listener(concept)
}

/** Forget a request no whole graph took, as the graph that made it closes. */
export function clearWholeGraphFocus(): void {
    pendingFocus = null
}

/** Hear focus requests, starting with one made before the listener existed. Returns the unsubscribe. */
export function onWholeGraphFocus(listener: (concept: string) => void): () => void {
    focusListeners.add(listener)
    if (pendingFocus !== null) {
        const concept = pendingFocus
        pendingFocus = null
        listener(concept)
    }
    return () => focusListeners.delete(listener)
}
