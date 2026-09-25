/**
 * The [[Recents]] store: the [[Document]]s most recently opened **on this device**, deduped
 * and most-recent-first.
 *
 * Per-device, per-graph, localStorage - deliberately the same shape of home as
 * `reading-positions.ts` and `layout/store.ts` (ADR 0013): never synced, never exported, so
 * one [[Player]]'s browsing never reorders another's Sidebar (ADR 0036 §3). Zod-validated;
 * corrupt or incompatible payloads degrade to empty rather than throwing.
 *
 * A deduped projection of [[Visit]]s, not a list of them: two visits to the same document
 * yield one row, moved to the front. Today's [[Journal Entry]] is deliberately NOT
 * special-cased - it takes a slot like anything else.
 *
 * How many are *shown* is a [[Graph Settings|Graph Setting]] and lives elsewhere; this store
 * keeps a deeper history so raising the setting immediately has something to show.
 */

import { z } from 'zod'

export const RECENTS_KEY_PREFIX = 'etherpk-recents:'
const VERSION = 1
/** Kept well above any sane `recentDocumentCount`, so raising the setting reveals real history. */
const MAX_ENTRIES = 100

const payloadSchema = z.object({
    version: z.number(),
    /** Concepts, most-recent-first. */
    recents: z.array(z.string()),
})

export interface RecentsStore {
    /** Concepts, most-recent-first. `limit` omitted ⇒ everything retained. */
    list(limit?: number): string[]
    /** Record that a document became active. Moves it to the front; never duplicates. */
    touch(concept: string): void
    /** Drop one entry (a document that turned out not to exist, say). */
    forget(concept: string): void
    /** Follow a rename, so a renamed document keeps its place rather than vanishing. */
    rename(from: string, to: string): void
    subscribe(listener: (recents: string[]) => void): () => void
}

export function createRecents(
    graphId: string,
    storage: Storage | undefined = globalThis.localStorage,
): RecentsStore {
    const key = `${RECENTS_KEY_PREFIX}${graphId}`
    const listeners = new Set<(recents: string[]) => void>()
    let recents: string[] = load()

    function load(): string[] {
        const raw = storage?.getItem(key)
        if (!raw) return []
        try {
            const parsed = payloadSchema.safeParse(JSON.parse(raw))
            if (!parsed.success || parsed.data.version !== VERSION) return []
            return parsed.data.recents.slice(0, MAX_ENTRIES)
        } catch {
            return []
        }
    }

    function save(): void {
        // Best-effort: a full or unavailable quota must never break navigation, which is
        // what recording a Recent is a side-effect of.
        try {
            storage?.setItem(key, JSON.stringify({ version: VERSION, recents }))
        } catch {
            /* storage full or blocked - the in-memory list still works this session */
        }
    }

    function commit(next: string[]): void {
        recents = next.slice(0, MAX_ENTRIES)
        save()
        const snapshot = [...recents]
        for (const listener of listeners) listener(snapshot)
    }

    return {
        list(limit) {
            return limit === undefined ? [...recents] : recents.slice(0, Math.max(0, limit))
        },
        touch(concept) {
            const trimmed = concept.trim()
            if (trimmed === '') return
            const lower = trimmed.toLowerCase()
            // Already at the front: nothing changes, so do not churn storage or listeners
            // (this fires on every active-view change, including re-focusing the same tab).
            if (recents[0]?.toLowerCase() === lower) return
            commit([trimmed, ...recents.filter((c) => c.toLowerCase() !== lower)])
        },
        forget(concept) {
            const lower = concept.trim().toLowerCase()
            if (!recents.some((c) => c.toLowerCase() === lower)) return
            commit(recents.filter((c) => c.toLowerCase() !== lower))
        },
        rename(from, to) {
            const lower = from.trim().toLowerCase()
            if (!recents.some((c) => c.toLowerCase() === lower)) return
            const next = to.trim()
            // Renaming onto a concept already present would duplicate it.
            const deduped = recents.filter((c) => c.toLowerCase() !== next.toLowerCase() || c.toLowerCase() === lower)
            commit(deduped.map((c) => (c.toLowerCase() === lower ? next : c)))
        },
        subscribe(listener) {
            listeners.add(listener)
            listener([...recents])
            return () => listeners.delete(listener)
        },
    }
}
