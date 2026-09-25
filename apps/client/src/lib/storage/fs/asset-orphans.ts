/**
 * Orphaned-asset detection for a Filesystem-Backend graph: an [[Asset]] file under
 * `assets/` that no journal or page references. Detection is deliberately conservative -
 * an asset counts as referenced if its file name appears ANYWHERE in any document's text
 * (fences and plain prose included, percent-encoded or not) - deletion must never break
 * a reference, so we over-count references rather than over-delete.
 *
 * Pure over the {@link DirectoryAdapter} seam, Node-testable over the in-memory fake.
 */

import type { AssetByteReadiness } from '$lib/document/asset-delete'

import { assetNameFromRef } from './asset-store'
import type { DirectoryAdapter, Subdir } from './directory-adapter'

/** One orphan candidate. `id` is what `deleteOrphanedAssets` consumes; `label` is for display. */
export interface OrphanedAsset {
    id: string
    label: string
    /** Bytes, when the backend knows it (server assets do; filesystem entries do not). */
    size?: number
}

export interface OrphanScan {
    orphans: OrphanedAsset[]
    totalAssets: number
    scannedDocuments: number
    /**
     * TEMPORARY (ADR 0053): what the ride-along dedup-token backfill did on a synced graph.
     * Absent on a filesystem graph. Delete with `storage/server/asset-dedup-backfill.ts`.
     */
    dedupBackfill?: { tokened: number; failed: number }
}

/**
 * The backend-agnostic asset operations the app performs on a whole [[Knowledge Graph]]: the
 * workspace builds it over this module (filesystem) or over storage/server/asset-orphans
 * (synced). Absent when assets are unavailable (the dev gate, or a dialog opened outside an
 * open graph).
 *
 * `scan`/`remove` are the Graph Settings dialog's [[Orphaned Asset]] pair. `identify` and
 * `readyToDeleteBytes` serve the in-document delete (ADR 0054), which deliberately reuses
 * `remove` for the destructive step rather than growing a second way to destroy bytes.
 */
export interface GraphAssetTools {
    scan(): Promise<OrphanScan>
    remove(ids: string[]): Promise<number>
    /**
     * The [[Asset]] identity an [[Asset Reference]] names, or `null` when it names none (a
     * remote image, a wikilink). This is what `remove` takes and what document text is searched
     * for, and the two backends disagree on what it is: a filesystem graph's identity is the
     * file name, a synced graph's is the random asset id inside the reference.
     */
    identify(ref: string): string | null
    /** Whether an asset's bytes may be destroyed right now. See ADR 0054. */
    readyToDeleteBytes(): Promise<AssetByteReadiness>
}

const DOCUMENT_SUBDIRS: Subdir[] = ['journals', 'pages']

export async function scanOrphanedAssets(adapter: DirectoryAdapter): Promise<OrphanScan> {
    const assets = await adapter.list('assets')
    if (assets.length === 0) return { orphans: [], totalAssets: 0, scannedDocuments: 0 }

    const texts: string[] = []
    for (const subdir of DOCUMENT_SUBDIRS) {
        for (const { name } of await adapter.list(subdir)) {
            if (!/\.md$/i.test(name)) continue
            texts.push((await adapter.read(subdir, name)).text)
        }
    }

    const referenced = (name: string) =>
        texts.some((t) => t.includes(name) || t.includes(encodeURIComponent(name)))
    return {
        orphans: assets
            .filter(({ name }) => !referenced(name))
            .map(({ name }) => ({ id: name, label: name })),
        totalAssets: assets.length,
        scannedDocuments: texts.length,
    }
}

/**
 * A filesystem graph is always ready to destroy bytes: there is no relay to be behind, and the
 * files are right there. The Filesystem Backend directory is user-managed (ADR 0007), so a
 * reference typed into it by another editor is invisible until `reconcile()` runs — the same
 * exposure the [[Orphaned Asset]] scan has always carried, and not one a check here could close.
 */
export function filesystemAssetTools(adapter: DirectoryAdapter): GraphAssetTools {
    return {
        scan: () => scanOrphanedAssets(adapter),
        remove: (ids) => deleteOrphanedAssets(adapter, ids),
        identify: (ref) => assetNameFromRef(ref),
        readyToDeleteBytes: async () => ({ ready: true }),
    }
}

/** Remove the given asset files. Returns the number actually removed. */
export async function deleteOrphanedAssets(adapter: DirectoryAdapter, ids: string[]): Promise<number> {
    let removed = 0
    for (const id of ids) {
        if (await adapter.exists('assets', id)) {
            await adapter.remove('assets', id)
            removed += 1
        }
    }
    return removed
}
