/**
 * On-disk persistence for the two things the [[Headless Client]] otherwise rebuilds on every
 * launch: the [[Local Cache]] and the [[Derived Index]]. Neither store is re-implemented here;
 * both keep running exactly as they do in the browser, and this module only carries their bytes
 * across process lifetimes.
 *
 * - The Local Cache runs over `fake-indexeddb`, an in-memory IndexedDB. Its rows for one graph
 *   (`docs`, `outbox`, `index-dirty` of the `etherpk-sync` database) are read back through the
 *   ordinary IndexedDB API and written to one file; on launch they are put back into the fresh
 *   in-memory database before the sync engine opens it. The cache's own merge rules, dirty
 *   tokens and watermarks are therefore untouched - a restored row is the row that was there.
 * - The index is SQLite in WASM memory. sqlite-wasm exports a database as its file bytes
 *   (`sqlite3_js_db_export`) and imports them into its virtual filesystem
 *   (`sqlite3_js_posix_create_file`), so a launch opens the index the last run committed and the
 *   worker core takes its warm path: only documents whose watermark moved are caught up.
 *
 * **Invalidation is the engines' own.** Nothing here decides what is stale. On launch the sync
 * engine compares every cached document's `(generation, lifecycle, lastSeq)` with the relay in
 * bounded metadata requests and catches up only what moved; a deletion arrives as a lifecycle
 * change; unacknowledged local edits replay from the outbox; the index re-ingests exactly the
 * documents whose `index-dirty` tokens the cache still holds. A schema change is a wholesale
 * discard by design (ADR 0015): the file names carry the cache's `DB_VERSION` and the index's
 * `INDEX_SCHEMA_VERSION`, so a newer build simply does not find the old files, and the core's own
 * `PRAGMA user_version` check discards a stale index it is handed.
 *
 * **Ordering.** A snapshot writes the cache first and the index second. The index must never be
 * behind what the cache says it has acknowledged, and an acknowledgement is only ever written
 * after the ingest it confirms, so an index captured after the cache always covers every
 * acknowledged token in it; a write that lands between the two captures leaves its dirty token
 * in the cache snapshot and is simply re-ingested next launch.
 *
 * What is on disk is plaintext Yjs state and plaintext index rows, the same as the browser
 * profile holds in IndexedDB and OPFS: the trust class the user chose for this machine. A
 * protected document's cache row is collected the moment it reads as protected (the same
 * `collectRowWhen` the workspace passes), and the index never held one. `logout` deletes the lot.
 */

import { createHash } from 'node:crypto'
import { deserialize, serialize } from 'node:v8'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { INDEX_SCHEMA_VERSION, createSchema, isUsableIndex, type SqlDb } from '$lib/document/index-db'
import { wrapOo1Db } from '$lib/document/index-db-sqlite'
import type { IndexDbHost } from '$lib/document/index-worker/core'
import { EMBEDDING_SCHEMA, EMBEDDING_STORE_VERSION, prepareEmbeddingStore, semanticStatus, type SemanticStatus } from '$lib/document/semantic/embedding-db'

/** The Local Cache's IndexedDB database and stores, as `sync/local-cache.ts` names them. */
const CACHE_DB = 'etherpk-sync'
const CACHE_DB_VERSION = 3
const CACHE_STORES = ['docs', 'outbox', 'index-dirty'] as const
type CacheStore = (typeof CACHE_STORES)[number]

interface CacheSnapshot {
    version: number
    graphId: string
    rows: Record<CacheStore, unknown[]>
}

/**
 * `~/.cache/etherpk/mcp/<server host>/<graph id>/`, or under `ETHERPK_MCP_CACHE_DIR`. The host's
 * port separator becomes `_`: a colon is not a path character on Windows.
 */
