/**
 * Where a [[Share Target]] share lands once the user has picked a graph (ADR 0087, amended
 * 2026-09-21): written directly from the share page when this device can do it without asking
 * anything, handed to the workspace otherwise.
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

export type ShareLanding =
    | { kind: 'added'; synced: boolean }
    | { kind: 'handoff'; reason: 'folder' | 'no-sync' | 'locked' }
    | { kind: 'handoff'; reason: 'failed'; error: string }

/** The three seams, injectable so the decision is pinned down without a relay or a vault. */
export interface ShareLandingDeps {
    connection: (graphId: string) => SyncedGraphConnection | null
    keyring: (api: SyncedGraphConnection['api'], graphId: string) => Promise<GraphKeyring | null>
    session: (deps: QuickNoteSessionDeps, note: QuickNote, hooks?: QuickNoteSessionHooks) => Promise<QuickNoteDelivery>
}

const productionDeps: ShareLandingDeps = {
    connection: resolveSyncedGraphConnection,
    keyring: (api, graphId) => heldGraphKeyring(api, graphId),
    session: addQuickNoteOverSession,
}

/** What the caller hears and controls: `onSaved`, and a signal that ends the sync wait early. */
export interface ShareLandingOptions extends QuickNoteSessionHooks {
    signal?: AbortSignal
}

export async function landShareDirectly(
    graph: GraphRecord,
    note: QuickNote,
    deps: ShareLandingDeps = productionDeps,
    hooks: ShareLandingOptions = {},
): Promise<ShareLanding> {
    if (graph.backend !== 'server') return { kind: 'handoff', reason: 'folder' }
    const connection = deps.connection(graph.id)
    if (!connection) return { kind: 'handoff', reason: 'no-sync' }
    let saved = false
    try {
        const rootDocId = (graph.handle as { rootDocId?: unknown } | null)?.rootDocId
        if (typeof rootDocId !== 'string' || rootDocId === '') throw new Error('The graph record names no root document.')
        const keyring = await deps.keyring(connection.api, graph.id)
        if (!keyring) return { kind: 'handoff', reason: 'locked' }
        const delivery = await deps.session(
            { graphId: graph.id, rootDocId, keyring, relayUrl: connection.relayUrl, token: connection.token, signal: hooks.signal },
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
        return { kind: 'handoff', reason: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
}
