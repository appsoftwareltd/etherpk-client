/**
 * The live graph index: keeps a {@link BacklinkIndex} current for one open graph by
 * updating whenever the source signals a change. The index is derived and
 * browser-private. A full rebuild from fresh document snapshots is always correct,
 * while sources which identify one changed concept can use the incremental path.
 * This framework-free in-memory implementation remains the fallback and test seam;
 * the production workspace uses the worker-owned SQLite implementation.
 */

import { type BacklinkIndex, type IndexDoc, buildBacklinkIndex } from './backlink-index'

/**
 * What changed, when the source knows. A named `concept` means ONLY that document's content
 * moved, so a consumer can re-index just it; `undefined` means "assume everything" (a
 * registry change - create, delete, rename - or a source that cannot tell).
 */
export interface StoreChange {
    concept: string
}

export type StoreChangeListener = (change?: StoreChange) => void

/**
 * A durable source-side record of changes not yet confirmed in the persisted derived index.
 * `changes === null` means document identity moved and requires a full replacement. The
 * acknowledgement must clear only the exact versions captured by this checkpoint, so a source
 * write racing the index commit remains pending for the next pass.
 */
export interface IndexChangeCheckpoint {
    changes: readonly StoreChange[] | null
    /** Cache-bound document snapshots for targeted changes, newer than any stale live view. */
    documents?: readonly IndexDoc[]
    /** Cache-bound replacement source when identity moved or incremental work grew too large. */
    streamForIndex?(
        options?: IndexSnapshotOptions,
    ): Promise<{ total: number; batches: AsyncIterable<readonly IndexDoc[]> }>
    acknowledge(): Promise<void>
}

/** Which half of a full build is running — both take real time on a large graph. */
export interface IndexProgress {
    /** `loading`: reading documents out of the store. `indexing`: writing derived rows. */
    phase: 'loading' | 'indexing'
    done: number
    total: number
}

export interface IndexSnapshotOptions {
    onProgress?: (progress: IndexProgress) => void
}

/** What the live index needs from a store (the FilesystemDocumentStore satisfies it). */
export interface IndexSource {
    snapshotForIndex(options?: IndexSnapshotOptions): Promise<IndexDoc[]>
    /**
     * Optional bounded source for a cold rebuild. The worker ingests each batch immediately,
     * so neither thread needs to retain every document body at once.
     */
    streamForIndex?(
        options?: IndexSnapshotOptions,
    ): Promise<{ total: number; batches: AsyncIterable<readonly IndexDoc[]> }>
    /**
     * One document's snapshot; null when it has gone. Optional — a source without it simply
     * forces the full rebuild path, which is always correct, just slower. (The Filesystem
     * store does not implement it yet: its snapshot reads from disk, so the same win there
     * is a separate change.)
     */
    snapshotDocument?(concept: string): Promise<IndexDoc | null> | IndexDoc | null
    /**
     * Bring a source behind a persisted index up to date without handing every unchanged
     * document back to the index worker. Synced stores use this to start bounded per-document
     * catch-up; genuine remote changes then arrive through `onChange`.
     */
    catchUpPersistedIndex?(): Promise<void>
    /** Recover source changes which survived a crash after cache commit but before index commit. */
    pendingIndexChanges?(): Promise<IndexChangeCheckpoint>
    onChange(listener: StoreChangeListener): () => void
}

export interface GraphIndex {
    /** The current index (empty until the first refresh resolves). */
    get(): BacklinkIndex
    /** Force a rebuild now (the workspace awaits this once after the initial scan). */
    refresh(): Promise<void>
    /** Notified after each rebuild. Returns an unsubscribe. */
    onUpdated(listener: () => void): () => void
    dispose(): void
}

export function createGraphIndex(
    source: IndexSource,
    { debounceMs = 300 }: { debounceMs?: number } = {},
): GraphIndex {
    let current = buildBacklinkIndex([])
    const updated = new Set<() => void>()
    let timer: ReturnType<typeof setTimeout> | undefined

    async function rebuild(): Promise<void> {
        current = buildBacklinkIndex(await source.snapshotForIndex())
        for (const listener of updated) listener()
    }

    function scheduleRebuild(): void {
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(() => {
            timer = undefined
            void rebuild()
        }, debounceMs)
    }

    const unsubscribe = source.onChange(scheduleRebuild)

    return {
        get: () => current,
        refresh: rebuild,
        onUpdated(listener) {
            updated.add(listener)
            return () => updated.delete(listener)
        },
        dispose() {
            if (timer !== undefined) clearTimeout(timer)
            unsubscribe()
            updated.clear()
        },
    }
}
