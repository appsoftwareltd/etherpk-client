/**
 * The check a [[Server Backend]] graph passes before an [[Asset]]'s bytes are destroyed
 * (ADR 0054): is this device provably holding every reference that exists?
 *
 * It has to be asked because the [[Sync Server]] cannot answer it. Documents are ciphertext to
 * it (ADR 0024), so no server-side reference count is possible, ever — the only client that can
 * count is one whose replica is current. A reference another [[Member]] added five seconds ago
 * is invisible here until it arrives, and destroying bytes on the strength of a stale replica
 * breaks their document with no way back.
 *
 * What makes this cheap enough to run on a click is `docsNeedingCatchup`: a **watermark diff**,
 * comparing the local cache's `lastSeq` per document against the relay's, batched. No document
 * is materialised and no text is read — a graph of a few thousand documents is a handful of
 * requests. That is the whole reason the count itself comes from the [[Derived Index]] rather
 * than from a walk (see the ADR): the expensive part was never the proof, it was the reading.
 *
 * Narrow structural dependency rather than the whole `GraphSync`, so the rule is testable
 * without a relay.
 */

import type { AssetByteReadiness } from '$lib/document/asset-delete'

export interface AssetByteReadinessDeps {
    /** Whether the relay socket is open right now. */
    isConnected(): boolean
    /** The graph's document registry — every document, including ones never materialised here. */
    registry(): { forEach(visit: (entry: unknown, docId: string) => void): void }
    /** Which of `docIds` this device is behind on. A watermark diff, not a materialisation. */
    docsNeedingCatchup(docIds: readonly string[]): Promise<string[]>
}

export async function serverAssetByteReadiness(deps: AssetByteReadinessDeps): Promise<AssetByteReadiness> {
    // Offline is not "probably fine": it is the state in which unseen references are most likely.
    if (!deps.isConnected()) return { ready: false, reason: 'offline' }

    const docIds: string[] = []
    deps.registry().forEach((_entry, docId) => docIds.push(docId))
    // Every document in the registry, not just the ones open or materialised — a reference can
    // live in a document this device has never opened.
    const behind = await deps.docsNeedingCatchup(docIds)
    return behind.length === 0 ? { ready: true } : { ready: false, reason: 'behind' }
}
