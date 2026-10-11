/**
 * The size each image was last drawn at, kept from one session to the next, per graph.
 *
 * Until a picture has decoded, two things only know its size from here: CodeMirror's height map,
 * through a block image widget's `estimatedHeight`, and the loading placeholder that holds the
 * picture's place. Kept in memory only, both started every session blind: the height map held each
 * image as one row tall and the placeholder was a small default box, so the first scroll past each
 * picture after a reload moved everything around it as it decoded, and the scroll position and the
 * caret jumped with it. A footprint stored in `localStorage` sizes both from the first frame.
 *
 * A footprint depends on the width the editor had when the picture was drawn (a picture scales down
 * to fit), so after a resize it is a close estimate rather than the truth, and the decode corrects it.
 *
 * One store per graph, under {@link imageFootprintsKey}: the workspace opens the graph's store and
 * makes it the active one ({@link setActiveImageFootprints}), and removing the graph from the device
 * removes the key with the graph's other per-graph keys (`graph-device-memory.ts`). Outside a graph
 * the active store keeps nothing past the session.
 *
 * What is never stored: a footprint the caller says not to keep (a picture in a [[Protected
 * Document]], whose reference is part of the protected text and must leave no plaintext behind), and
 * `data:` and `blob:` addresses ({@link persistableImageUrl}). Protecting a document forgets the
 * footprints of the pictures it shows ({@link ImageFootprintStore.forgetImages}), since they may
 * have been stored while it was not protected.
 *
 * Two tabs on one graph each hold the stored footprints in memory, so a write never replaces what
 * storage holds with this tab's copy: it applies this tab's changes since its last write to what is
 * stored now. A footprint another tab forgot is never written back by a tab that read it earlier.
 *
 * Kept free of `$lib` imports, so an e2e fixture can import it.
 */

/** An image's rendered footprint: the widget's full height and the picture's width and left offset (px). */
export interface ImageFootprint {
    width: number
    /** The full vertical footprint, the widget's spacing included (see `ImageSize` in image-embed.ts). */
    height: number
    /** The picture's left offset from its line's left edge, for the reveal placeholder. */
    left: number
}

/** The part of `Storage` the store uses. */
export interface FootprintStorage {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
}

export interface ImageFootprintStoreOptions {
    /** Where footprints are kept between sessions; null where there is none. Asked at each use. */
    storage: () => FootprintStorage | null
    /** The storage key, one per graph: {@link imageFootprintsKey}. */
    storageKey: string
    /** Most footprints kept: the least recently drawn are dropped first. */
    limit?: number
    /** How long after a change it is written, so a page of pictures decoding costs one write. */
    saveDelayMs?: number
    /** Called once, with the store's flush, when it first has something to write; returns how to stop. */
    flushOn?: (flush: () => void) => () => void
}

export interface ImageFootprintStore {
    get(key: string): ImageFootprint | undefined
    /** Record what an image was drawn at; `persist: false` keeps it to this session and takes it out of storage. */
    remember(key: string, footprint: ImageFootprint, options: { persist: boolean }): void
    /** Forget every footprint of the images at `urls`, whatever their size hints, here and in storage. */
    forgetImages(urls: Iterable<string>): void
    /** Write a waiting change now. */
    flush(): void
    /** Write a waiting change and stop listening for the page going away. */
    dispose(): void
}

export const IMAGE_FOOTPRINTS_KEY_PREFIX = 'etherpk:image-footprints:'

/** The `localStorage` key of one graph's footprints. */
export function imageFootprintsKey(graphId: string): string {
    return `${IMAGE_FOOTPRINTS_KEY_PREFIX}${graphId}`
}

const FORMAT_VERSION = 1
const DEFAULT_LIMIT = 500
const DEFAULT_SAVE_DELAY_MS = 1000
/** Longer references are not kept: an inline picture's address can be megabytes. */
const MAX_PERSISTED_URL_LENGTH = 512
/** Past this a stored size is not one a picture was drawn at (a damaged or foreign value). */
const MAX_FOOTPRINT_PX = 20_000

/**
 * Whether a footprint for the image at `url` may outlive the session: not a `data:` address (the
 * picture itself, possibly huge), not a `blob:` one (meaningless in the next session), and not one
 * longer than {@link MAX_PERSISTED_URL_LENGTH}.
 */
export function persistableImageUrl(url: string): boolean {
    return url.length <= MAX_PERSISTED_URL_LENGTH && !/^(?:data|blob):/i.test(url)
}

/** The image reference in a footprint key (`imageKey` in image-embed.ts: `url|maxWidth|maxHeight`). */
function urlOfKey(key: string): string {
    const hint = key.lastIndexOf('|', key.lastIndexOf('|') - 1)
    return hint < 0 ? key : key.slice(0, hint)
}

interface Entry extends ImageFootprint {
    persist: boolean
}

/** The stored form: `{ v, entries: [[key, width, height, left], …] }`, least recently drawn first. */
type StoredEntry = [string, number, number, number]

/** A change this store has made since its last write, applied to what is stored at the next one. */
type Change = { kind: 'set'; key: string; footprint: ImageFootprint } | { kind: 'delete'; key: string } | { kind: 'forget'; urls: ReadonlySet<string> }