export function graphCacheDir(env: NodeJS.ProcessEnv, serverBaseUrl: string, graphId: string): string {
    const base = env.ETHERPK_MCP_CACHE_DIR?.trim() || join(env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache'), 'etherpk', 'mcp')
    const host = new URL(serverBaseUrl).host.replace(/[^A-Za-z0-9.-]/g, '_')
    return join(base, host, graphId)
}

/**
 * A local folder's identity for its cache directory and its index: the folder's basename for a
 * person reading the cache root, plus a hash of the absolute path so two folders of the same
 * name stay apart. A folder carries no graph id of its own (only settings live in its
 * `etherpk/`), so the path is the identity, and moving the folder means a re-derive
 * ([[2026-09-18 Headless Client Serves A Local Folder]]).
 */
export function folderKey(folderPath: string): string {
    const absolute = resolve(folderPath)
    const readable = basename(absolute).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'folder'
    const hash = createHash('sha256').update(absolute).digest('hex').slice(0, 12)
    return `${readable}-${hash}`
}

/** Where a local folder's index and embedding store live: `local/` is its "host" under the root. */
export function folderCacheDir(env: NodeJS.ProcessEnv, folderPath: string): string {
    return join(cacheRoot(env), 'local', folderKey(folderPath))
}

/** The root every graph's cache dir sits under, for `logout` to remove. */
export function cacheRoot(env: NodeJS.ProcessEnv): string {
    return env.ETHERPK_MCP_CACHE_DIR?.trim() || join(env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache'), 'etherpk', 'mcp')
}

/**
 * The files this build reads and writes in a graph's directory, by name: the cache, the index,
 * and the [[Embedding]] store beside the index with a stamp of its own (ADR 0076) - an index
 * schema bump discards `index.v<N>` and leaves the vectors alone, because their rows cost
 * minutes to re-derive where the index's cost a second. `removeStaleFiles` keeps exactly these
 * names, so they are declared once here and joined to a directory below; a name is never
 * recovered from a joined path (see there).
 */
const CACHE_FILE_NAME = `local-cache.v${CACHE_DB_VERSION}.bin`
const INDEX_FILE_NAME = `index.v${INDEX_SCHEMA_VERSION}.sqlite`
const VECTORS_FILE_NAME = `vectors.v${EMBEDDING_STORE_VERSION}.sqlite`

export function cacheFile(dir: string): string {
    return join(dir, CACHE_FILE_NAME)
}

export function indexFile(dir: string): string {
    return join(dir, INDEX_FILE_NAME)
}

export function vectorsFile(dir: string): string {
    return join(dir, VECTORS_FILE_NAME)
}

function request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
    })
}

function done(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
    })
}

/** Open the cache database the sync engine already created; never creates or upgrades it. */
async function openCacheDb(): Promise<IDBDatabase> {
    const db = await request(indexedDB.open(CACHE_DB, CACHE_DB_VERSION))
    for (const store of CACHE_STORES) {
        if (!db.objectStoreNames.contains(store)) {
            db.close()
            throw new Error(`Local Cache database has no "${store}" store; open the graph cache before restoring it.`)
        }
    }
    return db
}

/**
 * Give every typed array in a row its own exact-size buffer.
 *
 * Node's v8 deserialiser hands typed arrays back as zero-copy VIEWS on the buffer it was given
 * - here the whole snapshot file - and IndexedDB's structured clone copies a view's entire
 * underlying buffer, not the view. Restoring 2,474 rows that all pointed into one 11 MB file
 * therefore cloned 11 MB per row: 28 GB resident, the machine in swap, a thermal shutdown
 * (2026-09-17). Capture copies too, so a snapshot never carries more than the bytes it means
 * whatever the store handed back. Plain Uint8Arrays, which is what the engine reads.
 */
function withStandaloneBuffers<T>(value: T): T {
    if (ArrayBuffer.isView(value)) {
        const view = value as unknown as Uint8Array
        const copy = new Uint8Array(view.byteLength)
        copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
        return copy as unknown as T
    }
    if (Array.isArray(value)) return value.map(withStandaloneBuffers) as unknown as T
    if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        const out: Record<string, unknown> = {}
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = withStandaloneBuffers(entry)
        return out as T
    }
    return value
}

/** Every row of every cache store that belongs to `graphId`, as one serialisable snapshot. */
export async function captureLocalCache(graphId: string): Promise<CacheSnapshot> {
    const db = await openCacheDb()
    try {
        const tx = db.transaction([...CACHE_STORES], 'readonly')
        const rows = {} as Record<CacheStore, unknown[]>
        for (const store of CACHE_STORES) {
            const all = (await request(tx.objectStore(store).getAll())) as Array<{ graphId?: string }>
            rows[store] = all.filter((row) => row.graphId === graphId).map(withStandaloneBuffers)
        }
        await done(tx)
        return { version: CACHE_DB_VERSION, graphId, rows }
    } finally {
        db.close()
    }
}

