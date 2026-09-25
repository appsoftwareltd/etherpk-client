/**
 * The **Reading Position** store: the latest scroll+caret per View, so a reload
 * (or a history fallback) reopens each document where the user left off.
 * Per-device, per-graph, localStorage — deliberately the same shape of home as
 * `layout/store.ts` (ADR 0013: never synced, never exported). Zod-validated;
 * corrupt or incompatible payloads degrade to empty, never throw.
 */

import { z } from 'zod'

import type { ViewPosition } from './position'

export const READING_POSITIONS_KEY_PREFIX = 'etherpk-positions:'
const VERSION = 1
/** Recency-capped so abandoned documents cannot grow the payload unboundedly. */
const MAX_ENTRIES = 200
const SAVE_DEBOUNCE_MS = 300

const entrySchema = z.object({
    scrollTop: z.number(),
    anchor: z.number(),
    head: z.number(),
    /** Last-update stamp, for recency eviction. */
    at: z.number(),
})

const payloadSchema = z.object({
    version: z.number(),
    positions: z.record(z.string(), entrySchema),
})

type Entry = z.infer<typeof entrySchema>

export interface ReadingPositionStore {
    get(viewKey: string): ViewPosition | null
    set(viewKey: string, position: ViewPosition): void
    /** Write any pending debounced save now (teardown). */
    flush(): void
}

export function createReadingPositions(
    graphId: string,
    storage: Storage | undefined = globalThis.localStorage,
): ReadingPositionStore {
    if (!storage) throw new Error('createReadingPositions: no Storage available')
    const key = `${READING_POSITIONS_KEY_PREFIX}${graphId}`

    const positions = new Map<string, Entry>(Object.entries(load()))
    let saveTimer: ReturnType<typeof setTimeout> | undefined

    function load(): Record<string, Entry> {
        const raw = storage!.getItem(key)
        if (raw === null) return {}
        try {
            const parsed = payloadSchema.safeParse(JSON.parse(raw))
            if (!parsed.success || parsed.data.version !== VERSION) return {}
            return parsed.data.positions
        } catch {
            return {}
        }
    }

    function save(): void {
        saveTimer = undefined
        storage!.setItem(
            key,
            JSON.stringify({ version: VERSION, positions: Object.fromEntries(positions) }),
        )
    }

    function scheduleSave(): void {
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS)
    }

    return {
        get(viewKey) {
            const entry = positions.get(viewKey)
            return entry
                ? { scrollTop: entry.scrollTop, anchor: entry.anchor, head: entry.head }
                : null
        },
        set(viewKey, position) {
            positions.set(viewKey, { ...position, at: Date.now() })
            if (positions.size > MAX_ENTRIES) {
                const oldest = [...positions.entries()].sort((a, b) => a[1].at - b[1].at)
                for (const [k] of oldest.slice(0, positions.size - MAX_ENTRIES)) {
                    positions.delete(k)
                }
            }
            scheduleSave()
        },
        flush() {
            if (saveTimer) {
                clearTimeout(saveTimer)
                save()
            }
        },
    }
}
