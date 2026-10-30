/**
 * The [[Favourite]]s one person sees on a synced graph (ADR 0159), and how that list is written and
 * kept in step with the old shared list. The lists themselves are root-doc types that
 * `graph-sync.ts` owns. This module decides which of them the person sees and when the shared list
 * is copied, so the workspace only connects the result to `favourites.ts`.
 *
 * - **No member key** (the account is not known on this device): the shared `favourites` field of
 *   Graph Settings, as before per-person lists. The graph registry hides a synced graph that has no
 *   account scope, so a workspace reaches this only on a graph opened without one.
 * - **Before the seed** (ADR 0159 decision 4): the person's own list joined with the shared one,
 *   own entries first. Nothing is written to show it. A device on its first upgraded open would
 *   otherwise show an empty list until the root document caught up. A change the person makes
 *   meanwhile writes the joined list and marks the list seeded in one transaction.
 * - **After the seed**: the person's own list. An older Client still writes the shared list, so
 *   each shared entry not seen before joins the person's list once (`followShared`).
 */
import type { FavouritesPersist } from '$lib/document/favourites'
import { type GraphSettings, sanitizeFavourites, sanitizeGraphSettings } from '$lib/storage/fs/graph-settings'

import type { GraphSync } from './graph-sync'

export type PersonalFavouritesGraph = Pick<GraphSync, 'favourites' | 'getMeta' | 'setMetaSettings' | 'onMetaChange' | 'rootCaughtUp' | 'flushAll'>

export interface PersonalFavourites {
    /** The list the person sees now. */
    list(): string[]
    /** Writes the person's change. Wired as the `favourites.ts` persist. */
    persist: FavouritesPersist
    /** Fires whenever {@link list} may have changed (local or remote). Returns an unsubscribe. */
    observe(listener: () => void): () => void
    /**
     * Copy the shared list in once the root document has caught up, then follow each later
     * change of it (ADR 0159 decision 4). Returns a stop. Nothing is written once `stillOpen`
     * answers false or after the stop.
     */
    follow(stillOpen: () => boolean): () => void
}

/** The shared Graph Settings favourites, as stored in the root doc's `meta` map. */
function sharedFavourites(graph: Pick<GraphSync, 'getMeta'>): string[] {
    return sanitizeGraphSettings(graph.getMeta().settings ?? {}).favourites ?? []
}

/**
 * The shared Graph Settings to write from the Graph Settings dialog on a synced graph: the dialog's
 * fields, with the shared `favourites` exactly as the root document holds them now (`stored`), and
 * none where it holds none. The dialog copied them when it opened and does not edit them. Written
 * back, that copy would undo every change made to the shared list since, and a favourite an older
 * Client removed there would come back for every Member who follows it (ADR 0159 decision 4).
 */
export function settingsKeepingSharedFavourites(saved: GraphSettings, stored: Record<string, unknown> | undefined): Record<string, unknown> {
    const { favourites: _copied, ...rest } = saved
    return stored && 'favourites' in stored ? { ...rest, favourites: stored.favourites } : rest
}

export function personalFavourites(graph: PersonalFavouritesGraph, memberKey: string | undefined): PersonalFavourites {
    if (!memberKey) {
        return {
            list: () => sharedFavourites(graph),
            async persist(next) {
                // Merged into the CURRENT settings rather than a snapshot, so a favourite written
                // here cannot overwrite a setting a peer changed meanwhile.
                const current = sanitizeGraphSettings(graph.getMeta().settings ?? {})
                graph.setMetaSettings({ ...current, favourites: [...next] } as Record<string, unknown>)
            },
            observe: (listener) => graph.onMetaChange(listener),
            follow: () => () => {},
        }
    }

    const own = graph.favourites(memberKey)
    return {
        list() {
            if (own.seeded()) return own.list()
            // Own first, so an entry in both keeps the person's place and spelling.
            return sanitizeFavourites([...own.list(), ...sharedFavourites(graph)])
        },
        async persist(next, change) {
            own.replace(next, own.seeded() ? change : { ...change, seedFrom: sharedFavourites(graph) })
        },
        observe(listener) {
            // The shared list is part of what the person sees until the seed, so a `meta` change
            // is heard too. After the seed it costs one re-read that finds nothing new.
            const offOwn = own.observe(listener)
            const offMeta = graph.onMetaChange(listener)
            return () => {
                offOwn()
                offMeta()
            }
        },
        follow(stillOpen) {
            let stopped = false
            let caughtUp = false
            const sync = () => {
                if (stopped || !caughtUp || !stillOpen()) return
                const shared = sharedFavourites(graph)
                const wrote = own.seeded() ? own.followShared(shared) : own.seedOnce(shared)
                // Out of the append debounce at once, as other background root-doc writes are. The
                // write is already in the root document, and a save that fails is reported by the
                // engine itself, so a refused flush is only logged, never left unhandled.
                if (wrote) {
                    graph.flushAll().catch((error: unknown) => {
                        console.warn('[favourites] could not save the copy of the shared favourites', error)
                    })
                }
            }
            const offMeta = graph.onMetaChange(sync)
            // Only after a real catch-up, with no offline grace period: until then this device may
            // not have the seed flag another of the person's devices set, and would refill a list
            // the person has since emptied.
            graph.rootCaughtUp().then(
                () => {
                    caughtUp = true
                    sync()
                },
                () => {
                    // Not caught up this session: the copy waits for the next open that is.
                },
            )
            return () => {
                stopped = true
                offMeta()
            }
        },
    }
}
