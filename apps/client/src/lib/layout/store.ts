/**
 * Layout persistence: `LocalLayoutStore`, backed by `localStorage` and keyed per
 * knowledge graph. Layout is **per-device (client-local) and never syncs** — its
 * geometry is device-shaped (ADR 0013), so this is its permanent home, not a v1
 * placeholder. Works in both local and sync mode; migratable to IndexedDB as
 * Layouts grow.
 *
 * Every load is validated through {@link parseSerializedLayout}, so a corrupt
 * or incompatible-version payload resolves to `null` — the controller then
 * falls back to `defaultLayout()` rather than crashing or partially migrating.
 */

import { parseSerializedLayout } from './serialization'
import type { LayoutStore, SerializedLayout } from './types'

/** Storage key prefix; the graph id is appended. */
export const LOCAL_LAYOUT_KEY_PREFIX = 'etherpk-layout:'

function keyFor(graphId: string): string {
    return `${LOCAL_LAYOUT_KEY_PREFIX}${graphId}`
}

/**
 * Create a {@link LayoutStore} over a `Storage` (defaults to
 * `globalThis.localStorage`). Injecting the storage keeps it unit-testable
 * outside a browser.
 */
export function createLocalLayoutStore(
    storage: Storage | undefined = globalThis.localStorage,
): LayoutStore {
    if (!storage) {
        throw new Error('createLocalLayoutStore: no Storage available (call from the browser)')
    }

    return {
        async load(graphId) {
            const raw = storage.getItem(keyFor(graphId))
            if (raw === null) return null
            let parsed: unknown
            try {
                parsed = JSON.parse(raw)
            } catch {
                return null // corrupt JSON → treat as absent
            }
            return parseSerializedLayout(parsed)
        },

        async save(graphId, layout: SerializedLayout) {
            storage.setItem(keyFor(graphId), JSON.stringify(layout))
        },

        async clear(graphId) {
            storage.removeItem(keyFor(graphId))
        },
    }
}
