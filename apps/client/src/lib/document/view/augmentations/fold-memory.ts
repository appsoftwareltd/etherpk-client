/**
 * Which bullets a person has folded, kept on the device per graph and per document (ADR 0191). A
 * [[Fold]] is how one device shows a document: it is never written into the graph, sent to the Sync
 * Server, or kept for a [[Protected Document]].
 *
 * A bullet has no identity of its own (ADR 0016), so a fold is kept as its bullet's 1-based line and
 * a fingerprint of the bullet's text, and found again as a task reference finds its task: at its
 * line, or else at the nearest line with the same fingerprint (fold-persistence.ts). One that is
 * found nowhere is dropped without a word.
 *
 * One store per graph, under {@link foldMemoryKey}; the workspace opens the graph's and makes it the
 * active one, and removing the graph from the device removes the key (`graph-device-memory.ts`).
 * Every editor of one document in the tab reads the same entry and hears the others' changes, so
 * two panes show the same folds. Another tab's changes are read at its next open.
 *
 * Kept free of `#lib` imports, so an e2e fixture can import it.
 */

/** A kept fold: its bullet's 1-based line and the fingerprint of the bullet's text. */
export interface KeptFold {
    line: number
    fingerprint: string
}

/** The part of `Storage` the store uses. */
export interface FoldStorage {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
}

export interface FoldMemoryOptions {
    storage: () => FoldStorage | null
    storageKey: string
    /** Most documents kept: the least recently changed are dropped first. */
    documentLimit?: number
    /** Most folds kept for one document. */
    foldLimit?: number
    saveDelayMs?: number
    flushOn?: (flush: () => void) => () => void
}

export interface FoldMemory {
    /** The kept folds of the document named `key` (a concept key). */
    get(key: string): readonly KeptFold[]
    /** Keep `folds` for `key`, an empty list forgetting it, and tell the document's other editors, not `source`. */
    set(key: string, folds: readonly KeptFold[], source?: object): void
    /** Hear another editor's change to `key`'s folds. Returns how to stop. */
    subscribe(key: string, listener: (source: object | undefined) => void): () => void
    flush(): void
    dispose(): void
}

export const FOLD_MEMORY_KEY_PREFIX = 'etherpk:folds:'
const FORMAT_VERSION = 1
const DEFAULT_DOCUMENT_LIMIT = 500
const DEFAULT_FOLD_LIMIT = 500
const DEFAULT_SAVE_DELAY_MS = 400

/** The `localStorage` key of one graph's folds. */
export function foldMemoryKey(graphId: string): string {
    return `${FOLD_MEMORY_KEY_PREFIX}${graphId}`
}

/**
 * The fingerprint of a bullet's text: FNV-1a over its words with whitespace collapsed, as 8 hex
 * digits. Enough to tell one bullet from its neighbours; it is not a security measure.
 */