/** Put a snapshot's rows back. Existing rows for the same keys are replaced. */
export async function restoreLocalCache(snapshot: CacheSnapshot): Promise<number> {
    const db = await openCacheDb()
    try {
        const tx = db.transaction([...CACHE_STORES], 'readwrite')
        let count = 0
        for (const store of CACHE_STORES) {
            for (const row of snapshot.rows[store]) {
                tx.objectStore(store).put(withStandaloneBuffers(row))
                count++
            }
        }
        await done(tx)
        return count
    } finally {
        db.close()
    }
}

async function writeAtomically(path: string, bytes: Uint8Array): Promise<void> {
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, bytes, { mode: 0o600 })
    await rename(temp, path)
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path)
        return true
    } catch {
        return false
    }
}

/** Save the graph's cache rows to disk. */
export async function persistLocalCache(dir: string, graphId: string): Promise<void> {
    const snapshot = await captureLocalCache(graphId)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeAtomically(cacheFile(dir), serialize(snapshot))
}

/**
 * Load a saved cache into the in-memory database, if one exists for this build's cache version.
 * A file that will not parse or belongs to another graph is ignored: the cache is rebuildable.
 */
export async function loadLocalCache(dir: string, graphId: string): Promise<number> {
    const path = cacheFile(dir)
    if (!(await exists(path))) return 0
    try {
        const snapshot = deserialize(await readFile(path)) as CacheSnapshot
        if (snapshot.version !== CACHE_DB_VERSION || snapshot.graphId !== graphId) return 0
        return await restoreLocalCache(snapshot)
    } catch (error) {
        console.error(`etherpk-mcp: ignoring an unreadable cache file ${path}: ${error instanceof Error ? error.message : String(error)}`)
        return 0
    }
}

/**
 * An {@link IndexDbHost} over sqlite-wasm's memory with a file on disk behind it. `open` imports
 * the saved database when there is one and reports `persisted: true`, which is what puts the
 * index core on its warm path; `discard` deletes the file and hands back an empty database.
 * {@link NodeIndexHost.export} writes the live database's bytes for the next launch.
 *
 * The embedding store is a second file ATTACHed to the same handle under the `embeddings`
 * schema (ADR 0076): imported once per process into sqlite-wasm's own filesystem, attached to
 * every database this host opens - a discarded index gets it back untouched - and exported
 * with the index. A vectors file that will not read as a database is removed rather than
 * attached, or every query on the index would fail on it.
 */
export interface NodeIndexHost extends IndexDbHost {
    /** Write the open database to disk; a no-op before `open`. */
    export(): Promise<void>
}

// The oo1 API typed loosely at this one boundary, as `index-db-sqlite.ts` does.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sqlite3 = any

/** A `.tmp` younger than this may be a snapshot another process is still writing. */
const ABANDONED_TMP_AFTER_MS = 10 * 60_000

/**
 * Remove what an older build or a killed write left in a graph's directory: index and vectors
 * files stamped with another version (a bump renames them, so they are never opened again and
 * were 52 MB of litter per graph), and `.tmp` files from an atomic write that never reached its
 * rename - only once they are old enough that no live `serve` can be writing them. The files
 * this build reads are left alone.
 */
