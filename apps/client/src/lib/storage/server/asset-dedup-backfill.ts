/**
 * TEMPORARY - delete once the production graphs have been scanned.
 *
 * Backfills the dedup token (ADR 0053) onto assets uploaded before the token existed. The
 * server cannot compute one: the content hash sits inside the encrypted metadata, so only a
 * key-holding client can read it, derive the token and hand it back. It runs inside the
 * orphan scan (`asset-orphans.ts`), which already lists every asset of a graph, and touches
 * only the assets the list reports as untokened and complete: a pending asset never matches
 * a lookup anyway, and re-tokening a tokened one is wasted round trips.
 *
 * Best effort by design: a failure is counted, never thrown, because the scan it rides in is
 * a safety-critical orphan check that must not be derailed by a cosmetic index.
 *
 * Removal: delete this module and its test, drop the `keyring` dependency and the backfill
 * call from `asset-orphans.ts`, the `dedupBackfill` field from `OrphanScan` and its line in
 * `OrphanAssetsSection.svelte`. The server's PATCH route and `hasDedupToken` list field can
 * stay; they are harmless.
 */

import { assetDedupToken, contextAad, deriveAssetDedupSecret, fromBase64Url, type GraphKeyring, keyForEpoch, openSymmetric } from '$lib/crypto'
import { mapWithPool } from '$lib/concurrency'
import type { SyncTokenSource } from '$lib/sync/sync-token'

export interface DedupBackfillDeps {
    graphId: string
    baseUrl: string
    syncToken: SyncTokenSource
    keyring: GraphKeyring
    fetch?: typeof fetch
}

/** The slice of the server's asset list entry the backfill reads. */
export interface BackfillCandidate {
    assetId: string
    hasDedupToken: boolean
    status: string
}

export interface DedupBackfillResult {
    /** Assets that now carry a token because of this run. */
    tokened: number
    /** Assets that could not be tokened (fetch, decrypt or PATCH failed); they are retried on the next scan. */
    failed: number
}

/** Untokened metadata blobs are fetched a few at a time; the whole run is bounded by legacy asset count, once. */
const BACKFILL_CONCURRENCY = 4

export async function backfillAssetDedupTokens(
    deps: DedupBackfillDeps,
    assets: readonly BackfillCandidate[],
): Promise<DedupBackfillResult> {
    const todo = assets.filter((a) => !a.hasDedupToken && a.status === 'complete')
    if (todo.length === 0) return { tokened: 0, failed: 0 }

    const f = deps.fetch ?? fetch
    const base = deps.baseUrl.replace(/\/$/, '')
    const headers = async () => ({ 'x-sync-token': await deps.syncToken(), 'Content-Type': 'application/json' })
    const secret = await deriveAssetDedupSecret(deps.keyring)
    let tokened = 0
    let failed = 0

    await mapWithPool(
        todo,
        async ({ assetId }) => {
            try {
                const res = await f(`${base}/api/v1/sync/assets/${deps.graphId}/${assetId}`, { headers: await headers() })
                if (!res.ok) throw new Error(`metadata fetch failed: ${res.status}`)
                const { encryptedMetadata } = (await res.json()) as { encryptedMetadata: string }
                // The same decrypt `resolveUrl` performs; the hash is what a fresh upload would
                // have hashed itself, so the token is byte-for-byte what a fresh upload sends.
                const { plaintext } = await openSymmetric({
                    keyForEpoch: (id) => keyForEpoch(deps.keyring, id),
                    envelope: fromBase64Url(encryptedMetadata),
                    aad: contextAad('asset-meta', `graph:${deps.graphId}`, `id:${assetId}`),
                })
                const { hash } = JSON.parse(new TextDecoder().decode(plaintext)) as { hash?: string }
                if (!hash) throw new Error('metadata carries no content hash')
                const dedupToken = await assetDedupToken(secret, hash)
                const patch = await f(`${base}/api/v1/sync/assets/${deps.graphId}/${assetId}`, {
                    method: 'PATCH',
                    headers: await headers(),
                    body: JSON.stringify({ dedupToken }),
                })
                if (!patch.ok) throw new Error(`token write failed: ${patch.status}`)
                tokened += 1
            } catch {
                failed += 1
            }
        },
        { limit: BACKFILL_CONCURRENCY },
    )
    return { tokened, failed }
}
