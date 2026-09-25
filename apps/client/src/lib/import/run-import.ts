/**
 * Import orchestration: source preparation from a `webkitdirectory` FileList, and the
 * two destination flows. Conversion is complete (in memory) before the first write;
 * the registry record is inserted LAST, so a failed import never shows a half-graph
 * in the picker. Mid-materialisation failure cleans up what it created - the empty
 * destination folder's new entries, or the just-created server graph.
 */

import type { GraphRegistry, ServerGraphScope } from '$lib/storage/graph-registry'
import { createWebFsDirectoryAdapter } from '$lib/storage/fs/web-fs-adapter'
import { SUBDIRS } from '$lib/storage/fs/directory-adapter'
import { createServerAssetStore } from '$lib/storage/server/server-asset-store'
import { createGraphNamePublisher } from '$lib/sync/graph-name-envelope'
import { browserTransport, createGraphSync, type TransportSocket } from '$lib/sync/graph-sync'
import { ensureGraphKeys, vaultProtectionAccess } from '$lib/sync/keys'
import { vaultProtectionStore, type ProtectionRecordStore } from '$lib/document/protection/protection-store'
import type { ProtectionRecord } from '$lib/crypto'
import { openGraphCache } from '$lib/sync/local-cache'
import type { SyncApi } from '$lib/sync/sync-api'
import { relayUrlFrom } from '$lib/sync/sync-config'
import { createSyncTokenSource } from '$lib/sync/sync-token'

import { materializeToFilesystem } from './materialize-filesystem'
import { materializeToServer, type ServerMaterializeResult, type SkippedAsset } from './materialize-server'
import { retrySkippedAssets, type RetryOutcome } from './retry-assets'
import { describeSource, stripRootSegment, type SourceSummary } from './source'
import type { ConvertedGraph, ImportControl, ImportFormat, SourceFile } from './types'

/** A source ready for the wizard: the files, the name prefill, the detected format and the counts. */
export type PreparedSource = SourceSummary

/** Build the converter input from a `webkitdirectory` selection; null when it holds no files. */
export function prepareSource(fileList: ArrayLike<File>): PreparedSource | null {
    const raw = Array.from(fileList)
    if (raw.length === 0) return null
    const first = raw[0].webkitRelativePath || raw[0].name
    const folderName = first.includes('/') ? first.slice(0, first.indexOf('/')) : ''
    const files: SourceFile[] = raw.map((f) => ({
        path: stripRootSegment(f.webkitRelativePath || f.name),
        data: f,
    }))
    return describeSource(files, folderName)
}

/** True when the picked destination directory already has any entry (never-in-place). */
export async function directoryHasEntries(handle: FileSystemDirectoryHandle): Promise<boolean> {
    for await (const _ of handle.keys()) {
        void _
        return true
    }
    return false
}

export interface ImportRunOptions {
    format: ImportFormat
    reportDate: string
    /** Progress, cancellation and yielding; forwarded to the materialisers. */
    control?: ImportControl
    /** Test seam: how long the ack wait tolerates silence before degrading. */
    ackStallMs?: number
}

/**
 * Materialise into an (already verified empty) directory and register the graph.
 * On failure, best-effort removes the skeleton it created and rethrows.
 */
export async function runFilesystemImport(
    converted: ConvertedGraph,
    deps: { handle: FileSystemDirectoryHandle; registry: GraphRegistry; name: string },
    options: ImportRunOptions,
): Promise<{ graphId: string }> {
    const adapter = createWebFsDirectoryAdapter(deps.handle)
    try {
        await materializeToFilesystem(converted, adapter, options)
    } catch (err) {
        // The folder was empty at the start, so everything under the skeleton is ours.
        for (const subdir of SUBDIRS) {
            await deps.handle.removeEntry(subdir, { recursive: true }).catch(() => {})
        }
        throw err
    }
    const graphId = crypto.randomUUID()
    await deps.registry.insertGraph({
        id: graphId,
        name: deps.name,
        backend: 'filesystem',
        createdAt: Date.now(),
        handle: deps.handle,
    })
    return { graphId }
}

export interface ServerImportDeps {
    api: SyncApi
    registry: GraphRegistry
    name: string
    /** The device's sync server base URL (asset uploads + relay derive from it). */
    serverBaseUrl: string
    /** Account partition confirmed by `/sync/me` before this import began. */
    serverScope: ServerGraphScope
    /** Supplies the vault wrap key when the account already has a vault (unlock). */
    getWrapKey: () => Promise<Uint8Array>
    /** Injectable for tests; defaults to the real browser WebSocket. */
    connect?: (url: string) => TransportSocket
}

export interface ServerImportResult {
    graphId: string
    /** Assets the Sync Server would not store. Named in the [[Import Report]] as well. */
    skippedAssets: SkippedAsset[]
    /**
     * Re-upload those assets and repoint the documents that referenced them. Present only when
     * something was skipped, and only for as long as this session holds their bytes.
     */
    retryAssets?: () => Promise<RetryOutcome>
    /** Set when a brand-new account vault was created - the caller MUST run the Recovery
     *  Code ritual and call `commit()` only after the code is acknowledged (ADR 0029). */
    recoveryCode?: string
    commit?: () => Promise<void>
    /** The vault key to cache on this device (vault-session). */
    deviceKey: Uint8Array
    /** False when the ack wait gave up: the graph IS registered and its content is safe in
     *  the Local Cache, but the server has not confirmed all of it yet (ADR 0035 §4). */
    fullyAcked: boolean
    ackedDocuments: number
    totalDocuments: number
}

