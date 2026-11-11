/**
 * Version History for one open synced graph (ADR 0184): the recorder that makes versions on this
 * device and the history the views read, joined to the graph's sync session.
 *
 * Every local edit to a document in the registry starts the recorder's idle timer. The root
 * document and a person's private PDF and EBook state documents are not in the registry, so they
 * get no versions. Anything left in the outbox from an earlier session is sent when the graph opens,
 * and edits still waiting for an idle version when it closes are kept then.
 */
import type { KeyringSource } from '#lib/crypto/index.js'
import type { GraphSync } from '#lib/sync/graph-sync.js'
import type { SyncTokenSource } from '#lib/sync/sync-token.js'
import { createVersionApi, type VersionApi, type VersionApiError } from './version-api'
import { createVersionHistory, type VersionHistory, type VersionHistoryStore } from './version-history'
import type { QueuedVersion, VersionOutbox } from './version-outbox'
import { createVersionRecorder, type VersionRecorder, type VersionSnapshot } from './version-recorder'

export interface GraphVersionsDeps {
    graphId: string
    graph: GraphSync
    keyring: KeyringSource
    baseUrl: string
    syncToken: SyncTokenSource
    outbox: VersionOutbox
    store: VersionHistoryStore & { versionSnapshot(docId: string): VersionSnapshot | null }
    fetch?: typeof fetch
    assetName?: (assetId: string) => Promise<string | null>
    onRefused?: (error: VersionApiError, version: QueuedVersion) => void
    /** How long a document goes without an edit before an idle version; the recorder's own when absent. */
    idleMs?: number
}

export interface GraphVersions {
    api: VersionApi
    recorder: VersionRecorder
    history: VersionHistory
    dispose(): void
}

export function openGraphVersions(deps: GraphVersionsDeps): GraphVersions {
    const api = createVersionApi({ graphId: deps.graphId, baseUrl: deps.baseUrl, syncToken: deps.syncToken, fetch: deps.fetch })
    const recorder = createVersionRecorder({
        graphId: deps.graphId,
        keyring: deps.keyring,
        api,
        outbox: deps.outbox,
        source: { read: (docId) => deps.store.versionSnapshot(docId) },
        onRefused: deps.onRefused,
        idleMs: deps.idleMs,
    })
    const registry = deps.graph.registry()
    const unobserve = deps.graph.onDocUpdate((docId, local) => {
        if (local && registry.has(docId)) recorder.noteLocalEdit(docId)
    })
    void recorder.flush()
    return {
        api,
        recorder,
        history: createVersionHistory({
            graphId: deps.graphId,
            keyring: deps.keyring,
            api,
            recorder,
            store: deps.store,
            assetName: deps.assetName,
        }),
        dispose() {
            // The graph is closing: edits still waiting for an idle version are kept first. They
            // reach the outbox and are sent when the graph next opens.
            recorder.settle()
            unobserve()
            recorder.dispose()
        },
    }
}
