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
 * referenced if its (random, unguessable) asset id appears anywhere in any document. A
 * [[Protected Document]] is read through the protection session while it is unlocked, and while
 * any cannot be read nothing is offered: the rule and the reference test are the filesystem
 * scanner's own (`referenceTexts`, `orphanScanOf`), so the two backends cannot disagree.
 *
 * Each candidate is labelled with the file name the uploader chose, read from the asset's
 * encrypted metadata: an eight-character id prefix would tell nobody which file they were deleting.
 */

import { type GraphKeyring, contextAad, fromBase64Url, keyForEpoch, openSymmetric } from '$lib/crypto'
import { mapWithPool } from '$lib/concurrency'
import type { ProtectedTextReader } from '$lib/document/protection/protected-text-reader'
import { contentBlocked } from '$lib/sync/doc-sync'
import type { GraphSync } from '$lib/sync/graph-sync'
import type { SyncTokenSource } from '$lib/sync/sync-token'
import {
    type GraphAssetTools,
    type OrphanScan,
    type OrphanedAsset,
    isReferenced,
    orphanScanOf,
    referenceTexts,
} from '$lib/storage/fs/asset-orphans'

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
     * The graph's keys. The scan reads each candidate's file name from its encrypted metadata
     * with them, and (TEMPORARY, ADR 0053) backfills dedup tokens onto assets uploaded before
     * tokens existed (`asset-dedup-backfill.ts`). Without it candidates wear their id.
     */
    keyring?: GraphKeyring
    /** Reads a Protected Document's plaintext while the graph is unlocked; absent, none is read. */
    readProtected?: ProtectedTextReader
    /**
     * Commits pending edits before the scan reads: a protected document's projection encrypts
     * on a debounce, so a reference pasted moments ago is otherwise not in its stored text yet.
     */
    settle?: () => Promise<void>
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
    await deps.settle?.()
    const docIds: string[] = []
    deps.graph.registry().forEach((_entry, docId) => docIds.push(docId))
    const stored: string[] = []
    // A document whose key is unavailable, or whose history will not decrypt, reads as empty:
    // its references are as invisible as a locked protected document's, so it is unread too.
    let unreadableOther = 0
    for (const docId of docIds) {
        const engine = deps.graph.docSync(docId)
        const caught = await Promise.race([
            engine.caughtUp().then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), deps.timeoutMs ?? 8000)),
        ])
        if (!caught) throw new Error('A document has not finished syncing; try again once the graph is fully synced')
        if (contentBlocked(engine.health())) {
            unreadableOther += 1
            continue
        }
        stored.push(engine.doc.getText('content').toString())
    }

    const { texts, unreadableProtected } = await referenceTexts(stored, deps.readProtected)
    const unused = assets.filter((a) => !isReferenced(texts, a.assetId))
    // Names only for what will be shown: a withheld candidate is not listed.
    const names = unreadableProtected === 0 && unreadableOther === 0 ? await assetNames(deps, unused.map((a) => a.assetId)) : new Map<string, string>()
    const candidates: OrphanedAsset[] = unused.map((a) => ({ id: a.assetId, label: orphanLabel(a, names.get(a.assetId)), size: a.size }))
    const scan = orphanScanOf(candidates, {
        totalAssets: assets.length,
        scannedDocuments: docIds.length,
        unreadableProtected,
        unreadableOther,
        unlockable: deps.readProtected !== undefined,
    })
    return { ...scan, ...(dedupBackfill ? { dedupBackfill } : {}) }
}

/** The file name the uploader chose, then the size; the id prefix only when no name could be read. */
function orphanLabel(asset: ListedAsset, name: string | undefined): string {
    return name ? `${name} (${formatSize(asset.size)})` : `${asset.assetId.slice(0, 8)}… (${formatSize(asset.size)})`
}

/**
 * Each asset's file name from its encrypted metadata, the decrypt `readAssetBytes` performs
 * without the chunks. Best effort: a name that cannot be read leaves that asset labelled by id.
 */
async function assetNames(deps: ServerAssetOrphanDeps, assetIds: readonly string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    const keyring = deps.keyring
    if (!keyring || assetIds.length === 0) return names
    const { f, base, headers } = api(deps)
    await mapWithPool(
        assetIds,
        async (assetId) => {
            try {
                const res = await f(`${base}/api/v1/sync/assets/${deps.graphId}/${assetId}`, { headers: await headers() })
                if (!res.ok) return
                const { encryptedMetadata } = (await res.json()) as { encryptedMetadata?: string }
                if (!encryptedMetadata) return
                const { plaintext } = await openSymmetric({
                    keyForEpoch: (id) => keyForEpoch(keyring, id),
                    envelope: fromBase64Url(encryptedMetadata),
                    aad: contextAad('asset-meta', `graph:${deps.graphId}`, `id:${assetId}`),
                })
                const { name } = JSON.parse(new TextDecoder().decode(plaintext)) as { name?: unknown }
                if (typeof name === 'string' && name.trim() !== '') names.set(assetId, name)
            } catch {
                // Labelled by id instead.
            }
        },
        { limit: 4 },
    )
    return names
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
