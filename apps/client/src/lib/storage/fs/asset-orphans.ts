/**
 * Orphaned-asset detection for a Filesystem-Backend graph: an [[Asset]] file under
 * `assets/` that no journal or page references. Detection is deliberately conservative -
 * an asset counts as referenced if its file name appears ANYWHERE in any document's text
 * (fences and plain prose included, percent-encoded or not) - deletion must never break
 * a reference, so we over-count references rather than over-delete.
 *
 * A [[Protected Document]]'s text is ciphertext, so the same search cannot see a reference inside
 * one. Such a document is read through a {@link ProtectedTextReader} when the graph is unlocked;
 * when any one of them cannot be read, no asset is offered at all ({@link orphanScanOf}), because
 * deleting an asset is permanent.
 *
 * Pure over the {@link DirectoryAdapter} seam, Node-testable over the in-memory fake. The
 * reference test and the protected-document rule are shared with the synced graph's scanner
 * (storage/server/asset-orphans.ts), so the two backends cannot disagree about either.
 */

import type { AssetByteReadiness } from '$lib/document/asset-delete'
import { containsCipherFence } from '$lib/document/protection/fence-info'
import type { ProtectedTextReader } from '$lib/document/protection/protected-text-reader'

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
    /**
     * Present when some document could not be read. `assets` is how many looked unused to what the
     * scan could read; none of them is in `orphans`, because any of them may be used inside the
     * unread documents.
     */
    withheld?: {
        assets: number
        /** [[Protected Document]]s the scan could not read: locked, or protected by another member. */
        protectedDocuments: number
        /** Other documents whose text could not be read at all: its key is unavailable, or it will not decrypt. */
        unreadableDocuments: number
        /**
         * Whether the scan had the graph's protection session to read with, so that unlocking and
         * scanning again can help. False where none is open, such as the Graphs page's settings.
         */
        unlockable: boolean
    }
}

/**
 * What a reference test searches: every document's stored text, plus the plaintext of each
 * [[Protected Document]] this device can read now. Any cipher fence counts, not only a whole-body
 * one: a fence left beside other text after a merge still holds ciphertext that may name an
 * asset. `unreadableProtected` counts the documents holding a fence that could not be read.
 */
export async function referenceTexts(
    stored: readonly string[],
    readProtected?: ProtectedTextReader,
): Promise<{ texts: string[]; unreadableProtected: number }> {
    const texts: string[] = []
    let unreadableProtected = 0
    for (const text of stored) {
        // The stored text always goes in: a protected document's frontmatter is in the clear.
        texts.push(text)
        if (!containsCipherFence(text)) continue
        const plaintext = readProtected ? await readProtected(text).catch(() => null) : null
        if (plaintext === null) unreadableProtected += 1
        else texts.push(plaintext)
    }
    return { texts, unreadableProtected }
}

/**
 * An asset counts as referenced if any of its identity's forms appears anywhere in any text:
 * as written, or percent-encoded (the editor encodes spaces in a reference).
 */
export function isReferenced(texts: readonly string[], identity: string): boolean {
    const encoded = encodeURIComponent(identity)
    return texts.some((t) => t.includes(identity) || (encoded !== identity && t.includes(encoded)))
}

/**
 * The scan's answer from what looked unused. While a protected document went unread nothing is
 * offered: a scan cannot prove an asset unused from text it could not see, and deletion is
 * permanent.
 */
export function orphanScanOf(
    candidates: OrphanedAsset[],
    counts: { totalAssets: number; scannedDocuments: number; unreadableProtected: number; unreadableOther?: number; unlockable: boolean },
): OrphanScan {
    const { totalAssets, scannedDocuments, unreadableProtected, unlockable } = counts
    const unreadableOther = counts.unreadableOther ?? 0
    if (unreadableProtected === 0 && unreadableOther === 0) return { orphans: candidates, totalAssets, scannedDocuments }
    return {
        orphans: [],
        totalAssets,
        scannedDocuments,
        withheld: { assets: candidates.length, protectedDocuments: unreadableProtected, unreadableDocuments: unreadableOther, unlockable },
    }
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

export interface FilesystemAssetToolOptions {
    /** Reads a Protected Document's plaintext while the graph is unlocked; absent, none is read. */
    readProtected?: ProtectedTextReader
    /**
     * Brings pending edits to the folder before the scan reads it: a protected document's
     * projection encrypts on a debounce, and every buffer autosaves on one, so a reference added
     * moments ago is otherwise not in any file yet.
     */
    settle?: () => Promise<void>
}

export async function scanOrphanedAssets(adapter: DirectoryAdapter, options: FilesystemAssetToolOptions = {}): Promise<OrphanScan> {
    const assets = await adapter.list('assets')
    if (assets.length === 0) return { orphans: [], totalAssets: 0, scannedDocuments: 0 }

    await options.settle?.()
    const stored: string[] = []
    for (const subdir of DOCUMENT_SUBDIRS) {
        for (const { name } of await adapter.list(subdir)) {
            if (!/\.md$/i.test(name)) continue
            stored.push((await adapter.read(subdir, name)).text)
        }
    }

    const { texts, unreadableProtected } = await referenceTexts(stored, options.readProtected)
    const candidates = assets.filter(({ name }) => !isReferenced(texts, name)).map(({ name }) => ({ id: name, label: name }))
    return orphanScanOf(candidates, {
        totalAssets: assets.length,
        scannedDocuments: stored.length,
        unreadableProtected,
        unlockable: options.readProtected !== undefined,
    })
}

/**
 * A filesystem graph is always ready to destroy bytes: there is no relay to be behind, and the
 * files are right there. The Filesystem Backend directory is user-managed (ADR 0007), so a
 * reference typed into it by another editor is invisible until `reconcile()` runs — the same
 * exposure the [[Orphaned Asset]] scan has always carried, and not one a check here could close.
 */
export function filesystemAssetTools(adapter: DirectoryAdapter, options: FilesystemAssetToolOptions = {}): GraphAssetTools {
    return {
        scan: () => scanOrphanedAssets(adapter, options),
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
