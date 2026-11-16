/**
 * Which bullets a person has folded, kept on the device per graph and per document (ADR 0191). A
 * [[Fold]] is how one device shows a document: it is never written into the graph, sent to the Sync
 * Server, or kept for a [[Protected Document]].
 *
 * A bullet has no identity of its own (ADR 0016), so a fold is kept as its bullet's 1-based line, a
 * fingerprint of its words and its ancestors', and which bullet with that fingerprint it is, and
 * found again from those (fold-persistence.ts). One that is found nowhere is dropped without a word.
 *
 * One store per graph, a key for each document under {@link foldMemoryKey}; the workspace opens the
 * graph's and makes it the active one, and removing the graph from the device removes its keys
 * (`graph-device-memory.ts`).
 * Every editor of one document in the tab reads the same entry and hears the others' changes, so
 * two panes show the same folds. Another tab's changes are read at its next open.
 *
 * Kept free of `#lib` imports, so an e2e fixture can import it.
 */

/**
 * A kept fold: its bullet's 1-based line, the fingerprint of the bullet's words and of every
 * bullet above it in the outline, and which of the bullets with that fingerprint it is, counted from
 * the top of the document (0 for the first). The words alone are not enough: a journal repeats
 * "Comments" under many tasks, and a fold kept by its line and its own words came back on another
 * bullet, or on its parent, once lines were added above it.
 */
export interface KeptFold {
    line: number
    fingerprint: string
    nth: number
}

/** The part of `Storage` the store uses. */
export interface FoldStorage {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    removeItem(key: string): void
    readonly length: number
    key(index: number): string | null
}

export interface FoldMemoryOptions {
    storage: () => FoldStorage | null
    storageKey: string
    /** Most documents kept: the least recently changed are dropped first. */
    documentLimit?: number
    /** Most folds kept for one document. */
    foldLimit?: number
    saveDelayMs?: number
    /** The clock a write stamps a document with, for dropping the least recently changed. */
    now?: () => number
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
const FORMAT_VERSION = 2
const DEFAULT_DOCUMENT_LIMIT = 500
const DEFAULT_FOLD_LIMIT = 500
const DEFAULT_SAVE_DELAY_MS = 400

/**
 * The start of the `localStorage` keys of one graph's folds. Each document has a key of its own,
 * {@link foldDocumentKey}: a tab writes only the documents whose folds it changed, and reads no other
 * tab's to do it. One key for the whole graph made every write a read of all the documents followed
 * by a store of them all, and two tabs writing at once (both do when a window closes) could each
 * store what it read before the other's landed, which lost the other's folds
 * (spec/fold-memory/FoldMemory.tla).
 */
export function foldMemoryKey(graphId: string): string {
    return `${FOLD_MEMORY_KEY_PREFIX}${graphId}`
}

/** The `localStorage` key of one document's folds, under the graph's `storageKey`. */
export function foldDocumentKey(storageKey: string, key: string): string {
    return `${storageKey}:${encodeURIComponent(key)}`
}

/** Every `localStorage` key holding a graph's folds: its documents', and the single key of the first format. */
export function foldMemoryKeysIn(storage: Pick<FoldStorage, 'length' | 'key'>, graphId: string): string[] {
    const own = foldMemoryKey(graphId)
    const out: string[] = []
    for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        if (key !== null && (key === own || key.startsWith(`${own}:`))) out.push(key)
    }
    return out
}

/**
 * The fingerprint of a bullet: FNV-1a over `text` with whitespace collapsed, as 8 hex digits.
 * `text` is the bullet's words after its ancestors' ({@link foldPath}). Enough to tell one bullet
 * from its neighbours; it is not a security measure.
 */
