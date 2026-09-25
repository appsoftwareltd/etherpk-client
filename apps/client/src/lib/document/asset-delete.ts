/**
 * The rule that decides what a trash click on an [[Asset Reference]] is allowed to do
 * (ADR 0054): remove the reference and destroy the bytes, or remove the reference alone.
 *
 * **Removing a reference is always safe** — it destroys nothing. Destroying the bytes needs
 * evidence, and the evidence has to hold for the whole [[Knowledge Graph]], not just the
 * document in front of the user:
 *
 *  1. the [[Derived Index]] can answer at all (a cold graph mid-build cannot),
 *  2. it reports no OTHER reference anywhere, and
 *  3. on a [[Server Backend]], this device is provably at the relay's head — otherwise a
 *     reference another [[Member]] added may simply not have arrived yet.
 *
 * Each check is asked only when the ones before it passed: a reference used in three
 * documents never costs a round trip to the relay to learn what it already knows.
 *
 * Pure over injected answers, so the policy is unit-tested without an index, a socket, or a
 * mounted editor. The Command wires the real ones.
 */

import type { AssetUsage, AssetUsageDocument } from './index-db'

/** Why the bytes are staying, when they are. */
export type AssetDeleteBlock =
    /** Another reference exists. The one case the user can act on: go and clear the others. */
    | 'used-elsewhere'
    /** The index has not finished deriving this graph, so it cannot be asked. */
    | 'index-building'
    /** A Server graph with no live relay connection: unseen references cannot be ruled out. */
    | 'offline'
    /** A Server graph whose replica is behind the relay for at least one document. */
    | 'behind'

export interface AssetDeletePlan {
    /** True when this delete may destroy the bytes as well as the reference. */
    deleteBytes: boolean
    /** Why not, when `deleteBytes` is false. */
    blockedBy?: AssetDeleteBlock
    /** Documents referencing this asset, concept-ordered. Empty when the count is unavailable. */
    documents: AssetUsageDocument[]
    /** References across the graph, including the one being removed. */
    references: number
}

/** Whether a [[Server Backend]] graph may destroy bytes right now. Always ready on a filesystem graph. */
export type AssetByteReadiness = { ready: true } | { ready: false; reason: 'offline' | 'behind' }

export interface AssetDeleteInputs {
    /** Count references, or `null` when the index cannot answer yet. */
    usage: () => Promise<AssetUsage | null>
    /** Ask only once the count says this is the last reference — it costs a round trip. */
    readiness: () => Promise<AssetByteReadiness>
}

/**
 * A count of zero is treated exactly like a count of one. Standing on a reference the index has
 * not ingested yet is ordinary — paste an image, change your mind, trash it, all inside the
 * index's debounce — and in both cases the count says the same thing that matters here: no
 * OTHER document holds this asset.
 */
export async function planAssetDelete(inputs: AssetDeleteInputs): Promise<AssetDeletePlan> {
    const usage = await inputs.usage()
    if (!usage) return { deleteBytes: false, blockedBy: 'index-building', documents: [], references: 0 }

    const found = { documents: usage.documents, references: usage.references }
    if (usage.references > 1) return { deleteBytes: false, blockedBy: 'used-elsewhere', ...found }

    const readiness = await inputs.readiness()
    if (!readiness.ready) return { deleteBytes: false, blockedBy: readiness.reason, ...found }

    return { deleteBytes: true, ...found }
}

/**
 * The forms an asset's identity can appear as in document text. The identities both backends
 * mint need no encoding — a kebab slug plus hex, or a uuid — but an asset carried in by
 * [[Import]] can, and a reference is written percent-encoded when it does. Both are checked,
 * for the same reason the [[Orphaned Asset]] scanners check both: a missed match here costs data.
 */
export function assetUsageNeedles(assetId: string): string[] {
    const encoded = encodeURIComponent(assetId)
    return encoded === assetId ? [assetId] : [assetId, encoded]
}
