/**
 * The rule that decides what a trash click on an [[Asset Reference]] is allowed to do
 * (ADR 0054): remove the reference and destroy the bytes, or remove the reference alone.
 *
 * **Removing a reference is always safe** — it destroys nothing. Destroying the bytes needs
 * evidence, and the evidence has to hold for the whole [[Knowledge Graph]], not just the
 * document in front of the user:
 *
 *  1. the [[Derived Index]] can answer at all (a cold graph mid-build cannot),
 *  2. it reports no OTHER reference anywhere,
 *  3. no [[Protected Document]] holds one either. The index never holds a protected document,
 *     so each is read on its own, decrypted, while the graph is unlocked; one that cannot be
 *     read keeps the bytes, because it may still show the image (reused there by dedup, or
 *     pasted in), and
 *  4. on a [[Server Backend]], this device is provably at the relay's head — otherwise a
 *     reference another [[Member]] added may simply not have arrived yet.
 *
 * Each check is asked only when the ones before it passed: a reference used in three
 * documents never costs a round trip to the relay to learn what it already knows.
 *
 * Pure over injected answers, so the policy is unit-tested without an index, a socket, or a
 * mounted editor. The Command wires the real ones.
 */

import type { DocumentKind } from '$lib/storage'

import type { AssetUsage, AssetUsageDocument } from './index-db'
import { containsCipherFence } from './protection/fence-info'

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
    /**
     * A [[Protected Document]] could not be read (locked, or another member's protection), so a
     * reference inside it cannot be ruled out. Unlocking is the route forward when it is ours.
     */
    | 'protected-unread'

export interface AssetDeletePlan {
    /** True when this delete may destroy the bytes as well as the reference. */
    deleteBytes: boolean
    /** Why not, when `deleteBytes` is false. */
    blockedBy?: AssetDeleteBlock
    /** Documents referencing this asset, concept-ordered. Empty when the count is unavailable. */
    documents: AssetUsageDocument[]
    /** References across the graph, including the one being removed. */
    references: number
    /** With `protected-unread`: how many protected documents went unread. */
    unreadProtected?: number
}

/** What the [[Protected Document]]s hold, read one by one: the index never holds them. */
export type ProtectedAssetUsage =
    | { readable: true; references: number; documents: AssetUsageDocument[] }
    | { readable: false; unreadable: number }

/** Whether a [[Server Backend]] graph may destroy bytes right now. Always ready on a filesystem graph. */
export type AssetByteReadiness = { ready: true } | { ready: false; reason: 'offline' | 'behind' }

export interface AssetDeleteInputs {
    /** Count references, or `null` when the index cannot answer yet. */
    usage: () => Promise<AssetUsage | null>
    /**
     * References inside protected documents. Asked only once the index count says this is the
     * last reference, because it decrypts. Absent where a graph cannot hold protected content.
     */
    protectedUsage?: () => Promise<ProtectedAssetUsage>
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

    let found = { documents: usage.documents, references: usage.references }
    if (usage.references > 1) return { deleteBytes: false, blockedBy: 'used-elsewhere', ...found }

    if (inputs.protectedUsage) {
        const hidden = await inputs.protectedUsage()
        if (!hidden.readable) return { deleteBytes: false, blockedBy: 'protected-unread', unreadProtected: hidden.unreadable, ...found }
        // Summed, not maxed: standing on a reference in an ordinary page, one more in a protected
        // page is another use; standing inside a protected page, the index has none and the
        // document's own plaintext holds the one being removed.
        found = { documents: [...found.documents, ...hidden.documents], references: found.references + hidden.references }
        if (found.references > 1) return { deleteBytes: false, blockedBy: 'used-elsewhere', ...found }
    }

    const readiness = await inputs.readiness()
    if (!readiness.ready) return { deleteBytes: false, blockedBy: readiness.reason, ...found }

    return { deleteBytes: true, ...found }
}

/** Occurrences of any needle in `text`, each needle counted separately and non-overlapping. */
function occurrencesOf(text: string, needles: readonly string[]): number {
    let n = 0
    for (const needle of needles) {
        for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) n += 1
    }
    return n
}

/**
 * References to an asset inside the documents the [[Derived Index]] flags as protected, which it
 * holds no text of. Each document's stored text is read as a batch, without opening it, and:
 *
 * - holding a cipher fence, it goes through `readProtected` (the plaintext of its fences, or null
 *   when this device cannot read it now), and only that plaintext is searched: the rest of the
 *   text is in the index's blocks and already counted;
 * - holding text but no fence, it is plaintext the index has not caught up with (protection was
 *   just removed), and it is searched as it is;
 * - empty, or not read at all, it is unread. The index says it holds protected content, so an
 *   empty answer is a failed read or a document still arriving, never "no references".
 *
 * Any unread document makes the whole answer unreadable: the caller keeps the bytes.
 */
export async function protectedAssetUsage(
    documents: readonly { concept: string; kind: DocumentKind }[],
    needles: readonly string[],
    deps: {
        /**
         * Commits pending protected edits first: the projection encrypts on a debounce, so an
         * image pasted into a protected page moments ago is otherwise not in its stored text.
         */
        settle?: () => Promise<void>
        /** Each concept's stored text, or null when it could not be read and confirmed current. */
        readStored(concepts: readonly string[]): Promise<ReadonlyMap<string, string | null>>
        readProtected?: (text: string) => Promise<string | null>
    },
): Promise<ProtectedAssetUsage> {
    if (documents.length === 0) return { readable: true, references: 0, documents: [] }
    const found: AssetUsageDocument[] = []
    let references = 0
    let unreadable = 0
    const distinct = [...new Set(needles)].filter((n) => n.length > 0)
    await deps.settle?.()
    const stored = await deps.readStored(documents.map((d) => d.concept)).catch(() => new Map<string, string | null>())
    for (const { concept, kind } of documents) {
        const text = stored.get(concept) ?? null
        let searched: string | null = null
        if (text !== null && text.trim() !== '') {
            searched = containsCipherFence(text) ? (deps.readProtected ? await deps.readProtected(text).catch(() => null) : null) : text
        }
        if (searched === null) {
            unreadable += 1
            continue
        }
        const n = occurrencesOf(searched, distinct)
        if (n === 0) continue
        references += n
        found.push({ concept, kind, references: n })
    }
    return unreadable > 0 ? { readable: false, unreadable } : { readable: true, references, documents: found }
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
