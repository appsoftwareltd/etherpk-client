/**
 * Where a [[Share Target]] share lands once the user presses Add (ADR 0087, amended 2026-09-21
 * and 2026-10-13): written directly from the share page when this device can do it without
 * asking anything, handed to the workspace otherwise. The route is worked out before Add
 * (`routeShare`) and the write runs on it (`landShareDirectly`).
 *
 * The direct write is for synced graphs only. Their engine is built for more than one writer -
 * the Local Cache is shared across tabs and a Y.Array append merges at the relay - so a share
 * page writing beside an open workspace is the same as a second tab. A folder graph's
 * `etherpk/quick-notes.json` has exactly one writer, the browser that has the folder open, and
 * a second one would overwrite its list; a folder opens quickly anyway, so it keeps the hand-off.
 *
 * Nothing here prompts. Every precondition miss - no sync configured, the vault locked here, no
 * keyring for the graph, a record with no root doc - and every failure before the note is
 * saved is a `handoff`, and the workspace's open path (the unlock prompt, the permission
 * button, the missing and error notices) remains the only place that recovers. Once the
 * session has reported the note saved, a later failure is a sync problem the page says so
 * about, never a reason to hand the same text over again.
 */
import type { GraphKeyring } from '$lib/crypto'
import type { GraphRecord } from '$lib/storage/graph-registry'
import {
    addQuickNoteOverSession,
    type QuickNoteDelivery,
    type QuickNoteSessionDeps,
    type QuickNoteSessionHooks,
} from '$lib/sync/quick-note-session'
import { heldGraphKeyring, resolveSyncedGraphConnection, type SyncedGraphConnection } from '$lib/sync/synced-graph-access'

import type { QuickNote } from './quick-notes'

/** A failure on the way to the direct write, named so the console can say what went wrong. */
export interface FailedHandoff {
    kind: 'handoff'
    reason: 'failed'
    error: string
}

/** Why a share goes to the workspace instead of being written from the share page. */
export type ShareHandoff = { kind: 'handoff'; reason: 'folder' | 'no-sync' | 'locked' } | FailedHandoff

/** Everything the direct write's session needs, read before the user presses Add. */
export interface DirectShareRoute {
    kind: 'direct'
    graphId: string
    rootDocId: string
    keyring: GraphKeyring
    connection: SyncedGraphConnection
}

export type ShareRoute = DirectShareRoute | ShareHandoff

/** How the direct write ended: the note added (and whether the relay acknowledged it), or a hand-off after all. */
export type ShareLanding = { kind: 'added'; synced: boolean } | FailedHandoff

/** The three seams, injectable so the decision is pinned down without a relay or a vault. */
export interface ShareLandingDeps {
    /** The connection to the server the graph lives on (its record's scope), or null when none is held. */
    connection: (graph: GraphRecord) => SyncedGraphConnection | null
    keyring: (connection: SyncedGraphConnection, graphId: string) => Promise<GraphKeyring | null>
    session: (deps: QuickNoteSessionDeps, note: QuickNote, hooks?: QuickNoteSessionHooks) => Promise<QuickNoteDelivery>
}

const productionDeps: ShareLandingDeps = {
    connection: (graph) => {
        const origin = graph.serverScope?.serverOrigin
        return origin ? resolveSyncedGraphConnection(graph.id, origin) : null
    },
    keyring: (connection, graphId) => heldGraphKeyring(connection, graphId),
    session: addQuickNoteOverSession,
}

function failure(err: unknown): FailedHandoff {
    return { kind: 'handoff', reason: 'failed', error: err instanceof Error ? err.message : String(err) }
}

/**
 * How a share to `graph` would land, worked out while the user is still reading the form: the
 * direct write's preconditions, or the reason it hands over. The page runs this as soon as a
 * graph is selected, because reading the held keyring opens the vault, which is a network call;
 * done before Add, the press saves at once, and a hand-off is known before anything says
 * "Adding". Nothing here writes or prompts.
 */
export async function routeShare(graph: GraphRecord, deps: Pick<ShareLandingDeps, 'connection' | 'keyring'> = productionDeps): Promise<ShareRoute> {
    if (graph.backend !== 'server') return { kind: 'handoff', reason: 'folder' }
    // Inside the try as well: the connection is read from this browser's storage, and the page
    // holds the result as a promise it never expects to reject.
    try {
        const connection = deps.connection(graph)
        if (!connection) return { kind: 'handoff', reason: 'no-sync' }
        const rootDocId = (graph.handle as { rootDocId?: unknown } | null)?.rootDocId
        if (typeof rootDocId !== 'string' || rootDocId === '') throw new Error('The graph record names no root document.')
        const keyring = await deps.keyring(connection, graph.id)
        if (!keyring) return { kind: 'handoff', reason: 'locked' }
        return { kind: 'direct', graphId: graph.id, rootDocId, keyring, connection }
    } catch (err) {
        return failure(err)
    }
}

/** What the caller hears and controls: `onSaved`, and a signal that ends the sync wait early. */
export interface ShareLandingOptions extends QuickNoteSessionHooks {
    signal?: AbortSignal
}

/**
 * Write the note over a short engine session on a route `routeShare` resolved. A failure before
 * the session reports the note saved hands over; one after it is a sync problem the page reports,
 * never a reason to hand the same text to the workspace again.
 */
export async function landShareDirectly(
    route: DirectShareRoute,
    note: QuickNote,
    deps: Pick<ShareLandingDeps, 'session'> = productionDeps,
    hooks: ShareLandingOptions = {},
): Promise<ShareLanding> {
    let saved = false
    try {
        const { connection } = route
        const delivery = await deps.session(
            {
                graphId: route.graphId,
                rootDocId: route.rootDocId,
                keyring: route.keyring,
                relayUrl: connection.relayUrl,
                token: connection.token,
                signal: hooks.signal,
            },
            note,
            {
                onSaved: () => {
                    saved = true
                    hooks.onSaved?.()
                },
            },
        )
        return { kind: 'added', synced: delivery.synced }
    } catch (err) {
        if (saved) return { kind: 'added', synced: false }
        return failure(err)
    }
}