export function foldFingerprint(text: string): string {
    const words = text.normalize('NFC').replace(/\s+/g, ' ').trim()
    let hash = 0x811c9dc5
    for (let i = 0; i < words.length; i++) {
        hash ^= words.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}

/** The stored form: `{ v, docs: [[key, [[line, fingerprint], …]], …] }`, least recently changed first. */
type StoredDoc = [string, [number, string][]]

function plausibleFold(f: unknown): f is [number, string] {
    return Array.isArray(f) && f.length === 2 && Number.isInteger(f[0]) && f[0] >= 1 && typeof f[1] === 'string' && /^[0-9a-f]{8}$/.test(f[1])
}

/** One stored document's key and folds, or null when it is not one or keeps none worth reading. */
function readDoc(doc: unknown): [string, KeptFold[]] | null {
    if (!Array.isArray(doc) || typeof doc[0] !== 'string' || !Array.isArray(doc[1])) return null
    const folds = (doc[1] as unknown[]).filter(plausibleFold).map(([line, fingerprint]) => ({ line, fingerprint }))
    return folds.length ? [doc[0], folds] : null
}

function readStored(storage: FoldStorage | null, storageKey: string): Map<string, KeptFold[]> {
    const out = new Map<string, KeptFold[]>()
    if (!storage) return out
    try {
        const raw = storage.getItem(storageKey)
        if (!raw) return out
        const parsed = JSON.parse(raw) as { v?: unknown; docs?: unknown }
        if (parsed?.v !== FORMAT_VERSION || !Array.isArray(parsed.docs)) return out
        for (const doc of parsed.docs as unknown[]) {
            const read = readDoc(doc)
            if (read) out.set(read[0], read[1])
        }
    } catch {
        // Unreadable (a blocked origin) or not ours: no folds kept.
    }
    return out
}

export function createFoldMemory(options: FoldMemoryOptions): FoldMemory {
    const { storageKey } = options
    const documentLimit = options.documentLimit ?? DEFAULT_DOCUMENT_LIMIT
    const foldLimit = options.foldLimit ?? DEFAULT_FOLD_LIMIT
    const saveDelayMs = options.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS
    let docs: Map<string, KeptFold[]> | null = null
    /** Documents changed since the last write, applied to what is stored then (another tab may have written). */
    let changed = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopFlushOn: (() => void) | null = null
    const listeners = new Map<string, Set<(source: object | undefined) => void>>()

    const loaded = () => (docs ??= readStored(options.storage(), storageKey))

    function write(): void {
        if (timer !== null) clearTimeout(timer)
        timer = null
        const keys = changed
        changed = new Set()
        const storage = options.storage()
        if (!storage || keys.size === 0) return
        const stored = readStored(storage, storageKey)
        const mine = loaded()
        for (const key of keys) {
            stored.delete(key)
            const folds = mine.get(key)
            if (folds?.length) stored.set(key, folds)
        }
        while (stored.size > documentLimit) stored.delete(stored.keys().next().value as string)
        const out: StoredDoc[] = [...stored].map(([key, folds]) => [key, folds.map((f) => [f.line, f.fingerprint])])
        try {
            storage.setItem(storageKey, JSON.stringify({ v: FORMAT_VERSION, docs: out }))
        } catch {
            // Full or refused: the folds still hold for this session.
        }
    }

    function flush(): void {
        if (timer !== null || changed.size > 0) write()
    }

    return {
        get: (key) => loaded().get(key) ?? [],
        set(key, folds, source) {
            const map = loaded()
            const next = folds.slice(0, foldLimit).map((f) => ({ line: f.line, fingerprint: f.fingerprint }))
            const before = map.get(key) ?? []
            if (JSON.stringify(before) === JSON.stringify(next)) return
            // Recency is insertion order: a document changed now moves to the end.
            map.delete(key)
            if (next.length) map.set(key, next)
            changed.add(key)
            if (!stopFlushOn && options.flushOn) stopFlushOn = options.flushOn(flush)
            if (timer === null) timer = setTimeout(write, saveDelayMs)
            for (const listener of listeners.get(key) ?? []) listener(source)
        },
        subscribe(key, listener) {
            let set = listeners.get(key)
            if (!set) listeners.set(key, (set = new Set()))
            set.add(listener)
            return () => {
                set.delete(listener)
                if (set.size === 0) listeners.delete(key)
            }
        },
        flush,
        dispose() {
            flush()
            stopFlushOn?.()
            stopFlushOn = null
        },
    }
}

/** A graph's folds over `localStorage`, written shortly after a change and whenever the page is hidden or left. */
export function browserFoldMemory(graphId: string): FoldMemory {
    return createFoldMemory({
        storage: () => {
            try {
                return typeof localStorage === 'undefined' ? null : localStorage
            } catch {
                return null
            }
        },
        storageKey: foldMemoryKey(graphId),
        flushOn: (flush) => {
            if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
            const hidden = () => {
                if (document.visibilityState === 'hidden') flush()
            }
            window.addEventListener('pagehide', flush)
            document.addEventListener('visibilitychange', hidden)
            return () => {
                window.removeEventListener('pagehide', flush)
                document.removeEventListener('visibilitychange', hidden)
            }
        },
    })
}

/** Outside a graph: folds for the session, never stored. */
const sessionOnly = createFoldMemory({ storage: () => null, storageKey: '' })
let active: FoldMemory | null = null

/** Make `memory` the one editors read and write (the open graph's), or none. */
export function setActiveFoldMemory(memory: FoldMemory | null): void {
    active = memory
}

/** Stop `memory` being the active one, unless another graph's has taken its place already. */
export function releaseActiveFoldMemory(memory: FoldMemory): void {
    if (active === memory) active = null
}

/** The open graph's folds, or a memory that keeps nothing past the session. */
export function activeFoldMemory(): FoldMemory {
    return active ?? sessionOnly
}
