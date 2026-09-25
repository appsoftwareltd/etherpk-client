/**
 * Orphaned-asset detection for a Server-Backend graph. The server can only ENUMERATE a
 * graph's assets (opaque ids + sizes) - documents are ciphertext to it (E2EE), so only a
 * key-holding client can tell which assets are referenced. The scan diffs the server's
 * list against every document's text.
 *
 * Safety gate: every document must have caught up with the server before its text is
 * trusted - a half-synced doc reads as empty and would misclassify its assets as
 * orphans. Any doc that cannot catch up within the timeout ABORTS the scan.
 *
 * Reference test is conservative, like the filesystem scanner: an asset counts as
 * referenced if its (random, unguessable) asset id appears anywhere in any document.
 */

import type { GraphKeyring } from '$lib/crypto'
import type { GraphSync } from '$lib/sync/graph-sync'
import type { SyncTokenSource } from '$lib/sync/sync-token'
import type { GraphAssetTools, OrphanScan, OrphanedAsset } from '$lib/storage/fs/asset-orphans'

import { serverAssetByteReadiness } from './asset-byte-readiness'
import { backfillAssetDedupTokens } from './asset-dedup-backfill'
import { assetIdFromRef } from './server-asset-store'

export interface ServerAssetOrphanDeps {
    graph: GraphSync
    graphId: string
    baseUrl: string
    /** Asked per request - a graph session outlives a token (see `sync-token.ts`). */
    syncToken: SyncTokenSource
    fetch?: typeof fetch
    /** Per-document catchup bound; scan aborts (never guesses) on timeout. */
    timeoutMs?: number
    /**
     * TEMPORARY (ADR 0053): when present, the scan also backfills dedup tokens onto assets
     * uploaded before tokens existed (`asset-dedup-backfill.ts`). Delete with that module.
     */
    keyring?: GraphKeyring
}

export interface ListedAsset {
    assetId: string
    size: number
    chunkCount: number
    status: string
    /** Whether the row carries a dedup token (ADR 0053); read only by the temporary backfill. */
    hasDedupToken?: boolean
}

function api(deps: ServerAssetOrphanDeps) {
    const f = deps.fetch ?? fetch
    const base = deps.baseUrl.replace(/\/$/, '')
    return { f, base, headers: async () => ({ 'x-sync-token': await deps.syncToken() }) }
}

/**
 * Every asset row the graph has, ids and sizes only - the blind server can enumerate without
 * reading anything (ADR 0027).
 *
 * Two callers ask this for opposite reasons. The orphan scan wants the ones NO document
 * references, to offer them for deletion. The [[Local Mirror]] wants all of them, because "does
 * the graph hold this?" is the only safe basis for downloading and for deleting a folder's copy -
 * a regex over document text cannot see inside a [[Protected Document]].
 */
export async function listServerAssets(deps: ServerAssetOrphanDeps): Promise<ListedAsset[]> {
    const { f, base, headers } = api(deps)
    const res = await f(`${base}/api/v1/sync/assets/${deps.graphId}`, { headers: await headers() })
    if (!res.ok) throw new Error(`asset list failed: ${res.status}`)
    const { assets } = (await res.json()) as { assets: ListedAsset[] }
    return assets
}

/** The ids of every asset the graph holds and has finished storing. */
export async function listCompleteServerAssetIds(deps: ServerAssetOrphanDeps): Promise<string[]> {
    // An upload still in flight has no complete set of chunks to fetch, so it is not yet part of
    // what a copy of the graph can hold. The next pass picks it up.
    return (await listServerAssets(deps)).filter((asset) => asset.status === 'complete').map((a) => a.assetId)
}

export async function scanOrphanedServerAssets(deps: ServerAssetOrphanDeps): Promise<OrphanScan> {
    const assets = await listServerAssets(deps)
    if (assets.length === 0) return { orphans: [], totalAssets: 0, scannedDocuments: 0 }

    // TEMPORARY (ADR 0053): the scan already holds the list every legacy asset needs
    // tokening from, so token them here. Best effort, counted, never thrown.
    const dedupBackfill = deps.keyring
        ? await backfillAssetDedupTokens(
              { graphId: deps.graphId, baseUrl: deps.baseUrl, syncToken: deps.syncToken, keyring: deps.keyring, fetch: deps.fetch },
              assets.map((a) => ({ assetId: a.assetId, hasDedupToken: a.hasDedupToken ?? true, status: a.status })),
          )
        : undefined

    // Collect every document's text, gated on its first catchup (see module doc).
    const docIds: string[] = []
    deps.graph.registry().forEach((_entry, docId) => docIds.push(docId))
    const texts: string[] = []
    for (const docId of docIds) {
        const engine = deps.graph.docSync(docId)
        const caught = await Promise.race([
            engine.caughtUp().then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), deps.timeoutMs ?? 8000)),
        ])
        if (!caught) throw new Error('A document has not finished syncing; try again once the graph is fully synced')
        texts.push(engine.doc.getText('content').toString())
    }

    const referenced = (assetId: string) => texts.some((t) => t.includes(assetId))
    const orphans: OrphanedAsset[] = assets
        .filter((a) => !referenced(a.assetId))
        .map((a) => ({ id: a.assetId, label: `${a.assetId.slice(0, 8)}… (${formatSize(a.size)})`, size: a.size }))
    return { orphans, totalAssets: assets.length, scannedDocuments: texts.length, ...(dedupBackfill ? { dedupBackfill } : {}) }
}

/**
 * The synced graph's {@link GraphAssetTools}. `identify` reads the random asset id out of a
 * reference (the stem varies per paste; the id does not), and `readyToDeleteBytes` is the
 * watermark proof ADR 0054 requires before any byte is destroyed.
 */
export function serverAssetTools(deps: ServerAssetOrphanDeps): GraphAssetTools {
    return {
        scan: () => scanOrphanedServerAssets(deps),
        remove: (ids) => deleteOrphanedServerAssets(deps, ids),
        identify: (ref) => assetIdFromRef(ref),
        readyToDeleteBytes: () => serverAssetByteReadiness(deps.graph),
    }
}

/** Delete the given assets server-side (chunks + metadata). Returns the number deleted. */
export async function deleteOrphanedServerAssets(
    deps: ServerAssetOrphanDeps,
    ids: string[],
): Promise<number> {
    const { f, base, headers } = api(deps)
    let removed = 0
    for (const id of ids) {
        const res = await f(`${base}/api/v1/sync/assets/${deps.graphId}/${id}`, { method: 'DELETE', headers: await headers() })
        if (res.ok) removed += 1
        else if (res.status !== 404) throw new Error(`asset delete failed: ${res.status}`)
    }
    return removed
}

function formatSize(bytes: number): string {
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${bytes} B`
}
