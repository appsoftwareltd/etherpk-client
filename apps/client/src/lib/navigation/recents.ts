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

/** A PDF in the list. An object, as a concept may be called anything, so no string could stand for one. */
const recentPdfSchema = z.object({ target: z.string(), name: z.string() })
export type RecentPdf = z.infer<typeof recentPdfSchema>
/** A document by its concept, or a PDF. */
export type RecentEntry = string | RecentPdf

const payloadSchema = z.object({
    version: z.number(),
    /** Most-recent-first. */
    recents: z.array(z.union([z.string(), recentPdfSchema])),
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
    /** Documents and PDFs, most-recent-first. */
    entries(limit?: number): RecentEntry[]
    /** A PDF became active. */
    touchPdf(target: string, name: string): void
    /** A PDF tab came to the front: moved to the front if it is listed. Its name is not known here. */
    touchKnownPdf(target: string): void
    forgetPdf(target: string): void
    renamePdf(from: string, to: string, name: string): void
    subscribeEntries(listener: (entries: RecentEntry[]) => void): () => void
}

export function createRecents(
    graphId: string,
    storage: Storage | undefined = globalThis.localStorage,
): RecentsStore {
    const key = `${RECENTS_KEY_PREFIX}${graphId}`
    const listeners = new Set<(recents: string[]) => void>()
    const entryListeners = new Set<(entries: RecentEntry[]) => void>()
    /** Documents and PDFs together, because together they have one order. */
    let all: RecentEntry[] = load()
    const documents = () => all.filter((entry): entry is string => typeof entry === 'string')
    /** The documents' part of the list, as the callers that deal in concepts read it. */
    let recents: string[] = documents()

    function load(): RecentEntry[] {
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
            storage?.setItem(key, JSON.stringify({ version: VERSION, recents: all }))
        } catch {
            /* storage full or blocked - the in-memory list still works this session */
        }
    }

    function commitAll(next: RecentEntry[]): void {
        all = next.slice(0, MAX_ENTRIES)
        recents = documents()
        save()
        const snapshot = [...recents]
        for (const listener of listeners) listener(snapshot)
        const entries = [...all]
        for (const listener of entryListeners) listener(entries)
    }

    const isPdf = (entry: RecentEntry, target: string) => typeof entry !== 'string' && entry.target === target

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
            const first = all[0]
            if (typeof first === 'string' && first.toLowerCase() === lower) return
            commitAll([trimmed, ...all.filter((entry) => typeof entry !== 'string' || entry.toLowerCase() !== lower)])
        },
        forget(concept) {
            const lower = concept.trim().toLowerCase()
            if (!recents.some((c) => c.toLowerCase() === lower)) return
            commitAll(all.filter((entry) => typeof entry !== 'string' || entry.toLowerCase() !== lower))
        },
        rename(from, to) {
            const lower = from.trim().toLowerCase()
            if (!recents.some((c) => c.toLowerCase() === lower)) return
            const next = to.trim()
            // Renaming onto a concept already present would duplicate it.
            const deduped = all.filter((entry) => typeof entry !== 'string' || entry.toLowerCase() !== next.toLowerCase() || entry.toLowerCase() === lower)
            commitAll(deduped.map((entry) => (typeof entry === 'string' && entry.toLowerCase() === lower ? next : entry)))
        },
        subscribe(listener) {
            listeners.add(listener)
            listener([...recents])
            return () => listeners.delete(listener)
        },
        entries(limit) {
            return limit === undefined ? [...all] : all.slice(0, Math.max(0, limit))
        },
        touchPdf(target, name) {
            const first = all[0]
            if (first !== undefined && isPdf(first, target) && (first as RecentPdf).name === name) return
            commitAll([{ target, name }, ...all.filter((entry) => !isPdf(entry, target))])
        },
        touchKnownPdf(target) {
            const held = all.find((entry) => isPdf(entry, target))
            if (held && all[0] !== held) commitAll([held, ...all.filter((entry) => entry !== held)])
        },
        forgetPdf(target) {
            if (all.some((entry) => isPdf(entry, target))) commitAll(all.filter((entry) => !isPdf(entry, target)))
        },
        renamePdf(from, to, name) {
            if (all.some((entry) => isPdf(entry, from))) commitAll(all.map((entry) => (isPdf(entry, from) ? { target: to, name } : entry)))
        },
        subscribeEntries(listener) {
            entryListeners.add(listener)
            listener([...all])
            return () => entryListeners.delete(listener)
        },
    }
}