export async function removeStaleFiles(dir: string, now = Date.now()): Promise<string[]> {
    // The names themselves, never recovered from a joined path: `join` spells a path with
    // backslashes on Windows, and a keep-set made by splitting on `/` there held whole paths,
    // matched no directory entry, and removed this build's own index and vectors on every
    // start - a full re-index and a minutes-long re-embed per serve (0.7.0, 2026-09-21).
    const keep = new Set([CACHE_FILE_NAME, INDEX_FILE_NAME, VECTORS_FILE_NAME])
    const removed: string[] = []
    for (const name of await readdir(dir).catch(() => [] as string[])) {
        const stale = /^(index|vectors)\.v\d+\.sqlite$/.test(name) && !keep.has(name)
        const temp = /\.\d+\.tmp$/.test(name)
        if (!stale && !temp) continue
        if (temp) {
            const age = now - ((await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? now)
            if (age < ABANDONED_TMP_AFTER_MS) continue
        }
        await rm(join(dir, name), { force: true })
        removed.push(name)
    }
    return removed
}

/** Hosts opened in this process, so each gets its own paths in sqlite-wasm's filesystem. */
let hostSerial = 0

export interface NodeIndexHostOptions {
    /**
     * Whether opening may change the directory: remove stale and abandoned files, and discard
     * an index or vectors file that will not read. `serve` tidies; `semantic status` reads a
     * directory a live serve may be writing and must not (default true).
     */
    tidy?: boolean
}

export function nodeIndexHost(dir: string, options: NodeIndexHostOptions = {}): NodeIndexHost {
    const tidy = options.tidy ?? true
    let sqlite3: Sqlite3 | undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let live: { oo1: any; db: SqlDb } | undefined
    const path = indexFile(dir)
    const vectorsPath = vectorsFile(dir)
    /** sqlite-wasm's own virtual filesystem paths, distinct per host: `semantic status` opens several. */
    const serial = ++hostSerial
    const vfsName = `/etherpk-index-${process.pid}-${serial}.sqlite`
    const vectorsVfsName = `/etherpk-vectors-${process.pid}-${serial}.sqlite`
    let vectorsImported = false

    async function init(): Promise<Sqlite3> {
        if (!sqlite3) {
            const { default: sqlite3InitModule } = await import('@sqlite.org/sqlite-wasm')
            sqlite3 = await sqlite3InitModule()
        }
        return sqlite3
    }

    /** Put the saved vectors into the wasm filesystem, once, if they read as a database. */
    async function importVectors(s: Sqlite3): Promise<void> {
        if (vectorsImported) return
        vectorsImported = true
        if (!(await exists(vectorsPath))) return
        try {
            s.capi.sqlite3_js_posix_create_file(vectorsVfsName, new Uint8Array(await readFile(vectorsPath)))
            const probe = new s.oo1.DB(':memory:')
            try {
                probe.exec(`ATTACH '${vectorsVfsName}' AS ${EMBEDDING_SCHEMA}`)
                probe.exec(`PRAGMA ${EMBEDDING_SCHEMA}.user_version`)
            } finally {
                probe.close()
            }
        } catch (error) {
            console.error(`etherpk-mcp: ignoring an unreadable vectors file ${vectorsPath}: ${error instanceof Error ? error.message : String(error)}`)
            if (tidy) await rm(vectorsPath, { force: true })
            s.capi.sqlite3_js_posix_create_file(vectorsVfsName, new Uint8Array(0))
        }
    }

    function attachVectors(db: SqlDb): void {
        db.exec(`ATTACH '${vectorsVfsName}' AS ${EMBEDDING_SCHEMA}`)
        // As wrapOo1Db sets for the main database: a swept vector's bytes do not linger.
        db.exec(`PRAGMA ${EMBEDDING_SCHEMA}.secure_delete = ON`)
    }

    function openFresh(s: Sqlite3): { oo1: Sqlite3; db: SqlDb } {
        const oo1 = new s.oo1.DB(':memory:')
        const db = wrapOo1Db(oo1)
        createSchema(db)
        attachVectors(db)
        return { oo1, db }
    }

    async function openSaved(s: Sqlite3): Promise<{ oo1: Sqlite3; db: SqlDb } | null> {
        if (!(await exists(path))) return null
        try {
            const bytes = await readFile(path)
            s.capi.sqlite3_js_posix_create_file(vfsName, new Uint8Array(bytes))
            const oo1 = new s.oo1.DB(vfsName)
            const db = wrapOo1Db(oo1)
            if (!isUsableIndex(db)) {
                // The core would discard it anyway; do it here so the file goes too.
                db.close()
                if (tidy) await rm(path, { force: true })
                return null
            }
            attachVectors(db)
            return { oo1, db }
        } catch (error) {
            console.error(`etherpk-mcp: ignoring an unreadable index file ${path}: ${error instanceof Error ? error.message : String(error)}`)
            if (tidy) await rm(path, { force: true })
            return null
        }
    }

    return {
        async open() {
            const s = await init()
            if (tidy) await removeStaleFiles(dir)
            await importVectors(s)
            const saved = await openSaved(s)
            live = saved ?? openFresh(s)
            return { db: live.db, persisted: true }
        },
        async discard() {
            const s = await init()
            await importVectors(s)
            await rm(path, { force: true })
            live = openFresh(s)
            return { db: live.db, persisted: true }
        },
        async export() {
            if (!live || !sqlite3) return
            const bytes = sqlite3.capi.sqlite3_js_db_export(live.oo1.pointer) as Uint8Array
            const vectors = sqlite3.capi.sqlite3_js_db_export(live.oo1.pointer, EMBEDDING_SCHEMA) as Uint8Array
            await mkdir(dir, { recursive: true, mode: 0o700 })
            await writeAtomically(path, bytes)
            await writeAtomically(vectorsPath, vectors)
        },
    }
}

export interface GraphStoreStatus {
    /** The server host directory, as `graphCacheDir` spells it. */
    host: string
    graphId: string
    dir: string
    status: SemanticStatus
    /** When the vectors file was last exported: how fresh the counts are. */
    updatedAt: Date
}

/**
 * Every cached graph's [[Semantic Search]] progress, read from the files the last `serve` wrote
 * - so a human can watch a build from another terminal without going through the agent. The
 * counts are as of the last export, which a running build refreshes every
 * `BUILD_PERSIST_EVERY_MS` (headless-graph.ts).
 */
export async function listGraphStores(env: NodeJS.ProcessEnv, model: string): Promise<GraphStoreStatus[]> {
    const root = cacheRoot(env)
    const stores: GraphStoreStatus[] = []
    for (const host of await readdir(root).catch(() => [] as string[])) {
        if (host === 'runtime' || host === 'models') continue
        const hostDir = join(root, host)
        if (!(await stat(hostDir).catch(() => null))?.isDirectory()) continue
        for (const graphId of await readdir(hostDir).catch(() => [] as string[])) {
            const dir = join(hostDir, graphId)
            if (!(await exists(indexFile(dir)))) continue
            // Read-only: a live serve may be writing this directory.
            const opened = await nodeIndexHost(dir, { tidy: false }).open(graphId)
            try {
                prepareEmbeddingStore(opened.db)
                const status = semanticStatus(opened.db, model)
                const updatedAt = ((await stat(vectorsFile(dir)).catch(() => null)) ?? (await stat(indexFile(dir)))).mtime
                stores.push({ host, graphId, dir, status, updatedAt })
            } finally {
                opened.db.close()
            }
        }
    }
    return stores
}

/**
 * A store's state as one line a person can act on: a word first, then the counts, then how
 * fresh they are. A building `serve` refreshes the snapshot every 30 seconds, so a snapshot
 * under a minute and a half old means "building now" and an older one means nothing is - the
 * distinction the raw count and timestamp left the reader to infer (2026-09-17).
 */
export function describeGraphStore(store: GraphStoreStatus, now = Date.now()): string {
    const { embedded, total } = store.status
    const ageMs = Math.max(0, now - store.updatedAt.getTime())
    const age =
        ageMs < 90_000 ? `${Math.round(ageMs / 1000)} s ago` : ageMs < 3_600_000 ? `${Math.round(ageMs / 60_000)} min ago` : `${Math.round(ageMs / 3_600_000)} h ago`
    const count = `${embedded.toLocaleString('en-GB')} of ${total.toLocaleString('en-GB')} passages`
    if (total === 0) return `empty - no passages indexed here yet (snapshot ${age})`
    if (embedded >= total) return `up to date - ${count} embedded (snapshot ${age})`
    const percent = Math.floor((embedded / total) * 100)
    return ageMs < 90_000
        ? `building - ${count} (${percent}%) embedded, snapshot ${age}, refreshed every 30 s while it builds`
        : `paused - ${count} (${percent}%) embedded, last snapshot ${age}; nothing is building it now, it continues when serve next runs`
}

/** Remove every persisted graph under the cache root (logout of the last server). */
export async function removeCacheRoot(env: NodeJS.ProcessEnv): Promise<void> {
    await rm(cacheRoot(env), { recursive: true, force: true })
}

/** Remove one server's persisted graphs (logout of that server while others stay). */
export async function removeServerCache(env: NodeJS.ProcessEnv, serverBaseUrl: string): Promise<void> {
    await rm(dirname(graphCacheDir(env, serverBaseUrl, 'x')), { recursive: true, force: true })
}