/**
 * Create a server graph, push the converted documents/assets through an E2EE session,
 * and register it. On failure after creation, the just-created graph is deleted
 * server-side so no empty membership lingers.
 */
export async function runServerImport(
    converted: ConvertedGraph,
    deps: ServerImportDeps,
    options: ImportRunOptions,
): Promise<ServerImportResult> {
    const graph = await deps.api.createGraph() // the server stores no name (ADR 0024)
    let materialized: ServerMaterializeResult
    try {
        const keys = await ensureGraphKeys(deps.api, graph.id, deps.getWrapKey)
        // The source's protection record becomes this graph's own (ADR 0093). An existing
        // account's vault takes it during materialisation; a fresh account's vault is written
        // only once the Recovery Code is acknowledged, so the record waits and goes in right
        // after that commit, opened with the vault key the commit just stored.
        let deferredRecord: ProtectionRecord | undefined
        const vaultAccess = vaultProtectionAccess(deps.api, keys.recoveryCodeJustGenerated ? async () => keys.deviceKey : deps.getWrapKey)
        const protection: ProtectionRecordStore = keys.recoveryCodeJustGenerated
            ? {
                  read: async () => ({ kind: 'missing' }),
                  write: async (record) => {
                      deferredRecord = record
                  },
                  clear: async () => {
                      deferredRecord = undefined
                  },
              }
            : vaultProtectionStore(graph.id, vaultAccess)
        const commitWithProtection = async () => {
            await keys.commit()
            if (deferredRecord) await vaultProtectionStore(graph.id, vaultAccess).write(deferredRecord)
        }
        // A refreshing source, not one token: a large graph takes far longer to upload than
        // a token lives, and every asset upload past that mark used to 401 (see sync-token.ts).
        const token = createSyncTokenSource(() => deps.api.mintSyncToken(graph.id))
        const cache = await openGraphCache(graph.id)
        const sync = createGraphSync({
            graphId: graph.id,
            rootDocId: graph.rootDocId,
            keyring: keys.keyring,
            relayUrl: relayUrlFrom(deps.serverBaseUrl),
            token,
            cache,
            connect: deps.connect ?? browserTransport,
            // The name set below is the first this graph has: publish it, so the account's other
            // devices can label the graph before opening it (graph-name-envelope.ts).
            publishName: createGraphNamePublisher({ api: deps.api, keyring: keys.keyring, graphId: graph.id }).publish,
        })
        try {
            await sync.ready()
            await sync.connected() // never flush into a not-yet-open socket
            const assetStore =
                converted.assets.length > 0
                    ? createServerAssetStore({
                          graphId: graph.id,
                          keyring: keys.keyring,
                          baseUrl: deps.serverBaseUrl,
                          syncToken: token,
                          // Uploads retry with backoff; cancelling must cut the wait short
                          // rather than let the import run on for another few seconds.
                          signal: options.control?.signal,
                      })
                    : null
            materialized = await materializeToServer(converted, { graph: sync, assetStore, name: deps.name, protection }, options)
        } finally {
            sync.dispose()
            cache.dispose()
        }
        await deps.registry.insertGraph({
            id: graph.id,
            name: deps.name,
            backend: 'server',
            createdAt: Date.now(),
            handle: { rootDocId: graph.rootDocId },
            serverScope: deps.serverScope,
            membershipActive: true,
        })
        return {
            graphId: graph.id,
            recoveryCode: keys.recoveryCodeJustGenerated,
            commit: keys.recoveryCodeJustGenerated ? commitWithProtection : undefined,
            deviceKey: keys.deviceKey,
            ...materialized,
            retryAssets: materialized.skippedAssets.length === 0
                ? undefined
                : async () => {
                    const retryToken = createSyncTokenSource(() => deps.api.mintSyncToken(graph.id))
                    const retryCache = await openGraphCache(graph.id)
                    const retrySync = createGraphSync({
                        graphId: graph.id,
                        rootDocId: graph.rootDocId,
                        keyring: keys.keyring,
                        relayUrl: relayUrlFrom(deps.serverBaseUrl),
                        token: retryToken,
                        cache: retryCache,
                        connect: deps.connect ?? browserTransport,
                    })
                    try {
                        await retrySync.ready()
                        await retrySync.connected()
                        return await retrySkippedAssets(materialized.skippedAssets, converted.assets, {
                            graph: retrySync,
                            assetStore: createServerAssetStore({
                                graphId: graph.id,
                                keyring: keys.keyring,
                                baseUrl: deps.serverBaseUrl,
                                syncToken: retryToken,
                            }),
                        })
                    } finally {
                        retrySync.dispose()
                        retryCache.dispose()
                    }
                },
        }
    } catch (err) {
        // An [[Abandoned Import]] keeps nothing: the graph goes, and with it every document
        // pushed into it and every asset chunk already in object storage (the Server sweeps the
        // bucket before it touches a row). If that cleanup itself fails, say so - silently
        // leaving a graph nobody can see, against the owner's allowance, is the one outcome
        // worse than a failed import.
        const cleanup = await deps.api
            .deleteGraph(graph.id)
            .then(() => null)
            .catch((cleanupError: unknown) => (cleanupError as Error).message)
        if (cleanup) {
            throw new Error(
                `${(err as Error).message}. The partly-created graph could NOT be removed (${cleanup}) - it may still be listed under Synced graphs and count against your allowance.`,
            )
        }
        throw new Error(
            `${(err as Error).message}. Nothing was kept: the graph, its documents and any files already uploaded were removed from the sync server.`,
        )
    }
}
