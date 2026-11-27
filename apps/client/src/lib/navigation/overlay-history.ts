/**
 * The history entry of a [[Dismissable Overlay]] (CONTEXT.md; ADR 0023, amended 2026-11-27).
 *
 * A page cannot stop the browser's Back. It can only put an entry of its own in front and notice
 * when Back takes it away. So while an overlay that Back closes is on top of the dialog stack, one
 * entry with the address and state of the entry under it, and a marker of its own, sits in front:
 *
 * - **Back takes the marked entry away**, and the overlay on top is dismissed, as Escape would.
 *   When an overlay is still on top after that (one under it, or one that refused to close), a new
 *   entry goes in front for the next Back. The page under the overlays never moves.
 * - **Closed any other way** (Escape, its close button, a result chosen), the overlay's entry is
 *   taken back with `history.back()`, so Back and Forward walk the Visits as if it never opened.
 *   The page does not take that step back for a Back of the person's own: a page opened as the
 *   overlay closed (a task opened in a tab, a result chosen in Search) stays, and its Visit is
 *   written over the entry under it.
 *   A Visit pushed while the entry is in front replaces it instead (the workspace's `pushUrl`): a
 *   phone's drawer closes only after the page chosen in it has opened.
 * - **The page in front replaced while the entry is in front** (the last page closed by a delete
 *   confirmed in a dialog) keeps the marker until the overlay closes. Going back then would show
 *   the page as it was before, so the entry stays where it is and loses its marker instead.
 * - **A load of another document begun** (a sign-in page opened from a dialog) is never followed by
 *   a move through history, which would cancel it.
 * - **An entry left behind** is one whose overlay closed while the entry was not in front, and
 *   one Back took away, reached again by Forward. Reached by Back or Forward, it is passed over
 *   with `history.back()`, so Forward does nothing and Back goes on to the Visit before it.
 *
 * Every write is queued after the history writes before it (`history-writes.ts`), and each one
 * checks when it runs that it is still wanted: an overlay can open and close again before its
 * entry was written. This module touches no browser API; `+layout.svelte` supplies them.
 */

/** The overlay on top of the stack, as far as Back is concerned. */
export interface OverlayOnTop {
    /** Dismiss it, as Escape would. Absent on one Back does not close (Settings). */
    readonly dismiss?: () => void
}

export interface OverlayHistoryDeps {
    /** The overlay on top of the dialog stack, or null when none is open. */
    top(): OverlayOnTop | null
    /** The marker on the history entry in front, or undefined when it is not an overlay's entry. */
    marker(): string | undefined
    /** The entry in front, address and state, leaving out its marker: equal for two equal entries. */
    snapshot(): string
    /** Push an entry with the address and state of the one in front, marked `token`. */
    push(token: string): Promise<unknown> | unknown
    /** Go back one entry, settled once the entry in front has changed. */
    back(): Promise<unknown> | unknown
    /**
     * Go back over an overlay's own entry that its closing left in front, settled as `back`. The
     * page does not show the entry it lands on, which shows what the page showed under the overlay:
     * the page may have moved on since, with its own entry still to be written.
     */
    dropEntry(): Promise<unknown> | unknown
    /** Replace the entry in front with the same address and state, and no marker. */
    unmark(): Promise<unknown> | unknown
    /** Run a history write once the writes queued before it have finished. */
    queue(write: () => unknown): Promise<void>
    /** A marker no entry has carried before. */
    newToken(): string
}

export interface OverlayHistory {
    /** The dialog stack changed: put an entry in front, or take it away, to match. */
    reconcile(): void
    /**
     * The entry in front changed. `traversal` says Back or Forward moved it, rather than a write
     * of the page's own.
     */
    entryChanged(traversal: boolean): void
    /**
     * A load of another document has begun. No history write after this moves through history:
     * one would cancel the load. Lasts until an overlay opens again, which shows the page stayed.
     */
    leave(): void
}

export function createOverlayHistory(deps: OverlayHistoryDeps): OverlayHistory {
    /** The marker of the entry this module put in front for the overlays open now, or null. */
    let armed: string | null = null
    /**
     * Whether that entry has been written. Until it has, a change in front is not its going: Back
     * can close Settings, whose closing lets a drawer under it ask for an entry, and the Back that
     * did so is then reported after the drawer's entry was asked for and before it was written.
     */
    let landed = false
    /** The entry the armed one was pushed over, as `snapshot` gave it, once it has been written. */
    let pushedOver: string | null = null
    /** A load of another document has begun (`leave`). */
    let leaving = false

    const wanted = () => deps.top()?.dismiss !== undefined

    function reconcile(): void {
        if (wanted() && armed === null) {
            const token = deps.newToken()
            armed = token
            landed = false
            pushedOver = null
            // An overlay opening shows the page is still here: a load it began was cancelled.
            leaving = false
            void deps.queue(async () => {
                // Closed again before its entry was written: there is nothing to hold.
                if (armed !== token) return
                const under = deps.snapshot()
                await deps.push(token)
                if (armed === token) {
                    landed = true
                    pushedOver = under
                }
            })
        } else if (!wanted() && armed !== null) {
            const token = armed
            const under = pushedOver
            armed = null
            // Only while the entry is still in front: a Visit may have replaced it, or Back taken it.
            void deps.queue(() => {
                if (leaving || deps.marker() !== token) return undefined
                // Replaced since it was pushed: the entry under it shows the page as it was before.
                return deps.snapshot() === under ? deps.dropEntry() : deps.unmark()
            })
        }
    }

    /** The entry this module put in front has gone from the front: by Back, or replaced by a write. */
    function entryLeft(traversal: boolean): void {
        // Pushing it cleared the Forward entries, so a traversal that takes it away is Back, and
        // Back closes the overlay on top. A write of the page's own (a Visit) replaced it instead,
        // and the overlays stay as they are. Back pressed in the few milliseconds before the entry
        // is written is the browser's alone: there is no entry yet for it to take.
        armed = null
        if (traversal) deps.top()?.dismiss?.()
    }

    function entryChanged(traversal: boolean): void {
        const marker = deps.marker()
        if (armed !== null && marker === armed) return
        if (armed !== null && landed) entryLeft(traversal)
        // Back or Forward reached an entry left behind. Its own overlay has closed, so it is
        // passed over, unless an overlay's new entry has been written over it by then.
        if (traversal && marker !== undefined && marker !== armed) {
            void deps.queue(() => (!leaving && deps.marker() === marker ? deps.back() : undefined))
        }
        reconcile()
    }

    function leave(): void {
        leaving = true
    }

    return { reconcile, entryChanged, leave }
}

/**
 * Whether a Visit about to be written replaces the entry in front rather than going over it: it
 * does when that entry is an overlay's, so the page opened from a drawer or a dialog is not left
 * with an overlay's entry under it.
 */
export function visitReplacesFront(marker: string | undefined): boolean {
    return marker !== undefined
}
