/**
 * A browser history in memory, with the overlay entry logic of `../overlay-history.ts` wired to it
 * as `+layout.svelte` wires it to the real one, for the unit and property tests. An entry is the
 * Visit it shows and, for an overlay's entry, its marker.
 *
 * The page is modelled as well as its history: `shown` is the Visit the workspace shows. A Visit
 * or a replace shows at once and writes its entry later, through the queue, as the workspace's
 * `pushUrl` and `replaceUrl` do. Back or Forward shows the Visit of the entry it lands on, as the
 * workspace's effect on `page.state` does, except where an overlay takes its own entry away.
 */
import type { DialogStack } from '@appsoftwareltd/etherpk-shared/ui'

import { createOverlayHistory, visitReplacesFront } from '../overlay-history'

export interface FakeEntry {
    visit: string
    overlay: boolean
    token?: string
    /** Settings open on this entry, by which opening of it. */
    settings?: number
}

export interface FakeOverlay {
    isOpen(): boolean
    /** Close it by Escape, its close button or a choice made in it. */
    closeOtherWay(): void
}

export function createFakeHistory(stack: DialogStack) {
    let entries: FakeEntry[] = [{ visit: 'start', overlay: false }]
    let index = 0
    let tokens = 0
    let pending: Promise<unknown> = Promise.resolve()
    let writes = 0
    const open = new Set<FakeOverlay>()
    /** Settings, which follows the entry in front as the workspace's effect makes it. */
    let settings: { id: number; place: { close(): void } } | null = null
    let settingsOpened = 0
    /** The Visit the page shows, which the entry in front should name once the writes have run. */
    let shown = 'start'
    /** A load of another document has begun (`leave`). Any history move after it would cancel it. */
    let leaving = false
    let movedWhileLeaving = false

    const queue = (write: () => unknown): Promise<void> => {
        writes++
        const run = pending.then(async () => {
            await write()
        })
        pending = run.catch(() => undefined)
        return run
    }
    const front = () => entries[index]

    const overlays = createOverlayHistory({
        top: () => stack.top(),
        marker: () => front().token,
        snapshot: () => front().visit,
        push(token) {
            entries = [...entries.slice(0, index + 1), { visit: front().visit, overlay: true, token }]
            index++
            overlays.entryChanged(false)
        },
        back() {
            traverse(-1)
        },
        dropEntry() {
            traverse(-1, { unseen: true })
        },
        unmark() {
            entries[index] = { visit: front().visit, overlay: false }
            overlays.entryChanged(false)
        },
        queue,
        newToken: () => `overlay-${++tokens}`,
    })
    stack.subscribe(() => overlays.reconcile())

    function traverse(step: number, { unseen = false } = {}): void {
        const to = index + step
        if (to < 0 || to >= entries.length) return
        if (leaving) movedWhileLeaving = true
        index = to
        if (!unseen) shown = front().visit
        followSettings()
        overlays.entryChanged(true)
    }

    /**
     * Settings opens and closes from the entry in front, before the navigation is reported, as
     * the workspace's effect on `page.state` does: Forward onto its entry opens it again.
     */
    function followSettings(): void {
        const wanted = front().settings
        if (settings && settings.id !== wanted) {
            settings.place.close()
            settings = null
        }
        if (wanted !== undefined && !settings) settings = { id: wanted, place: stack.open() }
    }

    /** Wait until no write is queued, including the writes the ones before them queued. */
    async function settle(): Promise<void> {
        for (let seen = -1; seen !== writes; ) {
            seen = writes
            await pending
            await Promise.resolve()
        }
    }

    return {
        entries: () => entries.map((entry) => ({ ...entry })),
        front: () => ({ ...front() }),
        index: () => index,
        openCount: () => open.size,
        settle,
        /** Open Settings: an entry of its own, without an overlay's marker (`openGraphSettings`). */
        openSettings(): void {
            if (settings) return
            const id = ++settingsOpened
            settings = { id, place: stack.open() }
            void queue(() => {
                if (settings?.id !== id) return
                entries = [...entries.slice(0, index + 1), { visit: front().visit, overlay: false, settings: id }]
                index++
                overlays.entryChanged(false)
            })
        },
        /** Close Settings by its close button: Back, when its entry is in front (`closeGraphSettings`). */
        closeSettings(): void {
            if (!settings) return
            const id = settings.id
            settings.place.close()
            settings = null
            void queue(() => (front().settings === id ? traverse(-1) : undefined))
        },
        settingsOpen: () => settings !== null,
        /** The Visit the page shows. */
        shown: () => shown,
        /** A View becomes active: the workspace's `pushUrl`, through the same queue. */
        visit(name: string): void {
            shown = name
            void queue(() => {
                const entry = { visit: name, overlay: false }
                if (visitReplacesFront(front().token)) entries[index] = entry
                else {
                    entries = [...entries.slice(0, index + 1), entry]
                    index++
                }
                overlays.entryChanged(false)
            })
        },
        /**
         * The page in front changes without a Visit: the workspace's `replaceUrl` or
         * `replaceUrlWithoutVisit`, which keep an overlay's marker on the entry they replace. The
         * last page closed when a confirmed delete removed it, for one.
         */
        replace(name: string): void {
            shown = name
            void queue(() => {
                entries[index] = { ...front(), visit: name }
                overlays.entryChanged(false)
            })
        },
        /** A load of another document begins, as `location.assign` starts one (`beforeNavigate`'s `willUnload`). */
        leave(): void {
            leaving = true
            overlays.leave()
        },
        /** Whether a history move came after `leave`, which in a browser cancels the load. */
        movedWhileLeaving: () => movedWhileLeaving,
        openOverlay(_kind: string, options: { refuses?: boolean; ownEntry?: boolean } = {}): FakeOverlay {
            let isOpen = true
            const close = () => {
                if (!isOpen) return
                isOpen = false
                open.delete(overlay)
                place.close()
            }
            const overlay: FakeOverlay = { isOpen: () => isOpen, closeOtherWay: close }
            open.add(overlay)
            const place = stack.open(options.ownEntry ? {} : { dismiss: () => (options.refuses ? undefined : close()) })
            return overlay
        },
        async userBack(): Promise<void> {
            await settle()
            traverse(-1)
            await settle()
        },
        async userForward(): Promise<void> {
            await settle()
            traverse(1)
            await settle()
        },
        /** Press Back or Forward without waiting for the page's writes first. */
        pressBack: () => traverse(-1),
        pressForward: () => traverse(1),
    }
}
