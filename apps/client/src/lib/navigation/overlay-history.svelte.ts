/**
 * `overlay-history.ts` wired to the browser: the shared dialog stack, SvelteKit's shallow entries
 * and the Client's queue of history writes. Called once, from the root layout, so Back closes the
 * overlay on top on every page of the Client: a graph, a Plain Folder, the Graphs page.
 */
import { beforeNavigate, goto } from '$app/navigation'
import { page } from '$app/state'
import { untrack } from 'svelte'
import { dialogStack } from '@appsoftwareltd/etherpk-shared/ui'

import { queueHistoryWrite } from './history-writes'
import { createOverlayHistory } from './overlay-history'

/** Back one history entry, settled once SvelteKit has put that entry's state in `page.state`. */
export async function goBackSettled(): Promise<void> {
    const before = page.state
    await new Promise<void>((resolve) => {
        addEventListener('popstate', () => resolve(), { once: true })
        history.back()
    })
    // For a shallow entry SvelteKit replaces page.state after it has resolved the route, a
    // little after the popstate event. Wait for that, for half a second at most.
    for (let waited = 0; waited < 500 && page.state === before; waited += 10) {
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}

/**
 * The history entry an overlay's `dropEntry` landed on, as the browser holds it, until that step
 * has settled. Only that entry is passed over: a Back of the person's own pressed in the same
 * moment lands on another entry, and the page follows it.
 */
let droppedOnto: string | null = null

/**
 * Whether the entry in front changed because an overlay that closed took its own entry away. The
 * page does not show that entry's Visit: it shows what the page showed under the overlay, and the
 * page may have moved on since, with its own Visit still to be written (a task opened in a tab
 * as the Task Editor closed).
 */
export function droppingOverlayEntry(): boolean {
    return droppedOnto !== null && droppedOnto === JSON.stringify(history.state)
}

/** The state of an entry without an overlay's marker. */
function withoutMarker(state: App.PageState): App.PageState {
    const { etherpkOverlay: _marker, ...rest } = state
    return rest
}

/** JSON with every object's keys in order, so two entries written in another order compare equal. */
function sortedJson(value: unknown): string {
    return JSON.stringify(value, (_key, inner: unknown) =>
        inner && typeof inner === 'object' && !Array.isArray(inner)
            ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
            : inner,
    )
}

/** Put an overlay's entry in front while one Back closes is open. Call during component setup. */
export function watchOverlayHistory(): void {
    let issued = 0
    const overlays = createOverlayHistory({
        top: () => dialogStack.top(),
        // An entry the browser made itself, for a change of fragment, holds no state: it is no
        // overlay's, though `page.state` still shows the entry before it until the page writes one.
        marker: () => (history.state === null ? undefined : page.state.etherpkOverlay),
        snapshot: () => sortedJson([location.pathname + location.search + location.hash, withoutMarker(page.state)]),
        // The entry in front again, address and state, with the marker: the page under the
        // overlay is the same page whichever of the two entries is in front.
        push: (token) =>
            goto(location.pathname + location.search + location.hash, {
                shallow: true,
                state: { ...page.state, etherpkOverlay: token },
            }),
        back: goBackSettled,
        async dropEntry() {
            // Set on the popstate event, before SvelteKit puts the entry's state in page.state.
            const land = () => {
                droppedOnto = JSON.stringify(history.state)
            }
            addEventListener('popstate', land, { once: true })
            try {
                await goBackSettled()
            } finally {
                removeEventListener('popstate', land)
                droppedOnto = null
            }
        },
        unmark: () =>
            goto(location.pathname + location.search + location.hash, {
                shallow: true,
                replace: true,
                state: withoutMarker(page.state),
            }),
        queue: queueHistoryWrite,
        // Not randomUUID, which a page served over plain HTTP to another device does not have.
        newToken: () => `${Date.now().toString(36)}-${++issued}`,
    })

    /**
     * The history entry a Back or Forward landed on, as the browser holds it, until the change of
     * `page.state` it brings is seen. SvelteKit reports no navigation for a traversal between two
     * shallow entries; it only replaces `page.state`. A traversal it ignores changes nothing, and
     * the page's next write replaces the entry, so a change seen once the entry in front is another
     * is the page's own.
     */
    let landedOn: string | null = null

    // A load of another document (a sign-in page opened from a dialog, a link that reloads) is
    // cancelled by any move through history after it begins, so none follows it.
    beforeNavigate(({ willUnload }) => {
        if (willUnload) overlays.leave()
    })

    $effect(() => {
        const onPopstate = () => {
            landedOn = JSON.stringify(history.state)
        }
        addEventListener('popstate', onPopstate)
        const stop = dialogStack.subscribe(() => overlays.reconcile())
        // An overlay already open as the page mounted (a phone's drawer in a restored Layout).
        overlays.reconcile()
        return () => {
            stop()
            removeEventListener('popstate', onPopstate)
        }
    })

    $effect(() => {
        void page.state
        untrack(() => {
            const traversal = landedOn !== null && landedOn === JSON.stringify(history.state)
            landedOn = null
            overlays.entryChanged(traversal)
        })
    })
}