export function foldFingerprint(text: string): string {
    const words = text.normalize('NFC').replace(/[^\S\n]+/g, ' ').trim()
    let hash = 0x811c9dc5
    for (let i = 0; i < words.length; i++) {
        hash ^= words.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}

/** What a fingerprint is taken over: the words of each bullet above this one, outermost first, then its own. */
export function foldPath(words: readonly string[]): string {
    return words.map((w) => w.replace(/\s+/g, ' ').trim()).join('\n')
}

/** The stored form of one document: `{ v, t, folds: [[line, fingerprint, nth], …] }`, `t` when it was written. */
interface StoredDoc {
    v: number
    t: number
    folds: [number, string, number][]
}

function plausibleFold(f: unknown): f is [number, string, number] {
    return (
        Array.isArray(f) &&
        f.length === 3 &&
        Number.isInteger(f[0]) &&
        f[0] >= 1 &&
        typeof f[1] === 'string' &&
        /^[0-9a-f]{8}$/.test(f[1]) &&
        Number.isInteger(f[2]) &&
        f[2] >= 0
    )
}

/** One document's stored folds and when they were written, or null when the value is not ours. */
function readDoc(raw: string | null): { folds: KeptFold[]; at: number } | null {
    if (!raw) return null
    try {
        const parsed = JSON.parse(raw) as Partial<StoredDoc>
        if (parsed?.v !== FORMAT_VERSION || !Array.isArray(parsed.folds)) return null
        const folds = (parsed.folds as unknown[]).filter(plausibleFold).map(([line, fingerprint, nth]) => ({ line, fingerprint, nth }))
        return { folds, at: typeof parsed.t === 'number' ? parsed.t : 0 }
    } catch {
        return null
    }
}

export function createFoldMemory(options: FoldMemoryOptions): FoldMemory {
    const { storageKey } = options
    const documentLimit = options.documentLimit ?? DEFAULT_DOCUMENT_LIMIT
    const foldLimit = options.foldLimit ?? DEFAULT_FOLD_LIMIT
    const saveDelayMs = options.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS
    const now = options.now ?? Date.now
    /** Each document's folds as this tab last read or set them. Another tab's later changes are read at the next open. */
    const docs = new Map<string, KeptFold[]>()
    /** Documents changed since the last write. */
    let changed = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopFlushOn: (() => void) | null = null
    const listeners = new Map<string, Set<(source: object | undefined) => void>>()

    const storage = (): FoldStorage | null => {
        try {
            return options.storage()
        } catch {
            return null
        }
    }

    function loaded(key: string): KeptFold[] {
        let folds = docs.get(key)
        if (!folds) {
            let raw: string | null = null
            try {
                raw = storage()?.getItem(foldDocumentKey(storageKey, key)) ?? null
            } catch {
                // Unreadable (a blocked origin): no folds kept.
            }
            folds = readDoc(raw)?.folds ?? []
            docs.set(key, folds)
        }
        return folds
    }

    /** Drop the least recently written documents past the limit, and the single key of the first format. */
    function prune(store: FoldStorage): void {
        const prefix = `${storageKey}:`
        const kept: { key: string; at: number }[] = []
        for (let i = 0; i < store.length; i++) {
            const key = store.key(i)
            if (key !== null && key.startsWith(prefix)) kept.push({ key, at: readDoc(store.getItem(key))?.at ?? 0 })
        }
        store.removeItem(storageKey)
        if (kept.length <= documentLimit) return
        kept.sort((a, b) => a.at - b.at)
        for (const { key } of kept.slice(0, kept.length - documentLimit)) store.removeItem(key)
    }

    function write(): void {
        if (timer !== null) clearTimeout(timer)
        timer = null
        const keys = changed
        changed = new Set()
        const store = storage()
        if (!store || keys.size === 0) return
        try {
            // Only the documents this tab changed, each under its own key: nothing another tab wrote is read or stored.
            for (const key of keys) {
                const folds = docs.get(key) ?? []
                const at = foldDocumentKey(storageKey, key)
                if (folds.length === 0) store.removeItem(at)
                else store.setItem(at, JSON.stringify({ v: FORMAT_VERSION, t: now(), folds: folds.map((f) => [f.line, f.fingerprint, f.nth]) } satisfies StoredDoc))
            }
            prune(store)
        } catch {
            // Full or refused: the folds still hold for this session.
        }
    }

    function flush(): void {
        if (timer !== null || changed.size > 0) write()
    }

    return {
        get: (key) => loaded(key),
        set(key, folds, source) {
            const next = folds.slice(0, foldLimit).map((f) => ({ line: f.line, fingerprint: f.fingerprint, nth: f.nth }))
            const before = loaded(key)
            if (JSON.stringify(before) === JSON.stringify(next)) return
            docs.set(key, next)
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
