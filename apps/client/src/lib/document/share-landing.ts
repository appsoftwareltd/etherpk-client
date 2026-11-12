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
import type { GraphKeyring } from '#lib/crypto/index.js'
import type { GraphRecord } from '#lib/storage/graph-registry.js'
import {
    addQuickNoteOverSession,
    type QuickNoteDelivery,
    type QuickNoteSessionDeps,
    type QuickNoteSessionHooks,
} from '#lib/sync/quick-note-session.js'
import { openAssetCopies } from '#lib/storage/synced/asset-copies.js'
import { type ServerAssetStore, createServerAssetStore } from '#lib/storage/synced/server-asset-store.js'
import { NO_SHARE_NAMES, type ShareNames, readShareNames } from '#lib/sync/share-names.js'
import { heldGraphKeyring, resolveSyncedGraphConnection, type SyncedGraphConnection } from '#lib/sync/synced-graph-access.js'
import { isVaultUnlocked } from '#lib/sync/vault-session.js'

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
    /**
     * The account the graph's record belongs to on its Sync Server: whose own Quick Notes the
     * share joins (ADR 0159). Absent on a record without an account scope, whose share then goes
     * to the shared array (see QuickNoteSessionDeps.memberKey).
     */
    memberKey?: string
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
        const memberKey = graph.serverScope?.principalId
        return { kind: 'direct', graphId: graph.id, rootDocId, keyring, connection, ...(memberKey ? { memberKey } : {}) }
    } catch (err) {
        return failure(err)
    }
}

/**
 * The names the page may show for `graph` before anything is pressed (ADR 0186): the pages a
 * `[[` completes to and the concepts a note can be filed under. Only for a synced graph whose
 * vault this device has unlocked, read from this device's copy with no network call, so they
 * are on screen with the rest of the form. A folder graph and a graph locked here show none.
 */
export async function shareNamesFor(graph: GraphRecord, deps: ShareNamesDeps = productionNamesDeps): Promise<ShareNames> {
    const held = syncedRoot(graph)
    if (!held) return NO_SHARE_NAMES
    try {
        if (!deps.unlocked(held.origin)) return NO_SHARE_NAMES
        return await deps.read(graph.id, held.rootDocId, graph.serverScope?.principalId)
    } catch {
        // Names are a convenience. A copy that will not read leaves the share as it was before them.
        return NO_SHARE_NAMES
    }
}

/** The server a synced graph's record names and its root document, or null for a record with neither. */
function syncedRoot(graph: GraphRecord): { origin: string; rootDocId: string } | null {
    if (graph.backend !== 'server') return null
    const origin = graph.serverScope?.serverOrigin
    const rootDocId = (graph.handle as { rootDocId?: unknown } | null)?.rootDocId
    return origin && typeof rootDocId === 'string' && rootDocId !== '' ? { origin, rootDocId } : null
}

export interface ShareNamesDeps {
    unlocked: (serverOrigin: string) => boolean
    read: (graphId: string, rootDocId: string, memberKey: string | undefined) => Promise<ShareNames>
}

const productionNamesDeps: ShareNamesDeps = { unlocked: isVaultUnlocked, read: readShareNames }

/**
 * The store a direct share's files go into: the graph's own asset store, told to keep every
 * file on this device before any network call (`queueFirst`), so Add is as quick offline as
 * online and what is still to send survives the page. `uploadQueued` then sends them.
 */
export function shareFileStore(route: DirectShareRoute): ServerAssetStore {
    return createServerAssetStore({
        graphId: route.graphId,
        keyring: route.keyring,
        baseUrl: route.connection.serverBaseUrl,
        syncToken: route.connection.token,
        copies: openAssetCopies(),
        queueFirst: true,
    })
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
                memberKey: route.memberKey,
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