const plausible = (n: unknown, min: number): n is number => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= MAX_FOOTPRINT_PX

function readStored(storage: FootprintStorage | null, storageKey: string): StoredEntry[] {
    if (!storage) return []
    try {
        const raw = storage.getItem(storageKey)
        if (!raw) return []
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null) return []
        const { v, entries } = parsed as { v?: unknown; entries?: unknown }
        if (v !== FORMAT_VERSION || !Array.isArray(entries)) return []
        return entries.filter(
            (e): e is StoredEntry =>
                Array.isArray(e) && e.length === 4 && typeof e[0] === 'string' && plausible(e[1], 1) && plausible(e[2], 1) && plausible(e[3], 0),
        )
    } catch {
        // Unreadable (private mode, a blocked origin) or not ours: start this session blind.
        return []
    }
}

export function createImageFootprintStore(options: ImageFootprintStoreOptions): ImageFootprintStore {
    const { storageKey } = options
    const limit = options.limit ?? DEFAULT_LIMIT
    const saveDelayMs = options.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS
    // Insertion order is recency: a footprint drawn again moves to the end.
    let entries: Map<string, Entry> | null = null
    let changes: Change[] = []
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    let stopFlushOn: (() => void) | null = null

    function trim<V>(map: Map<string, V>): void {
        while (map.size > limit) map.delete(map.keys().next().value as string)
    }

    function loaded(): Map<string, Entry> {
        if (!entries) {
            entries = new Map()
            for (const [key, width, height, left] of readStored(options.storage(), storageKey)) {
                entries.set(key, { width, height, left, persist: true })
            }
        }
        return entries
    }

    function write(): void {
        if (saveTimer !== null) clearTimeout(saveTimer)
        saveTimer = null
        const pending = changes
        changes = []
        const storage = options.storage()
        if (!storage || pending.length === 0) return
        // What is stored now, which another tab may have changed since this one read it.
        const stored = new Map<string, ImageFootprint>()
        for (const [key, width, height, left] of readStored(storage, storageKey)) stored.set(key, { width, height, left })
        const before = JSON.stringify([...stored])
        for (const change of pending) {
            if (change.kind === 'set') {
                stored.delete(change.key)
                stored.set(change.key, change.footprint)
            } else if (change.kind === 'delete') {
                stored.delete(change.key)
            } else {
                for (const key of [...stored.keys()]) if (change.urls.has(urlOfKey(key))) stored.delete(key)
            }
        }
        trim(stored)
        if (JSON.stringify([...stored]) === before) return
        const out: StoredEntry[] = [...stored].map(([key, f]) => [key, f.width, f.height, f.left])
        try {
            storage.setItem(storageKey, JSON.stringify({ v: FORMAT_VERSION, entries: out }))
        } catch {
            // Full or refused: the footprints still serve this session.
        }
    }

    function record(change: Change): void {
        changes.push(change)
        if (!stopFlushOn && options.flushOn) stopFlushOn = options.flushOn(flush)
        if (saveTimer === null) saveTimer = setTimeout(write, saveDelayMs)
    }

    function flush(): void {
        if (saveTimer !== null || changes.length > 0) write()
    }

    return {
        get: (key) => {
            const e = loaded().get(key)
            return e ? { width: e.width, height: e.height, left: e.left } : undefined
        },
        remember(key, footprint, { persist }) {
            const map = loaded()
            map.delete(key)
            map.set(key, { ...footprint, persist })
            trim(map)
            record(persist ? { kind: 'set', key, footprint: { ...footprint } } : { kind: 'delete', key })
        },
        forgetImages(urls) {
            const set = new Set(urls)
            if (set.size === 0) return
            const map = loaded()
            for (const key of [...map.keys()]) if (set.has(urlOfKey(key))) map.delete(key)
            record({ kind: 'forget', urls: set })
        },
        flush,
        dispose() {
            flush()
            stopFlushOn?.()
            stopFlushOn = null
        },
    }
}

/** A graph's store over `localStorage`, written a second after a change and whenever the page is hidden or left. */
export function browserImageFootprints(graphId: string): ImageFootprintStore {
    return createImageFootprintStore({
        storage: () => {
            try {
                return typeof localStorage === 'undefined' ? null : localStorage
            } catch {
                return null // reading `localStorage` throws where the origin's storage is blocked
            }
        },
        storageKey: imageFootprintsKey(graphId),
        flushOn: (flush) => {
            if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
            // A phone may never fire `pagehide` for a tab it discards; going to the background is the last sure moment.
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

/** Outside a graph: footprints for the session, never stored. */
const sessionOnly = createImageFootprintStore({ storage: () => null, storageKey: '' })
let active: ImageFootprintStore | null = null

/** Make `store` the one the image widgets read and write (the open graph's), or none. */
export function setActiveImageFootprints(store: ImageFootprintStore | null): void {
    active = store
}

/**
 * Stop `store` being the active one, unless another graph's has taken its place already: a graph
 * switch can mount the next workspace before the last one has finished its teardown.
 */
export function releaseActiveImageFootprints(store: ImageFootprintStore): void {
    if (active === store) active = null
}

/** The open graph's store, or one that keeps nothing past the session. */
export function activeImageFootprints(): ImageFootprintStore {
    return active ?? sessionOnly
}
