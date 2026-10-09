/**
 * What one device remembers about its Map Blocks: which are folded (ADR 0118). Never written into
 * the document and never synced, because folding is how this person reads the page on this device,
 * like a Kanban Board's collapsed lanes (`kanban/board-state.ts`).
 *
 * A Map Block is known by its graph, its document and its own text, so a map keeps its fold however
 * many maps are added, moved or deleted round it, and an undo that brings it back brings its fold
 * back. A change to a map's text, or a rename of its document, unfolds it, which loses nothing, and
 * two maps with the same text in one document fold together. A map put in by `/map` starts open:
 * the fold of an empty map in its document is let go first (`map-commands.ts`). Until 2026-10-09 a
 * map was known by how many maps came before it, so a map put in above a folded one took that
 * fold, and the folded map took the next one's.
 *
 * The editor reads the memory for the room it keeps for each map, and the map for whether it shows
 * folded, so the memory tells its listeners of every change and the two never disagree.
 */
import type { InteractiveFenceInfo } from '$lib/document/view/augmentations/interactive-fence-contract'

const PREFIX = 'etherpk-map-folded'

/** The parts of `Storage` the memory uses, so a test can hand it a plain object. */
export type MapBlockStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** A map as the memory knows it: its document and its text. */
export type RememberedMap = Pick<InteractiveFenceInfo, 'document' | 'body'>

export interface MapBlockMemory {
    folded(map: RememberedMap): boolean
    setFolded(map: RememberedMap, folded: boolean): void
    /** Hear every fold or unfold this memory records. Returns the way to stop. */
    subscribe(listener: () => void): () => void
}

/** A short fingerprint of a map's text, FNV-1a over its lines, as eight hex digits. */
export function textFingerprint(body: readonly string[]): string {
    let hash = 0x811c9dc5
    const text = body.join('\n')
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}

/** A memory over `storage` (the browser's `localStorage`, or none outside one) for one graph. */
export function createMapBlockMemory(graphId: string, storage: MapBlockStorage | null): MapBlockMemory {
    const key = (map: RememberedMap) => `${PREFIX}:${graphId}:${map.document ?? ''}:${textFingerprint(map.body)}`
    /**
     * This page's folds, which stand where the device keeps none: no storage, storage refused (a
     * private window, a full quota), or an editor outside any document. They last until the page reloads.
     */
    const session = new Map<string, boolean>()
    const listeners = new Set<() => void>()
    return {
        folded(map) {
            const known = session.get(key(map))
            if (known !== undefined) return known
            if (!storage || map.document === null) return false
            try {
                return storage.getItem(key(map)) === '1'
            } catch {
                return false
            }
        },
        setFolded(map, folded) {
            session.set(key(map), folded)
            if (storage && map.document !== null) {
                try {
                    if (folded) storage.setItem(key(map), '1')
                    else storage.removeItem(key(map))
                } catch {
                    // Storage refused: the fold lasts until the page reloads, in `session`.
                }
            }
            for (const listener of listeners) listener()
        },
        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
    }
}

/** The browser's `localStorage`, or null where reading it throws (a sandboxed frame, Node). */
export function browserStorage(): MapBlockStorage | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage
    } catch {
        return null
    }
}
