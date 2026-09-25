/**
 * The SQLite schema + query layer for the derived index (ADR 0015,
 * Dual Mode Editor.md). Engine-agnostic: it talks to a tiny {@link SqlDb} interface
 * so the same code runs over an in-memory DB in node tests and a sqlite-wasm/OPFS DB
 * in the browser. Derived and rebuildable — `ingest` clears and repopulates.
 *
 * Absorbs the in-memory backlink index: it answers `backlinksFor` (now enriched with
 * the outline-chain breadcrumb) and `existingConceptKeys`. Concept identity is
 * case-insensitive (ADR 0011).
 */

import type { DocumentKind } from '$lib/storage'

import { conceptKey } from './backlinks'
import { fencedBlocks } from './fenced-code'
import { blockContent, type BlockRow, deriveDoc, deriveTitleLinks, type TaskConceptRow, type TaskRow } from './index-derive'
import { containsCipherFence } from './protection/fence-info'
import { derivePassages } from './semantic/passages'

/**
 * One snippet a publication page names under its `includes:` (ADR 0082): the page fills
 * `slot` of publication `publication` with the document called `concept`, as written.
 * Read from the publication page's frontmatter by whoever builds the IndexDoc, like aliases:
 * the worker never sees frontmatter, and the fact is about ANOTHER document than the one
 * carrying it, which is why the index holds it rather than the page's own row.
 */
export interface IndexIncludeFact {
    publication: string
    slot: string
    concept: string
}

/** One document fed into the index (same shape the in-memory index consumed). */
export interface IndexDoc {
    concept: string
    kind: DocumentKind
    aliases: string[]
    text: string
    /** The includes this document declares as a publication page; absent or empty otherwise. */
    includes?: readonly IndexIncludeFact[]
}

/** One node of a block reference's rendered subtree (the matched block + descendants). */
export interface RefSubtreeNode {
    /** The block's content ({@link blockContent}): continuation lines and fenced code included. */
    text: string
    /** A [[Task]]'s state, whose `[ ]` / `[x]` the content leaves out; absent for any other block. */
    done?: boolean
    /** Depth relative to the matched block (0 = the matched block itself). */
    depth: number
    /** True for the block that actually holds the wikilink. */
    isMatch: boolean
}

/** A prose reference's surrounding text, truncated to about 1000 chars centred on the match. */
export interface RefContext {
    text: string
    matchStart: number
    matchEnd: number
    truncated: boolean
}

/**
 * One reference, rendered three ways (Dual Mode Editor.md → references). A **block**
 * reference (wikilink in a bullet/task) carries the matched block + its descendant
 * subtree (Logseq 0.10.15 behaviour). A **prose** reference (wikilink in a paragraph
 * or heading) carries the surrounding paragraph text. Both carry a breadcrumb:
 * full ancestry for block refs, the heading tree for prose refs. A **title** reference
 * is the source document's own name naming the concept as a [[Scope]] (ADR 0083): its
 * context is the title, its line is 0 (the document opens at its top) and it has no
 * breadcrumb, there being nothing above a title.
 */
export interface DbBacklinkRef {
    sourceConcept: string
    sourceKind: DocumentKind
    line: number
    kind: 'block' | 'prose' | 'title'
    /** Ancestor labels, root-first. Empty when the reference is direct on the page. */
    breadcrumb: string[]
    /** Block refs: the matched block + descendants. Empty for prose and title refs. */
    subtree: RefSubtreeNode[]
    /** Prose refs: the surrounding (possibly truncated) text; title refs: the title. Null for block refs. */
    context: RefContext | null
}

export interface DbBacklinkGroup {
    sourceConcept: string
    sourceKind: DocumentKind
    refs: DbBacklinkRef[]
}

/**
 * Whether a source document links to the concept from its BODY, not only by being scoped by
 * it. A rename's "N documents link to X and will be updated" counts the documents whose text
 * the rewrite touches; a page that merely carries the scope in its title is retitled by the
 * cascade and reported there, so counting it here would describe it twice (ADR 0083).
 */
export function referencedInBody(group: Pick<DbBacklinkGroup, 'refs'>): boolean {
    return group.refs.some((ref) => ref.kind !== 'title')
}

const MAX_CONTEXT = 1000

/** The minimal SQL surface the index needs — implemented over sqlite-wasm. */
export interface SqlDb {
    exec(sql: string): void
    run(sql: string, params?: unknown[]): void
    all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[]
    /** Release the underlying SQLite handle. Safe to call more than once. */
    close(): void
}

/**
 * Bumped whenever the schema OR the derivation changes (ADR 0015's `PRAGMA user_version`
 * pattern, ADR 0041 §5). A persisted index built by an older parser is not merely old, it is
 * WRONG - it holds the output of derivation logic that no longer exists - so a mismatch means
 * discard and rebuild. Changing `index-derive.ts` without bumping this is the trap.
 */
export const INDEX_SCHEMA_VERSION = 12

const SCHEMA = `
CREATE TABLE IF NOT EXISTS index_metadata (
  key TEXT PRIMARY KEY, value INTEGER NOT NULL);
-- protected: the stored text holds a cipher fence (fence-info.ts). Kept on the page row so a
-- listing can wear a padlock without opening the document - the one cheap answer the tab has.
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY, concept TEXT NOT NULL, concept_key TEXT NOT NULL, kind TEXT NOT NULL,
  text_hash TEXT NOT NULL DEFAULT '', generation INTEGER NOT NULL DEFAULT 1,
  protected INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS aliases (
  page_id INTEGER NOT NULL, alias_key TEXT NOT NULL, display TEXT NOT NULL);
-- A publication page's includes (ADR 0082), one row per slot: page_id is the PUBLICATION
-- page, concept_key the snippet it names, as written (resolved over aliases at query time, the
-- way links are). What lets a tab say "used in a publication" without opening anything.
CREATE TABLE IF NOT EXISTS publication_includes (
  page_id INTEGER NOT NULL, publication_id TEXT NOT NULL, slot TEXT NOT NULL,
  concept_key TEXT NOT NULL, concept TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blocks (
  page_id INTEGER NOT NULL, local_id INTEGER NOT NULL, parent_local_id INTEGER,
  ord INTEGER NOT NULL, kind TEXT NOT NULL, depth INTEGER NOT NULL, done INTEGER,
  start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, label TEXT NOT NULL, text TEXT NOT NULL);
-- in_title: the link is in the document's own NAME - the [[Scope]] of a [[Scoped Concept]]
-- (ADR 0083) - rather than in its body. line_text is then the title and line is 0. It counts as
-- a reference everywhere a body link does; only a rename's body-rewrite count leaves it out.
CREATE TABLE IF NOT EXISTS links (
  page_id INTEGER NOT NULL, concept TEXT NOT NULL, concept_key TEXT NOT NULL,
  line INTEGER NOT NULL, line_text TEXT NOT NULL, match_start INTEGER NOT NULL,
  match_end INTEGER NOT NULL, block_local_id INTEGER, in_title INTEGER NOT NULL DEFAULT 0);
-- The [[Task Tag]] run (ADR 0032) parsed into columns, so the [[Tasks View]] can filter,
-- order and PAGE in SQL. Keeping the run as text would make LIMIT return the wrong rows.
CREATE TABLE IF NOT EXISTS tasks (
  page_id INTEGER NOT NULL, block_local_id INTEGER NOT NULL, done INTEGER NOT NULL,
  text TEXT NOT NULL, line INTEGER NOT NULL,
  priority INTEGER, waiting INTEGER NOT NULL DEFAULT 0, doing INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0, due TEXT, completion TEXT, scheduled TEXT);
-- [[Task Concept]] (ADR 0051): one row per (task, concept it answers to). Concepts are stored
-- AS WRITTEN and pooled over [[Alias]]es at query time, exactly as backlinksFor does — baking
-- the canonical name in would go stale the moment a page is renamed.
CREATE TABLE IF NOT EXISTS task_concepts (
  page_id INTEGER NOT NULL, block_local_id INTEGER NOT NULL, concept_key TEXT NOT NULL);
-- [[Passage]]s for [[Semantic Search]] (ADR 0076): the pieces of a document that get an
-- [[Embedding]] each, keyed by the hash of their text (semantic/passages.ts). The vectors
-- themselves live in the ATTACHed embeddings schema (semantic/embedding-db.ts), OUTSIDE this
-- generation lifecycle - they cost minutes to re-derive where these rows cost milliseconds -
-- and join back here by content_hash, which is why the hash is indexed.
CREATE TABLE IF NOT EXISTS passages (
  page_id INTEGER NOT NULL, ord INTEGER NOT NULL, start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL, first_block_local_id INTEGER NOT NULL,
  content_hash TEXT NOT NULL, text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS passages_hash ON passages(content_hash);
CREATE INDEX IF NOT EXISTS links_concept_key ON links(concept_key);
CREATE INDEX IF NOT EXISTS blocks_page ON blocks(page_id);
-- Re-indexing ONE document deletes its rows by page_id and finds its page by concept_key;
-- without these every edit would scan the whole table (ingestOne).
CREATE INDEX IF NOT EXISTS pages_concept_key ON pages(concept_key);
CREATE INDEX IF NOT EXISTS pages_generation ON pages(generation);
CREATE INDEX IF NOT EXISTS aliases_alias_key ON aliases(alias_key);
CREATE INDEX IF NOT EXISTS aliases_page ON aliases(page_id);
CREATE INDEX IF NOT EXISTS publication_includes_page ON publication_includes(page_id);
CREATE INDEX IF NOT EXISTS publication_includes_key ON publication_includes(concept_key);
CREATE INDEX IF NOT EXISTS links_page ON links(page_id);
CREATE INDEX IF NOT EXISTS tasks_page ON tasks(page_id);
-- The Name Filter's whole selectivity: without it, filtering to a concept scans every task
-- row in the graph. Mirrors links_concept_key, and like it stays put during a bulk rebuild.
CREATE INDEX IF NOT EXISTS task_concepts_key ON task_concepts(concept_key);
-- Search's text index. One row per block, so a document's rank can be "how many blocks
-- mention this" - the ordering the results actually display. See the block_fts notes above
-- createSchema for why unicode61 rather than trigram, and why the rowid encodes the block.
CREATE VIRTUAL TABLE IF NOT EXISTS block_fts USING fts5(text, tokenize = 'unicode61');
`

/**
 * [[Search]]'s text index (`block_fts` in {@link SCHEMA}) holds one row per [[Block]], so a
 * document can be ranked by how many of its blocks mention the query - the ordering the
 * results actually display.
 *
 * `unicode61` (word tokens), NOT `trigram`: trigram gives true substring matching but needs
 * >=3 characters, ranks close to meaninglessly under bm25, and runs 3-4x the text in an OPFS
 * store ADR 0041 already worries about. The accepted loss is that `graph` does not find
 * `subgraph`; the win is that the final term can carry an implicit `*`, so results narrow as
 * the user types.
 *
 * The rowid ENCODES the block: `page_id * BLOCK_FTS_STRIDE + local_id`. That is what makes
 * retiring a page a primary-key range delete rather than a scan of the whole text index -
 * an FTS5 column cannot be indexed for that, and `ingestOne` runs on every keystroke.
 *
 * Blocks per page in that encoding: 2^20 - far past any real document (a block is a line or a
 * bullet), and `page_id * STRIDE` stays inside `Number.MAX_SAFE_INTEGER`. 2^20 - far past any real document
 */
export const BLOCK_FTS_STRIDE = 1_048_576

/** The rowid range covering every text-index row for one page: `[from, to)`. */
function blockFtsRange(pageId: number): [number, number] {
    return [pageId * BLOCK_FTS_STRIDE, (pageId + 1) * BLOCK_FTS_STRIDE]
}

export function createSchema(db: SqlDb): void {
    db.exec(SCHEMA)
    db.run("INSERT OR IGNORE INTO index_metadata (key, value) VALUES ('active_generation', 1)")
    db.run("INSERT OR IGNORE INTO index_metadata (key, value) VALUES ('revision', 0)")
    db.exec(`PRAGMA user_version = ${INDEX_SCHEMA_VERSION}`)
}

export function activeIndexGeneration(db: SqlDb): number {
    return (
        db.all<{ value: number }>(
            "SELECT value FROM index_metadata WHERE key = 'active_generation'",
        )[0]?.value ?? 1
    )
}

export function indexRevision(db: SqlDb): number {
    return db.all<{ value: number }>("SELECT value FROM index_metadata WHERE key = 'revision'")[0]
        ?.value ?? 0
}

export function advanceIndexRevision(db: SqlDb): number {
    db.run("UPDATE index_metadata SET value = value + 1 WHERE key = 'revision'")
    return indexRevision(db)
}

/**
 * Ready an existing database for use, or report that it cannot be trusted.
 *
 * Returns false when the file was written by a different schema or derivation version — the
 * caller discards it and rebuilds. Never migrates: the index is derived and rebuildable, so
 * rebuilding is always both available and cheaper than being careful (ADR 0015).
 */
export function isUsableIndex(db: SqlDb): boolean {
    try {
        const rows = db.all<{ user_version: number }>('PRAGMA user_version')
        return rows[0]?.user_version === INDEX_SCHEMA_VERSION
    } catch {
        return false
    }
}

/** Every indexed document's content hash, for deciding what actually needs re-deriving. */
export function documentHashes(db: SqlDb): Map<string, string> {
    const rows = db.all<{ concept_key: string; text_hash: string }>(
        'SELECT concept_key, text_hash FROM pages WHERE generation = ?',
        [activeIndexGeneration(db)],
    )
    return new Map(rows.map((r) => [r.concept_key, r.text_hash]))
}

export function documentHash(db: SqlDb, key: string): string | undefined {
    return db.all<{ text_hash: string }>(
        'SELECT text_hash FROM pages WHERE generation = ? AND concept_key = ? LIMIT 1',
        [activeIndexGeneration(db), key],
    )[0]?.text_hash
}

/**
 * cyrb53 — a fast, non-cryptographic 53-bit string hash. Not a security boundary: it decides
 * whether a document's derived rows are still current. A collision leaves one page stale until
 * its next edit, which a never-authoritative store survives (ADR 0041 §5).
 */
/**
 * What decides whether a document needs re-indexing: its body, plus its include facts when it
 * has any, since those come from the frontmatter the body does not carry and a publication
 * page's Save changes nothing else. A document without includes hashes exactly as before.
 */
export function indexDocHash(doc: IndexDoc): string {
    const includes = doc.includes ?? []
    if (includes.length === 0) return hashText(doc.text)
    return hashText(`${doc.text}\u0000${includes.map((i) => `${i.publication}\u0001${i.slot}\u0001${i.concept}`).join('\u0000')}`)
}

export function hashText(text: string): string {
    let h1 = 0xdeadbeef
    let h2 = 0x41c6ce57
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i)
        h1 = Math.imul(h1 ^ ch, 2654435761)
        h2 = Math.imul(h2 ^ ch, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/**
 * Whether a [[Block]] contributes to [[Search]]'s text index.
 *
 * A [[Protected Document]] contributes **nothing** - not its plaintext and not its ciphertext.
 * This is a permanent rule, not a limitation waiting to be lifted (CONTEXT.md): the
 * [[Derived Index]] is plaintext at rest in OPFS and outlives the session, so indexing
 * decrypted cipher content would leave it on disk in a queryable file, surviving after the
 * key is forgotten - which defeats the whole feature. Indexing the ciphertext instead would
 * be merely useless: base64 matches nothing a human types, and it bloats the index.
 *
 * This is also what makes the lock cheap (ADR 0058): there is nothing here to evict when the
 * key goes, because protected content was never written here in the first place.
 */
function isTextSearchable(block: BlockRow): boolean {
    return !containsCipherFence(block.text)
}

/** Write one document's derived rows under an already-established page id. */
function insertDerived(db: SqlDb, pageId: number, doc: IndexDoc): void {
    for (const alias of doc.aliases) {
        db.run('INSERT INTO aliases (page_id, alias_key, display) VALUES (?,?,?)', [pageId, conceptKey(alias), alias])
    }
    for (const include of doc.includes ?? []) {
        db.run('INSERT INTO publication_includes (page_id, publication_id, slot, concept_key, concept) VALUES (?,?,?,?,?)', [
            pageId,
            include.publication,
            include.slot,
            conceptKey(include.concept),
            include.concept,
        ])
    }
    // The document's own name, then its body. A title row is a link row like any other, at
    // line 0 with the title as its line text, so every reader that counts references counts it.
    for (const t of deriveTitleLinks(doc.concept)) {
        db.run(
            'INSERT INTO links (page_id, concept, concept_key, line, line_text, match_start, match_end, block_local_id, in_title) VALUES (?,?,?,?,?,?,?,?,1)',
            [pageId, t.concept, conceptKey(t.concept), 0, doc.concept, t.matchStart, t.matchEnd, null],
        )
    }
    const { blocks, links, tasks, taskConcepts } = deriveDoc(doc.text)
    for (const b of blocks) {
        db.run(
            'INSERT INTO blocks (page_id, local_id, parent_local_id, ord, kind, depth, done, start_line, end_line, label, text) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            [pageId, b.localId, b.parentId, b.ord, b.kind, b.depth, b.done == null ? null : b.done ? 1 : 0, b.startLine, b.endLine, b.label, b.text],
        )
        if (isTextSearchable(b) && b.localId < BLOCK_FTS_STRIDE) {
            db.run('INSERT INTO block_fts (rowid, text) VALUES (?,?)', [
                pageId * BLOCK_FTS_STRIDE + b.localId,
                b.text,
            ])
        }
    }
    for (const l of links) {
        db.run(
            'INSERT INTO links (page_id, concept, concept_key, line, line_text, match_start, match_end, block_local_id) VALUES (?,?,?,?,?,?,?,?)',
            [pageId, l.concept, conceptKey(l.concept), l.line, l.lineText, l.matchStart, l.matchEnd, l.blockLocalId],
        )
    }
    for (const t of tasks) {
        db.run(
            `INSERT INTO tasks (page_id, block_local_id, done, text, line,
                                priority, waiting, doing, cancelled, due, completion, scheduled)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
                pageId,
                t.blockLocalId,
                t.done ? 1 : 0,
                t.text,
                t.line,
                t.priority,
                t.waiting ? 1 : 0,
                t.doing ? 1 : 0,
                t.cancelled ? 1 : 0,
                t.due,
                t.completion,
                t.scheduled,
            ],
        )
    }
    insertTaskConcepts(db, pageId, doc, tasks, taskConcepts)
    for (const passage of derivePassages(doc.concept, blocks)) {
        db.run(
            'INSERT INTO passages (page_id, ord, start_line, end_line, first_block_local_id, content_hash, text) VALUES (?,?,?,?,?,?,?)',
            [pageId, passage.ord, passage.startLine, passage.endLine, passage.firstBlockLocalId, hashText(passage.text), passage.text],
        )
    }
}

/**
 * Write one document's [[Task Concept]] rows (ADR 0051).
 *
 * Derivation supplies the wikilinked half; the document's own concept is added HERE, as the
 * virtual root of every task's ancestry chain, because derivation reads text and never learns
 * the document's identity. Without that row, filtering to a project page returns nothing for
 * the tasks written directly on it — the case the "Use <active tab>" shortcut exists for.
 *
 * Only the document's own concept goes in, never its aliases: the query resolves a filtered
 * name to its page and matches on every name that page answers to, so an alias row here would
 * be redundant now and stale after a rename.
 */
function insertTaskConcepts(
    db: SqlDb,
    pageId: number,
    doc: IndexDoc,
    tasks: readonly TaskRow[],
    taskConcepts: readonly TaskConceptRow[],
): void {
    if (tasks.length === 0) return
    const ownKey = conceptKey(doc.concept)
    const written = new Set<string>()
    const write = (blockLocalId: number, key: string) => {
        const seen = `${blockLocalId} ${key}`
        if (written.has(seen)) return
        written.add(seen)
        db.run('INSERT INTO task_concepts (page_id, block_local_id, concept_key) VALUES (?,?,?)', [
            pageId,
            blockLocalId,
            key,
        ])
    }
    for (const t of tasks) write(t.blockLocalId, ownKey)
    for (const tc of taskConcepts) write(tc.blockLocalId, conceptKey(tc.concept))
}

/**
 * Run `work` as ONE transaction. Without this every INSERT is its own implicit transaction,
 * which is most of what made a full rebuild cost seconds rather than milliseconds.
 */
function inTransaction(db: SqlDb, work: () => void): void {
    db.exec('BEGIN')
    try {
        work()
        db.exec('COMMIT')
    } catch (err) {
        db.exec('ROLLBACK')
        throw err
    }
}

/**
 * Indexes that exist to make a ONE-document re-index cheap (`ingestOne`). During a bulk
 * rebuild they are pure cost — every one of ~124k inserts maintains them — so the full path
 * drops and rebuilds them around the load, which SQLite does far faster in one pass.
 */
const MAINTENANCE_INDEXES = [
    'pages_concept_key',
    'aliases_alias_key',
    'aliases_page',
    'publication_includes_page',
    'links_page',
    'tasks_page',
    'task_concepts_page',
    'passages_page',
]

const CREATE_MAINTENANCE_INDEXES = `
CREATE INDEX IF NOT EXISTS pages_concept_key ON pages(concept_key);
CREATE INDEX IF NOT EXISTS aliases_alias_key ON aliases(alias_key);
CREATE INDEX IF NOT EXISTS aliases_page ON aliases(page_id);
CREATE INDEX IF NOT EXISTS publication_includes_page ON publication_includes(page_id);
CREATE INDEX IF NOT EXISTS links_page ON links(page_id);
CREATE INDEX IF NOT EXISTS tasks_page ON tasks(page_id);
CREATE INDEX IF NOT EXISTS task_concepts_page ON task_concepts(page_id);
CREATE INDEX IF NOT EXISTS passages_page ON passages(page_id);`

function clearForRebuild(db: SqlDb): void {
    db.exec(
        'DELETE FROM pages; DELETE FROM aliases; DELETE FROM publication_includes; DELETE FROM blocks; DELETE FROM links; DELETE FROM tasks; DELETE FROM task_concepts; DELETE FROM passages; DELETE FROM block_fts;',
    )
    for (const name of MAINTENANCE_INDEXES) db.exec(`DROP INDEX IF EXISTS ${name}`)
}

/** SQLite has no boolean: the `protected` column as stored. */
function protectedFlag(doc: IndexDoc): number {
    return containsCipherFence(doc.text) ? 1 : 0
}

function insertPage(db: SqlDb, pageId: number, generation: number, doc: IndexDoc): void {
    db.run(
        'INSERT INTO pages (id, concept, concept_key, kind, text_hash, generation, protected) VALUES (?,?,?,?,?,?,?)',
        [pageId, doc.concept, conceptKey(doc.concept), doc.kind, indexDocHash(doc), generation, protectedFlag(doc)],
    )
    insertDerived(db, pageId, doc)
}

/** Rebuild the whole index from the documents (derived; never authoritative). */
export function ingest(db: SqlDb, docs: Iterable<IndexDoc>): void {
    inTransaction(db, () => {
        clearForRebuild(db)
        const generation = activeIndexGeneration(db)
        let pageId = 0
        for (const doc of docs) insertPage(db, ++pageId, generation, doc)
        db.exec(CREATE_MAINTENANCE_INDEXES)
    })
}

/** Documents per transaction in a progressive rebuild — small enough to yield often. */
const REBUILD_BATCH = 100

export interface ProgressiveIngestOptions {
    /** Yield to the event loop; see `activity/breathe`. Without one this still batches, but never repaints. */
    breathe?: () => Promise<void> | void
    onProgress?: (done: number, total: number) => void
}

/**
 * The same full rebuild, in slices that hand the thread back between them.
 *
 * A 2431-document graph takes seconds to index however fast each insert is, and doing it in
 * one synchronous call means a frozen tab and a loading screen that cannot paint. The index
 * is derived and rebuildable, so a partially-built index mid-rebuild is not a correctness
 * problem — it is simply incomplete, which is what the progress the caller renders says.
 */
export async function ingestProgressively(
    db: SqlDb,
    docs: readonly IndexDoc[],
    options: ProgressiveIngestOptions = {},
): Promise<void> {
    inTransaction(db, () => clearForRebuild(db))
    const generation = activeIndexGeneration(db)
    options.onProgress?.(0, docs.length)
    for (let start = 0; start < docs.length; start += REBUILD_BATCH) {
        const batch = docs.slice(start, start + REBUILD_BATCH)
        inTransaction(db, () => {
            batch.forEach((doc, n) => insertPage(db, start + n + 1, generation, doc))
        })
        options.onProgress?.(Math.min(start + REBUILD_BATCH, docs.length), docs.length)
        await options.breathe?.()
    }
    inTransaction(db, () => db.exec(CREATE_MAINTENANCE_INDEXES))
}

function deleteGeneration(db: SqlDb, generation: number): void {
    // Generation retirement is one relation-sized operation per table. Deleting four
    // child relations one page at a time made a 2,400-page commit execute roughly 9,600
    // synchronous wasm calls in one uninterruptible worker turn, so newly attached tabs
    // could wait many seconds even though their persisted index was already usable.
    // The text index first, and by ROWID: its rowids are derived from `blocks`, so once the
    // block rows are gone there is nothing left to compute them from, and the only remaining
    // way to find them would be a scan of the whole text index.
    db.run(
        `DELETE FROM block_fts WHERE rowid IN (
           SELECT b.page_id * ${BLOCK_FTS_STRIDE} + b.local_id FROM blocks b
           JOIN pages p ON p.id = b.page_id WHERE p.generation = ?)`,
        [generation],
    )
    for (const table of ['aliases', 'publication_includes', 'blocks', 'links', 'tasks', 'task_concepts', 'passages']) {
        db.run(
            `DELETE FROM ${table} WHERE page_id IN (SELECT id FROM pages WHERE generation = ?)`,
            [generation],
        )
    }
    db.run('DELETE FROM pages WHERE generation = ?', [generation])
}

/** Begin an invisible rebuild generation and remove debris from any interrupted predecessor. */
export function beginIndexRebuild(db: SqlDb): number {
    const active = activeIndexGeneration(db)
    inTransaction(db, () => {
        const inactive = db
            .all<{ generation: number }>(
                'SELECT DISTINCT generation FROM pages WHERE generation <> ?',
                [active],
            )
            .map((row) => row.generation)
        for (const generation of inactive) deleteGeneration(db, generation)
    })
    return (
        db.all<{ generation: number }>(
            'SELECT MAX(generation) AS generation FROM pages',
        )[0]?.generation ?? active
    ) + 1
}

/** Ingest a rebuild chunk immediately without exposing it to active queries. */
export function ingestIndexRebuildChunk(
    db: SqlDb,
    generation: number,
    docs: readonly IndexDoc[],
): void {
    inTransaction(db, () => {
        let pageId =
            db.all<{ id: number }>('SELECT COALESCE(MAX(id), 0) AS id FROM pages')[0]?.id ?? 0
        for (const doc of docs) insertPage(db, ++pageId, generation, doc)
    })
}

/** Atomically expose a complete staged generation, then reclaim the previous one. */
export function commitIndexRebuild(db: SqlDb, generation: number): number {
    return inTransactionWithResult(db, () => {
        db.run("UPDATE index_metadata SET value = ? WHERE key = 'active_generation'", [
            generation,
        ])
        const revision = advanceIndexRevision(db)
        const obsolete = db
            .all<{ generation: number }>(
                'SELECT DISTINCT generation FROM pages WHERE generation <> ?',
                [generation],
            )
            .map((row) => row.generation)
        for (const oldGeneration of obsolete) deleteGeneration(db, oldGeneration)
        return revision
    })
}

export function abortIndexRebuild(db: SqlDb, generation: number): void {
    inTransaction(db, () => deleteGeneration(db, generation))
}

function inTransactionWithResult<T>(db: SqlDb, work: () => T): T {
    db.exec('BEGIN')
    try {
        const result = work()
        db.exec('COMMIT')
        return result
    } catch (error) {
        db.exec('ROLLBACK')
        throw error
    }
}

/**
 * Re-index ONE document, leaving every other page's rows untouched.
 *
 * This is what an edit costs. Rebuilding the whole graph for one keystroke was measured at
 * ~3.9s of blocked main thread on a 2431-document graph; the derived rows of one document
 * are a few dozen inserts.
 *
 * The document's own rows are replaced wholesale rather than diffed, deliberately: block
 * `local_id`s come from parse ORDER, so inserting a single line renumbers every block after
 * it. There is no stable block identity to diff against, and at ~40 blocks a page the
 * replacement is not worth avoiding. Nothing outside this page is touched.
 */
export function ingestOne(db: SqlDb, doc: IndexDoc): void {
    inTransaction(db, () => {
        const key = conceptKey(doc.concept)
        const generation = activeIndexGeneration(db)
        const found = db.all<{ id: number }>(
            'SELECT id FROM pages WHERE generation = ? AND concept_key = ?',
            [generation, key],
        )
        let pageId: number
        if (found.length > 0) {
            pageId = found[0].id
            db.run('DELETE FROM aliases WHERE page_id = ?', [pageId])
            db.run('DELETE FROM publication_includes WHERE page_id = ?', [pageId])
            const [ftsFrom, ftsTo] = blockFtsRange(pageId)
            // A primary-key range delete, which is why the rowid encodes the page: this runs
            // on every keystroke, and a scan of the text index would not survive that.
            db.run('DELETE FROM block_fts WHERE rowid >= ? AND rowid < ?', [ftsFrom, ftsTo])
            db.run('DELETE FROM blocks WHERE page_id = ?', [pageId])
            db.run('DELETE FROM links WHERE page_id = ?', [pageId])
            db.run('DELETE FROM tasks WHERE page_id = ?', [pageId])
            db.run('DELETE FROM task_concepts WHERE page_id = ?', [pageId])
            db.run('DELETE FROM passages WHERE page_id = ?', [pageId])
            db.run('UPDATE pages SET concept = ?, kind = ?, text_hash = ?, protected = ? WHERE id = ?', [
                doc.concept,
                doc.kind,
                indexDocHash(doc),
                protectedFlag(doc),
                pageId,
            ])
        } else {
            const max = db.all<{ n: number }>('SELECT COALESCE(MAX(id), 0) AS n FROM pages')
            pageId = (max[0]?.n ?? 0) + 1
            db.run(
                'INSERT INTO pages (id, concept, concept_key, kind, text_hash, generation, protected) VALUES (?,?,?,?,?,?,?)',
                [pageId, doc.concept, key, doc.kind, indexDocHash(doc), generation, protectedFlag(doc)],
            )
        }
        insertDerived(db, pageId, doc)
    })
}

/** Every concept key that resolves to a real document (canonical name or alias). */
export function existingConceptKeys(db: SqlDb): string[] {
    const generation = activeIndexGeneration(db)
    const pages = db.all<{ k: string }>(
        'SELECT concept_key AS k FROM pages WHERE generation = ?',
        [generation],
    )
    const aliases = db.all<{ k: string }>(
        'SELECT a.alias_key AS k FROM aliases a JOIN pages p ON p.id = a.page_id WHERE p.generation = ?',
        [generation],
    )
    return [...pages, ...aliases].map((r) => r.k)
}

/** What a completion candidate resolves to. Pages/journals/aliases exist; `pageless` does not. */
export type ConceptCandidateKind = 'page' | 'journal' | 'alias' | 'pageless'

/** One row the wikilink-completion popover can offer (Dual Mode Editor.md → Wikilink completion). */
export interface ConceptCandidate {
    /** Case-preserved name shown and inserted (the alias's own name for aliases). */
    display: string
    /** Case-insensitive identity key (ADR 0011). */
    key: string
    kind: ConceptCandidateKind
    /** Aliases only: the canonical page's display name (what it resolves to). */
    canonical?: string
    /**
     * Pageless only: how many wikilink occurrences reference this concept. It is what
     * distinguishes a pageless row from a draft row in [[Quick Find]] and [[Search]] - the
     * one thing a "make this up" row can never show (ADR 0050).
     */
    references?: number
    /**
     * The document this resolves to is a [[Protected Document]] - its stored text holds a cipher
     * fence. Set on the page's own row AND on each of its aliases, since an alias row opens that
     * same document. Present only when true, so an unprotected candidate's shape is unchanged.
     *
     * This is what lets a listing - [[Search]]'s Names, the Sidebar's Favourites and Recents -
     * wear the padlock without opening anything: `open()` retains a sync engine on a Server
     * Backend, and the tab renderer already learned the hard way not to call it from a repaint.
     * It says nothing about the lock STATE; that is per graph and read from the session.
     */
    protected?: true
    /**
     * The publications whose page names this document under `includes:` (ADR 0082), sorted;
     * set on the page's own row AND on each of its aliases, as `protected` is. Present only
     * when non-empty. What lets a tab wear the "used in a publication" mark without opening
     * anything - the same reason `protected` is here rather than read from the document.
     */
    includeOf?: string[]
}

/**
 * The publication ids naming each concept key under `includes:`, over the active generation.
 * Few rows on any graph (one per slot per publication), so the whole table is read once.
 */
function includeOfByKey(db: SqlDb, generation: number): Map<string, string[]> {
    const rows = db.all<{ key: string; publication: string }>(
        `SELECT DISTINCT pi.concept_key AS key, pi.publication_id AS publication
         FROM publication_includes pi JOIN pages p ON p.id = pi.page_id
         WHERE p.generation = ? ORDER BY pi.concept_key, pi.publication_id`,
        [generation],
    )
    const out = new Map<string, string[]>()
    for (const row of rows) {
        const list = out.get(row.key)
        if (list) list.push(row.publication)
        else out.set(row.key, [row.publication])
    }
    return out
}

/** A page is named by an include under its own name or any alias; the union, sorted. */
function includeOfFor(byKey: Map<string, string[]>, keys: Iterable<string>): string[] {
    const ids = new Set<string>()
    for (const key of keys) for (const id of byKey.get(key) ?? []) ids.add(id)
    return [...ids].sort()
}

/** Attach the include flag only when set, so an ordinary candidate keeps its exact shape. */
function withIncludeOf(candidate: ConceptCandidate, includeOf: string[]): ConceptCandidate {
    return includeOf.length > 0 ? { ...candidate, includeOf } : candidate
}

/**
 * Every concept the wikilink-completion popover can offer, as one flat snapshot:
 * existing pages and journals, each alias (carrying its canonical page), and
 * `pageless` concepts — referenced by some wikilink but with no page yet ("Not yet
 * created"). Scoped concepts (display contains a nested `[[…]]`) are included — a real
 * page named e.g. `This is a [[Mini Inside]] tab` must be linkable; the popover only
 * hides them when completing *inside* a nested bracket (Dual Mode Editor.md → Wikilink
 * completion). Built fresh after each ingest by the live index, never queried per keystroke.
 */
export function conceptCandidates(db: SqlDb): ConceptCandidate[] {
    const generation = activeIndexGeneration(db)
    const pages = db.all<{ concept: string; key: string; kind: DocumentKind; protected: number }>(
        'SELECT concept, concept_key AS key, kind, protected FROM pages WHERE generation = ? ORDER BY concept_key',
        [generation],
    )
    const aliases = db.all<{ display: string; key: string; canonical: string; protected: number }>(
        'SELECT a.display AS display, a.alias_key AS key, p.concept AS canonical, p.protected AS protected FROM aliases a JOIN pages p ON p.id = a.page_id WHERE p.generation = ? ORDER BY a.alias_key',
        [generation],
    )
    // SQLite was previously asked to run two correlated anti-joins for every link row. On a
    // fully hydrated 2,400-document graph that made each persisted-index open spend several
    // seconds rebuilding this same cache. We already have the complete page and alias sets
    // above, so group link targets once and perform the inexpensive membership test in JS.
    //
    // The display is the MAJORITY casing among the concept's wikilink instances, not an
    // arbitrary one: a [[Draft]] shows this name from the moment it opens and promotes with
    // it, so it decides the page's canonical name (ADR 0050). Ties break on BINARY collation,
    // which puts the Title-Cased variant first - the right default for a page title.
    const referenced = db.all<{ display: string; key: string; references: number }>(
        `SELECT key, display, refs AS "references" FROM (
           SELECT l.concept_key AS key, l.concept AS display,
                  SUM(COUNT(*)) OVER (PARTITION BY l.concept_key) AS refs,
                  ROW_NUMBER() OVER (
                      PARTITION BY l.concept_key ORDER BY COUNT(*) DESC, l.concept ASC
                  ) AS rn
           FROM links l JOIN pages source ON source.id = l.page_id
           WHERE source.generation = ?
           GROUP BY l.concept_key, l.concept
         ) WHERE rn = 1 ORDER BY key`,
        [generation],
    )
    const existing = new Set([...pages.map((page) => page.key), ...aliases.map((alias) => alias.key)])
    // An include names a page by any of its names, so a page's flag is the union over its own
    // key and its aliases', and each alias row wears the same flag as its page.
    const includes = includeOfByKey(db, generation)
    const aliasKeysOfPage = new Map<string, string[]>()
    for (const alias of aliases) {
        const pageKey = conceptKey(alias.canonical)
        const list = aliasKeysOfPage.get(pageKey)
        if (list) list.push(alias.key)
        else aliasKeysOfPage.set(pageKey, [alias.key])
    }
    const includeOfPage = (pageKey: string) => includeOfFor(includes, [pageKey, ...(aliasKeysOfPage.get(pageKey) ?? [])])
    const out: ConceptCandidate[] = []
    for (const page of pages) {
        out.push(withIncludeOf(withProtected({ display: page.concept, key: page.key, kind: page.kind }, page.protected), includeOfPage(page.key)))
    }
    for (const alias of aliases) {
        out.push(
            withIncludeOf(
                withProtected(
                    { display: alias.display, key: alias.key, kind: 'alias', canonical: alias.canonical },
                    alias.protected,
                ),
                includeOfPage(conceptKey(alias.canonical)),
            ),
        )
    }
    for (const link of referenced) {
        if (!existing.has(link.key)) {
            out.push({
                display: link.display,
                key: link.key,
                kind: 'pageless',
                references: link.references,
            })
        }
    }
    return out
}

/** Attach the padlock flag only when set, so unprotected candidates keep their exact shape. */
function withProtected(candidate: ConceptCandidate, flag: number): ConceptCandidate {
    return flag ? { ...candidate, protected: true } : candidate
}

/** Resolve only the candidate keys affected by one document ingest. */
export function conceptCandidatesForKeys(
    db: SqlDb,
    keys: Iterable<string>,
): Map<string, ConceptCandidate> {
    const generation = activeIndexGeneration(db)
    const result = new Map<string, ConceptCandidate>()
    // Read lazily: most ingests touch no publication page, and the table is small when read.
    let includes: Map<string, string[]> | null = null
    const includeOfPage = (pageId: number, pageKey: string): string[] => {
        includes ??= includeOfByKey(db, generation)
        if (includes.size === 0) return []
        const aliasKeys = db.all<{ key: string }>('SELECT alias_key AS key FROM aliases WHERE page_id=?', [pageId]).map((row) => row.key)
        return includeOfFor(includes, [pageKey, ...aliasKeys])
    }
    for (const key of new Set(keys)) {
        const page = db.all<{ id: number; concept: string; kind: DocumentKind; protected: number }>(
            'SELECT id, concept, kind, protected FROM pages WHERE generation=? AND concept_key=? LIMIT 1',
            [generation, key],
        )[0]
        if (page) {
            result.set(key, withIncludeOf(withProtected({ display: page.concept, key, kind: page.kind }, page.protected), includeOfPage(page.id, key)))
            continue
        }
        const alias = db.all<{ display: string; canonical: string; protected: number; pageId: number }>(
            `SELECT a.display, p.concept AS canonical, p.protected AS protected, p.id AS pageId
             FROM aliases a JOIN pages p ON p.id=a.page_id
             WHERE p.generation=? AND a.alias_key=? LIMIT 1`,
            [generation, key],
        )[0]
        if (alias) {
            result.set(
                key,
                withIncludeOf(
                    withProtected(
                        { display: alias.display, key, kind: 'alias', canonical: alias.canonical },
                        alias.protected,
                    ),
                    includeOfPage(alias.pageId, conceptKey(alias.canonical)),
                ),
            )
            continue
        }
        // Majority casing and occurrence count, exactly as `conceptCandidates` derives them
        // for the full snapshot — the two must agree or a candidate would change name when
        // one document is re-ingested.
        const pageless = db.all<{ display: string; references: number }>(
            `SELECT display, refs AS "references" FROM (
               SELECT l.concept AS display,
                      SUM(COUNT(*)) OVER () AS refs,
                      ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC, l.concept ASC) AS rn
               FROM links l JOIN pages p ON p.id=l.page_id
               WHERE p.generation=? AND l.concept_key=?
               GROUP BY l.concept
             ) WHERE rn = 1`,
            [generation, key],
        )[0]
        if (pageless) {
            result.set(key, {
                display: pageless.display,
                key,
                kind: 'pageless',
                references: pageless.references,
            })
        }
    }
    return result
}

export interface IndexedDocumentFacts {
    aliases: string[]
    linkTargets: string[]
    /** The concept keys this document names under `includes:`, when it is a publication page. */
    includeTargets: string[]
}

export function indexedDocumentFacts(db: SqlDb, key: string): IndexedDocumentFacts {
    const generation = activeIndexGeneration(db)
    const page = db.all<{ id: number }>(
        'SELECT id FROM pages WHERE generation=? AND concept_key=? LIMIT 1',
        [generation, key],
    )[0]
    if (!page) return { aliases: [], linkTargets: [], includeTargets: [] }
    return {
        aliases: db
            .all<{ key: string }>('SELECT alias_key AS key FROM aliases WHERE page_id=?', [
                page.id,
            ])
            .map((row) => row.key),
        linkTargets: db
            .all<{ key: string }>(
                'SELECT DISTINCT concept_key AS key FROM links WHERE page_id=?',
                [page.id],
            )
            .map((row) => row.key),
        includeTargets: db
            .all<{ key: string }>(
                'SELECT DISTINCT concept_key AS key FROM publication_includes WHERE page_id=? ORDER BY concept_key',
                [page.id],
            )
            .map((row) => row.key),
    }
}

/**
 * Every key a concept answers to - its page's own key and its aliases' - so a fact about a
 * document named one way lands on every candidate row that opens it. A key with no page is
 * just itself.
 */
export function conceptFamilyKeys(db: SqlDb, key: string): string[] {
    const pageId = canonicalPageId(db, key)
    return pageId === null ? [key] : namesForPage(db, pageId)
}

export function indexDocumentFactKeys(doc: IndexDoc): IndexedDocumentFacts {
    return {
        aliases: doc.aliases.map(conceptKey),
        linkTargets: [
            ...new Set([
                ...deriveTitleLinks(doc.concept).map((link) => conceptKey(link.concept)),
                ...deriveDoc(doc.text).links.map((link) => conceptKey(link.concept)),
            ]),
        ],
        includeTargets: [...new Set((doc.includes ?? []).map((include) => conceptKey(include.concept)))].sort(),
    }
}

export function conceptExists(db: SqlDb, concept: string): boolean {
    const key = conceptKey(concept)
    const generation = activeIndexGeneration(db)
    const hit = db.all<{ n: number }>(
        `SELECT (
            EXISTS(SELECT 1 FROM pages WHERE generation=? AND concept_key=?)
            OR EXISTS(
                SELECT 1 FROM aliases a JOIN pages p ON p.id=a.page_id
                WHERE p.generation=? AND a.alias_key=?
            )
        ) AS n`,
        [generation, key, generation, key],
    )
    return !!hit[0]?.n
}

/** The canonical page id a concept resolves to (by its own name or an alias), or null. */
function canonicalPageId(db: SqlDb, key: string): number | null {
    const generation = activeIndexGeneration(db)
    const direct = db.all<{ id: number }>(
        'SELECT id FROM pages WHERE generation=? AND concept_key=? LIMIT 1',
        [generation, key],
    )
    if (direct[0]) return direct[0].id
    const viaAlias = db.all<{ id: number }>(
        `SELECT a.page_id AS id FROM aliases a JOIN pages p ON p.id=a.page_id
         WHERE p.generation=? AND a.alias_key=? LIMIT 1`,
        [generation, key],
    )
    return viaAlias[0]?.id ?? null
}

/** All concept keys that target the same page (its own name + aliases). */
function namesForPage(db: SqlDb, pageId: number): string[] {
    const page = db.all<{ k: string }>('SELECT concept_key AS k FROM pages WHERE id=?', [pageId])
    const aliases = db.all<{ k: string }>('SELECT alias_key AS k FROM aliases WHERE page_id=?', [pageId])
    return [...page.map((r) => r.k), ...aliases.map((r) => r.k)]
}

interface LinkHit {
    page_id: number
    sourceConcept: string
    sourceKind: DocumentKind
    line: number
    line_text: string
    match_start: number
    match_end: number
    block_local_id: number | null
    in_title: number
}

/** Ancestor labels of a block, root-first. `headingsOnly` keeps just the heading tree. */
function ancestorLabels(blocks: BlockRow[], id: number, headingsOnly: boolean): string[] {
    const out: string[] = []
    let cur = blocks[id]?.parentId ?? null
    while (cur !== null) {
        const b = blocks[cur]
        if (!b) break
        if (!headingsOnly || b.kind === 'heading') out.unshift(b.label)
        cur = b.parentId
    }
    return out
}

/** The matched block plus its descendant subtree (Logseq block-reference behaviour). */
function collectSubtree(blocks: BlockRow[], rootId: number): RefSubtreeNode[] {
    const childrenByParent = new Map<number, BlockRow[]>()
    for (const block of blocks) {
        if (!block || block.parentId === null) continue
        const children = childrenByParent.get(block.parentId) ?? []
        children.push(block)
        childrenByParent.set(block.parentId, children)
    }
    for (const children of childrenByParent.values()) {
        children.sort((a, b) => a.ord - b.ord)
    }
    const out: RefSubtreeNode[] = []
    const walk = (id: number, depth: number) => {
        const b = blocks[id]
        if (!b) return
        out.push({ text: blockContent(b), depth, isMatch: id === rootId, ...(b.kind === 'task' ? { done: b.done === true } : {}) })
        for (const child of childrenByParent.get(id) ?? []) walk(child.localId, depth + 1)
    }
    walk(rootId, 0)
    return out
}

/**
 * Widen `[start, end)` so that neither end falls inside a complete fenced code block. Half a code
 * block is no excerpt at all, and an opener cut from its closer would render as raw backticks.
 */
function widenToFences(text: string, start: number, end: number): [number, number] {
    const lines = text.split('\n')
    const lineStarts: number[] = []
    let offset = 0
    for (const line of lines) {
        lineStarts.push(offset)
        offset += line.length + 1
    }
    for (const fence of fencedBlocks(lines)) {
        const from = lineStarts[fence.start]
        const to = lineStarts[fence.end] + lines[fence.end].length
        if (start > from && start < to) start = from
        if (end > from && end < to) end = to
    }
    return [start, end]
}

/**
 * Truncate `text` to MAX_CONTEXT chars centred on the match, with ellipses. The window grows past
 * MAX_CONTEXT rather than cut a fenced code block in two ({@link widenToFences}).
 */
function truncateContext(text: string, matchStart: number, matchEnd: number): RefContext {
    if (text.length <= MAX_CONTEXT) return { text, matchStart, matchEnd, truncated: false }
    const mid = Math.floor((matchStart + matchEnd) / 2)
    const windowStart = Math.max(0, mid - Math.floor(MAX_CONTEXT / 2))
    const windowEnd = Math.min(text.length, windowStart + MAX_CONTEXT)
    const [start, end] = widenToFences(text, Math.max(0, windowEnd - MAX_CONTEXT), windowEnd)
    // An ellipsis at a line boundary takes a line of its own: glued to a fence line (`…```ts`)
    // it would stop that line being a fence.
    const prefix = start === 0 ? '' : text[start - 1] === '\n' ? '…\n' : '…'
    const suffix = end === text.length ? '' : text[end] === '\n' ? '\n…' : '…'
    const shift = prefix.length - start
    return {
        text: prefix + text.slice(start, end) + suffix,
        matchStart: Math.max(0, matchStart + shift),
        matchEnd: Math.max(0, matchEnd + shift),
        truncated: prefix !== '' || suffix !== '',
    }
}

/** Build a reference: a block subtree for bullets/tasks, prose context otherwise. */
function buildRef(h: LinkHit, blocks: BlockRow[]): DbBacklinkRef {
    const base = { sourceConcept: h.sourceConcept, sourceKind: h.sourceKind, line: h.line }
    if (h.in_title) {
        return {
            ...base,
            kind: 'title',
            breadcrumb: [],
            subtree: [],
            context: { text: h.line_text, matchStart: h.match_start, matchEnd: h.match_end, truncated: false },
        }
    }
    const block = h.block_local_id != null ? blocks[h.block_local_id] : undefined

    if (block && (block.kind === 'bullet' || block.kind === 'task')) {
        return {
            ...base,
            kind: 'block',
            breadcrumb: ancestorLabels(blocks, block.localId, false),
            subtree: collectSubtree(blocks, block.localId),
            context: null,
        }
    }

    // Prose (paragraph / heading / no block): the surrounding text + the heading tree.
    const source = block?.text ?? h.line_text
    const matchText = h.line_text.slice(h.match_start, h.match_end)
    const offset = source.indexOf(matchText)
    const ms = offset >= 0 ? offset : 0
    const me = offset >= 0 ? offset + matchText.length : 0
    return {
        ...base,
        kind: 'prose',
        breadcrumb: block ? ancestorLabels(blocks, block.localId, true) : [],
        subtree: [],
        context: truncateContext(source, ms, me),
    }
}

/**
 * All references to a concept, pooled across its own name and aliases
 * (case-insensitive), grouped by source document (journals newest-first, then pages).
 * Each ref renders as a Logseq-style block subtree (bullets) or prose context
 * (paragraphs/headings) — see {@link DbBacklinkRef}. Replaces the in-memory index.
 */
export function backlinksFor(db: SqlDb, concept: string): DbBacklinkGroup[] {
    const key = conceptKey(concept)
    const pageId = canonicalPageId(db, key)
    const names = pageId === null ? [key] : namesForPage(db, pageId)
    if (names.length === 0) return []

    const placeholders = names.map(() => '?').join(',')
    const generation = activeIndexGeneration(db)
    const hits = db.all<LinkHit>(
        `SELECT l.page_id, p.concept AS sourceConcept, p.kind AS sourceKind, l.line, l.line_text,
                l.match_start, l.match_end, l.block_local_id, l.in_title
         FROM links l JOIN pages p ON p.id = l.page_id
         WHERE p.generation=? AND l.concept_key IN (${placeholders})`,
        [generation, ...names],
    )

    // Fetch full block rows for the involved pages once (ancestry + subtree + text).
    const blocksByPage = new Map<number, BlockRow[]>()
    for (const pid of new Set(hits.map((h) => h.page_id))) {
        const rows = db.all<{
            local_id: number
            parent_local_id: number | null
            ord: number
            kind: BlockRow['kind']
            depth: number
            done: number | null
            label: string
            text: string
        }>(
            'SELECT local_id, parent_local_id, ord, kind, depth, done, label, text FROM blocks WHERE page_id=? ORDER BY local_id',
            [pid],
        )
        const blocks: BlockRow[] = []
        for (const r of rows) {
            blocks[r.local_id] = {
                localId: r.local_id,
                parentId: r.parent_local_id,
                ord: r.ord,
                kind: r.kind,
                depth: r.depth,
                ...(r.done === null ? {} : { done: r.done === 1 }),
                startLine: 0,
                endLine: 0,
                text: r.text,
                label: r.label,
            }
        }
        blocksByPage.set(pid, blocks)
    }

    const groups = new Map<string, DbBacklinkGroup>()
    for (const h of hits) {
        let group = groups.get(h.sourceConcept)
        if (!group) {
            group = { sourceConcept: h.sourceConcept, sourceKind: h.sourceKind, refs: [] }
            groups.set(h.sourceConcept, group)
        }
        group.refs.push(buildRef(h, blocksByPage.get(h.page_id) ?? []))
    }
    // The title first - it is above every line - then the body in line order.
    const rank = (ref: DbBacklinkRef) => (ref.kind === 'title' ? 0 : 1)
    for (const g of groups.values()) g.refs.sort((a, b) => rank(a) - rank(b) || a.line - b.line)
    return [...groups.values()].sort(compareGroups)
}

/** Journals first (date desc), then pages (concept asc, case-insensitive). */
function compareGroups(a: DbBacklinkGroup, b: DbBacklinkGroup): number {
    if (a.sourceKind !== b.sourceKind) return a.sourceKind === 'journal' ? -1 : 1
    if (a.sourceKind === 'journal') return b.sourceConcept.localeCompare(a.sourceConcept)
    return conceptKey(a.sourceConcept).localeCompare(conceptKey(b.sourceConcept))
}

// ---- [[Search]]: the text group ------------------------------------------------------

import {
    buildFtsMatch,
    MATCH_CLOSE,
    MATCH_OPEN,
    snippetSegments,
    type SearchSegment,
} from './search-query'

/** Matching documents counted beyond this are reported as "1000+" rather than tallied. */
export const SEARCH_COUNT_CAP = 1000

/** Matching blocks shown per document before the "+N more" expander. */
export const SEARCH_HITS_PER_DOCUMENT = 3

/** Roughly two lines of context around a match, in tokens. */
const SNIPPET_TOKENS = 24

/** One matching [[Block]] — a locator, not something to read in place. */
export interface SearchBlockHit {
    /** 0-based source line, for opening the document at this block. */
    line: number
    /** Ancestor labels, root-first. A bare bullet is often meaningless without them. */
    breadcrumb: string[]
    /** The snippet, pre-split into plain and matched runs. Never HTML. */
    snippet: SearchSegment[]
}

/** One document's matches, which is what a Text result row actually is. */
export interface SearchDocumentGroup {
    concept: string
    kind: DocumentKind
    /** Every matching block in this document, not just the ones listed in `hits`. */
    matches: number
    hits: SearchBlockHit[]
}

export interface SearchTextPage {
    groups: SearchDocumentGroup[]
    /** True when a further page exists — from fetching one row beyond the limit. */
    hasMore: boolean
}

/**
 * Documents whose text matches `query`, most-mentions-first, one page at a time.
 *
 * Ordering is **matching-block count**, with `bm25()` only as a tie-break. Ranking by best
 * block instead would be the obvious choice and is wrong here: the FTS rows are blocks, so
 * bm25 scores how much a *block* is about the term, which rewards short ones - a one-line
 * `see [[Orphaned Asset]]` outranks the page that explains orphaned assets. Summing block
 * scores merely reintroduces the long-document bias bm25 exists to remove. Counting is cruder,
 * robust, and explainable in one sentence - and it orders by a number the row displays.
 */
export function searchText(
    db: SqlDb,
    query: string,
    offset: number,
    limit: number,
): SearchTextPage {
    const match = buildFtsMatch(query)
    if (match === null) return { groups: [], hasMore: false }
    const generation = activeIndexGeneration(db)

    // One extra row decides `hasMore` without a second COUNT.
    const ranked = db.all<{ page_id: number; matches: number }>(
        // MATERIALIZED is load-bearing, not a hint: an FTS5 auxiliary function like bm25()
        // is only legal where the virtual table is queried directly, and the planner would
        // otherwise flatten this subquery into the join and reject it outright.
        `WITH hits AS MATERIALIZED (
           SELECT rowid / ${BLOCK_FTS_STRIDE} AS page_id, bm25(block_fts) AS score
           FROM block_fts WHERE block_fts MATCH ?
         )
         SELECT h.page_id AS page_id, COUNT(*) AS matches, MIN(h.score) AS best
         FROM hits h
         JOIN pages p ON p.id = h.page_id AND p.generation = ?
         GROUP BY h.page_id
         ORDER BY matches DESC, best ASC, h.page_id ASC
         LIMIT ? OFFSET ?`,
        [match, generation, limit + 1, offset],
    )
    const hasMore = ranked.length > limit
    const page = hasMore ? ranked.slice(0, limit) : ranked
    if (page.length === 0) return { groups: [], hasMore: false }

    const ids = page.map((row) => row.page_id)
    const placeholders = ids.map(() => '?').join(',')
    const pages = new Map(
        db
            .all<{ id: number; concept: string; kind: DocumentKind }>(
                `SELECT id, concept, kind FROM pages WHERE id IN (${placeholders})`,
                ids,
            )
            .map((row) => [row.id, row]),
    )
    // Ancestry for the whole page of documents in one read; the breadcrumb is walked in JS.
    const blocks = db.all<{
        page_id: number
        local_id: number
        parent_local_id: number | null
        label: string
        start_line: number
    }>(
        `SELECT page_id, local_id, parent_local_id, label, start_line FROM blocks
         WHERE page_id IN (${placeholders})`,
        ids,
    )
    const byPage = new Map<number, Map<number, (typeof blocks)[number]>>()
    for (const block of blocks) {
        let map = byPage.get(block.page_id)
        if (!map) byPage.set(block.page_id, (map = new Map()))
        map.set(block.local_id, block)
    }

    const groups: SearchDocumentGroup[] = []
    for (const row of page) {
        const meta = pages.get(row.page_id)
        if (!meta) continue
        const [from, to] = blockFtsRange(row.page_id)
        // Document order, not relevance order: a list of locators reads top-to-bottom.
        const hits = db.all<{ rowid: number; snippet: string }>(
            `SELECT rowid, snippet(block_fts, 0, ?, ?, '…', ${SNIPPET_TOKENS}) AS snippet
             FROM block_fts
             WHERE block_fts MATCH ? AND rowid >= ? AND rowid < ?
             ORDER BY rowid LIMIT ?`,
            [MATCH_OPEN, MATCH_CLOSE, match, from, to, SEARCH_HITS_PER_DOCUMENT],
        )
        const blockMap = byPage.get(row.page_id)
        groups.push({
            concept: meta.concept,
            kind: meta.kind,
            matches: row.matches,
            hits: hits.map((hit) => {
                const localId = hit.rowid - from
                const block = blockMap?.get(localId)
                return {
                    line: block?.start_line ?? 0,
                    breadcrumb: blockMap ? searchBreadcrumb(blockMap, localId) : [],
                    snippet: snippetSegments(hit.snippet),
                }
            }),
        })
    }
    return { groups, hasMore }
}

/**
 * Ancestor labels of a block, root-first, from the flat map `searchText` already loaded.
 * Distinct from the same-named helper above, which walks the in-memory derivation's rows.
 */
function searchBreadcrumb(
    blocks: Map<number, { parent_local_id: number | null; label: string }>,
    localId: number,
): string[] {
    const chain: string[] = []
    let parent = blocks.get(localId)?.parent_local_id ?? null
    // Bounded by the map size: a corrupt parent cycle must not hang the worker.
    for (let guard = 0; parent !== null && guard <= blocks.size; guard++) {
        const block = blocks.get(parent)
        if (!block) break
        chain.unshift(block.label)
        parent = block.parent_local_id
    }
    return chain
}

/**
 * How many documents match, capped at {@link SEARCH_COUNT_CAP}.
 *
 * Capped rather than exact because a prefix query - which is every query, mid-typing - can
 * match most of the graph, and this runs beside the rows it must never delay.
 */
export function searchTextCount(db: SqlDb, query: string): { total: number; capped: boolean } {
    const match = buildFtsMatch(query)
    if (match === null) return { total: 0, capped: false }
    const rows = db.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM (
           SELECT m.page_id FROM (
             SELECT DISTINCT rowid / ${BLOCK_FTS_STRIDE} AS page_id FROM block_fts
             WHERE block_fts MATCH ?
           ) m
           JOIN pages p ON p.id = m.page_id AND p.generation = ?
           LIMIT ?)`,
        [match, activeIndexGeneration(db), SEARCH_COUNT_CAP + 1],
    )
    const n = rows[0]?.n ?? 0
    return n > SEARCH_COUNT_CAP ? { total: SEARCH_COUNT_CAP, capped: true } : { total: n, capped: false }
}

// ── Asset usage ─────────────────────────────────────────────────────────────

/** One document that holds at least one [[Asset Reference]] to the asset asked about. */
export interface AssetUsageDocument {
    concept: string
    kind: DocumentKind
    /** How many references this document holds — two images of one asset count as two. */
    references: number
}

export interface AssetUsage {
    /** References across the whole graph, including the one the caller is standing on. */
    references: number
    /** The documents holding them, in concept order so the dialog reads the same every time. */
    documents: AssetUsageDocument[]
}

/** Escape a literal for a LIKE pattern, so an asset name can never behave as a wildcard. */
function likeLiteral(needle: string): string {
    return needle.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** Occurrences of `needle` in `text`, non-overlapping. */
function occurrences(text: string, needle: string): number {
    let n = 0
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) n += 1
    return n
}

/**
 * Which documents reference an [[Asset]], and how many times — the safety gate in front of a
 * permanent delete (ADR 0054). `needles` are the forms the reference can be written in: the
 * asset's identity (its on-disk name on a [[Filesystem Backend]], its id on a [[Server
 * Backend]]) and, when it differs, the percent-encoded form.
 *
 * Deliberately a **substring scan of every block's source**, not a search over `block_fts`:
 * the text index tokenises, so it cannot be trusted to match a punctuated file name, and a
 * missed match here would destroy bytes another document still needs. The same conservative
 * rule the [[Orphaned Asset]] scanners use — a mention anywhere counts, fences and prose
 * alike — for the same reason: over-counting refuses a delete, under-counting loses data.
 *
 * `blocks` carries no index on `text`, so this is a scan. That is the right shape: on the
 * largest graph this was built against it is ~85k rows inside the index worker, tens of
 * milliseconds, and it runs once per trash click rather than per keystroke.
 */
export function assetUsage(db: SqlDb, needles: readonly string[]): AssetUsage {
    const distinct = [...new Set(needles)].filter((n) => n.length > 0)
    if (distinct.length === 0) return { references: 0, documents: [] }
    const where = distinct.map(() => `b.text LIKE ? ESCAPE '\\'`).join(' OR ')
    const rows = db.all<{ concept: string; kind: DocumentKind; text: string }>(
        `SELECT p.concept AS concept, p.kind AS kind, b.text AS text
           FROM blocks b
           JOIN pages p ON p.id = b.page_id AND p.generation = ?
          WHERE ${where}`,
        [activeIndexGeneration(db), ...distinct.map((n) => `%${likeLiteral(n)}%`)],
    )

    // Count in JS rather than SQL: one block can hold two references to the same asset, and
    // "used in more than one place" has to see both.
    const byConcept = new Map<string, AssetUsageDocument>()
    let references = 0
    for (const row of rows) {
        const n = distinct.reduce((sum, needle) => sum + occurrences(row.text, needle), 0)
        if (n === 0) continue
        references += n
        const existing = byConcept.get(row.concept)
        if (existing) existing.references += n
        else byConcept.set(row.concept, { concept: row.concept, kind: row.kind, references: n })
    }
    return {
        references,
        documents: [...byConcept.values()].sort((a, b) => a.concept.localeCompare(b.concept)),
    }
}

// ── The Tasks View ──────────────────────────────────────────────────────────

/**
 * The five [[Task]] states, as a partition. They are mutually exclusive by construction, so
 * a task is in exactly one and the Status chips can be a plain multi-select:
 *
 *   waiting   open and `#W`                doing  open, `#D`, not `#W`
 *   open      open and neither             done   checked, not `#C`
 *   cancelled checked and `#C`
 *
 * `cancelled` earns a state of its own because ADR 0032 makes a cancelled task *checked* -
 * without one it would hide inside `done` with no way to ask for it or exclude it.
 */
export type TaskStatus = 'open' | 'doing' | 'waiting' | 'done' | 'cancelled'

export const TASK_STATUSES: readonly TaskStatus[] = ['open', 'doing', 'waiting', 'done', 'cancelled']

/** The states a task that is not finished can be in - the Tasks View's default selection. */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['open', 'doing', 'waiting']

/** A priority chip. `null` is the real, selectable "no priority" bucket, not "unset". */
export type TaskPriorityFilter = 1 | 2 | 3 | null

export const TASK_PRIORITY_FILTERS: readonly TaskPriorityFilter[] = [1, 2, 3, null]

export type TaskDueWindow = 'any' | 'overdue' | 'today' | 'next7'

export type TaskGroupBy = 'document' | 'priority' | 'due'

export interface TaskQuery {
    /** The [[Name Filter]]'s selection, or null for every task in the graph. */
    concept: string | null
    statuses: readonly TaskStatus[]
    priorities: readonly TaskPriorityFilter[]
    due: TaskDueWindow
    groupBy: TaskGroupBy
    /**
     * Today as `YYYY-MM-DD`, supplied by the caller rather than read from the clock here.
     * The query then stays a pure function of its inputs - which is what makes the date
     * windows testable, and what keeps the worker from having an opinion about the user's
     * timezone, which only the tab knows.
     */
    today: string
}

/** One task, as the [[Tasks View]] renders it. */
export interface TaskHit {
    /** Identity for the ticked-in-this-session set, and the write-back coordinates. */
    pageId: number
    blockLocalId: number
    /** The source document's concept - the ViewRef target to open, and the Document group. */
    concept: string
    kind: DocumentKind
    /** 0-based source line, for `revealLine` and for the write-back's stale-line guard. */
    line: number
    done: boolean
    /** The block label with its [[Task Tag]] run still on it, exactly as authored. */
    text: string
    priority: number | null
    waiting: boolean
    doing: boolean
    cancelled: boolean
    due: string | null
    completion: string | null
    scheduled: string | null
    /** Ancestor labels, root-first - why this task matched, when it matched via an ancestor. */
    breadcrumb: string[]
}

export interface TaskPage {
    hits: TaskHit[]
    /** True when a further page exists - from fetching one row beyond the limit. */
    hasMore: boolean
}

/** `YYYY-MM-DD` for a local date, `days` from it. Local, because "today" is the user's. */
export function taskDateKey(date: Date, days = 0): string {
    const shifted = new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
    const month = String(shifted.getMonth() + 1).padStart(2, '0')
    const day = String(shifted.getDate()).padStart(2, '0')
    return `${shifted.getFullYear()}-${month}-${day}`
}

/** The SQL predicate for one status, over the `tasks` columns. */
const STATUS_SQL: Record<TaskStatus, string> = {
    open: '(t.done = 0 AND t.waiting = 0 AND t.doing = 0)',
    doing: '(t.done = 0 AND t.doing = 1 AND t.waiting = 0)',
    waiting: '(t.done = 0 AND t.waiting = 1)',
    done: '(t.done = 1 AND t.cancelled = 0)',
    cancelled: '(t.done = 1 AND t.cancelled = 1)',
}

/**
 * Ordering per grouping. The FIRST key must be the group key, because the view splits an
 * already-ordered page into groups rather than re-sorting - which is what lets a group
 * straddle a page boundary and simply continue.
 *
 * Within a group the order is due-date then priority (AS Notes' behaviour), with NULLs last
 * both times: an undated task is not urgent, and SQLite would otherwise sort NULL first.
 * `page_id, block_local_id` finally makes the order total, so paging cannot repeat or skip.
 */
const WITHIN_GROUP = '(t.due IS NULL), t.due ASC, (t.priority IS NULL), t.priority ASC'
const ORDER_SQL: Record<TaskGroupBy, string> = {
    document: `p.concept_key ASC, ${WITHIN_GROUP}`,
    priority: `(t.priority IS NULL), t.priority ASC, (t.due IS NULL), t.due ASC`,
    due: `(t.due IS NULL), t.due ASC, (t.priority IS NULL), t.priority ASC`,
}

interface TaskRowResult {
    page_id: number
    concept: string
    kind: DocumentKind
    block_local_id: number
    line: number
    done: number
    text: string
    priority: number | null
    waiting: number
    doing: number
    cancelled: number
    due: string | null
    completion: string | null
    scheduled: string | null
}


/**
 * The WHERE clause and parameters shared by {@link tasksMatching} and its count, so the two
 * can never drift into answering different questions about the same filter.
 *
 * Returns null when the filter cannot match anything - an empty Status or Priority selection
 * (a genuine "show me nothing", not a missing value), or a [[Name Filter]] naming a concept
 * with no page and no links.
 */
function taskPredicate(db: SqlDb, query: TaskQuery): { where: string; params: unknown[] } | null {
    if (query.statuses.length === 0 || query.priorities.length === 0) return null

    const where: string[] = ['p.generation = ?']
    const params: unknown[] = [activeIndexGeneration(db)]

    if (query.concept !== null) {
        // The [[Name Filter]] resolves to a page and matches EVERY name that page answers to
        // (its own plus [[Alias]]es), the pooling backlinksFor performs - so filtering by an
        // alias finds tasks written against the canonical name and vice versa. A name with no
        // page is a [[Pageless Concept]] and matches only itself, which is right: it has none.
        const key = conceptKey(query.concept)
        const pageId = canonicalPageId(db, key)
        const names = pageId === null ? [key] : namesForPage(db, pageId)
        if (names.length === 0) return null
        where.push(
            `EXISTS (SELECT 1 FROM task_concepts tc
                     WHERE tc.page_id = t.page_id AND tc.block_local_id = t.block_local_id
                       AND tc.concept_key IN (${names.map(() => '?').join(',')}))`,
        )
        params.push(...names)
    }

    if (query.statuses.length < TASK_STATUSES.length) {
        where.push(`(${query.statuses.map((s) => STATUS_SQL[s]).join(' OR ')})`)
    }

    if (query.priorities.length < TASK_PRIORITY_FILTERS.length) {
        const levels = query.priorities.filter((p): p is 1 | 2 | 3 => p !== null)
        const clauses: string[] = []
        if (levels.length > 0) {
            clauses.push(`t.priority IN (${levels.map(() => '?').join(',')})`)
            params.push(...levels)
        }
        if (query.priorities.includes(null)) clauses.push('t.priority IS NULL')
        where.push(`(${clauses.join(' OR ')})`)
    }

    if (query.due !== 'any') {
        const today = query.today
        if (query.due === 'overdue') {
            where.push('(t.due IS NOT NULL AND t.due < ?)')
            params.push(today)
        } else if (query.due === 'today') {
            where.push('t.due = ?')
            params.push(today)
        } else {
            where.push('(t.due IS NOT NULL AND t.due >= ? AND t.due <= ?)')
            params.push(today, addDays(today, 7))
        }
    }

    return { where: where.join(' AND '), params }
}

interface TaskRowResult {
    page_id: number
    concept: string
    kind: DocumentKind
    block_local_id: number
    line: number
    done: number
    text: string
    priority: number | null
    waiting: number
    doing: number
    cancelled: number
    due: string | null
    completion: string | null
    scheduled: string | null
}

/**
 * One page of [[Task]]s matching a [[Tasks View]] query, ordered so the caller groups by
 * simply walking the rows in order.
 *
 * Every row carries its ancestor breadcrumb, which the [[Tasks View]] is not decorating with:
 * under ADR 0051 a task can match through a distant ancestor - a heading, most visibly - so
 * without the chain a legitimately matching row looks like a bug.
 */
export function tasksMatching(db: SqlDb, query: TaskQuery, offset: number, limit: number): TaskPage {
    const predicate = taskPredicate(db, query)
    if (predicate === null) return { hits: [], hasMore: false }

    // One extra row decides `hasMore` without a second COUNT, as searchText does.
    const rows = db.all<TaskRowResult>(
        `SELECT t.page_id, p.concept, p.kind, t.block_local_id, t.line, t.done, t.text,
                t.priority, t.waiting, t.doing, t.cancelled, t.due, t.completion, t.scheduled
         FROM tasks t JOIN pages p ON p.id = t.page_id
         WHERE ${predicate.where}
         ORDER BY ${ORDER_SQL[query.groupBy]}, t.page_id ASC, t.block_local_id ASC
         LIMIT ? OFFSET ?`,
        [...predicate.params, limit + 1, offset],
    )
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    if (page.length === 0) return { hits: [], hasMore: false }

    const breadcrumbs = breadcrumbsFor(db, page)
    return {
        hits: page.map((row) => ({
            ...toHit(row),
            breadcrumb: breadcrumbs.get(row.page_id)?.get(row.block_local_id) ?? [],
        })),
        hasMore,
    }
}

/**
 * Ancestor labels for a whole page of tasks: one read for every document involved, then the
 * chains walked in JS. The same shape searchText uses, and for the same reason - a recursive
 * SQL walk per row would be one query per task.
 */
function breadcrumbsFor(db: SqlDb, rows: readonly TaskRowResult[]): Map<number, Map<number, string[]>> {
    const ids = [...new Set(rows.map((row) => row.page_id))]
    const placeholders = ids.map(() => '?').join(',')
    const blocks = db.all<{
        page_id: number
        local_id: number
        parent_local_id: number | null
        label: string
    }>(
        `SELECT page_id, local_id, parent_local_id, label FROM blocks WHERE page_id IN (${placeholders})`,
        ids,
    )
    const byPage = new Map<number, Map<number, { parent_local_id: number | null; label: string }>>()
    for (const block of blocks) {
        let page = byPage.get(block.page_id)
        if (!page) byPage.set(block.page_id, (page = new Map()))
        page.set(block.local_id, { parent_local_id: block.parent_local_id, label: block.label })
    }
    const out = new Map<number, Map<number, string[]>>()
    for (const row of rows) {
        const page = byPage.get(row.page_id)
        if (!page) continue
        let chains = out.get(row.page_id)
        if (!chains) out.set(row.page_id, (chains = new Map()))
        chains.set(row.block_local_id, searchBreadcrumb(page, row.block_local_id))
    }
    return out
}

/** How many tasks match. Uncapped: this counts an indexed join, not a text index. */
export function tasksMatchingCount(db: SqlDb, query: TaskQuery): number {
    const predicate = taskPredicate(db, query)
    if (predicate === null) return 0
    const rows = db.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM tasks t JOIN pages p ON p.id = t.page_id WHERE ${predicate.where}`,
        predicate.params,
    )
    return rows[0]?.n ?? 0
}

/** `YYYY-MM-DD` shifted by whole days, so the caller never leaves string space. */
function addDays(day: string, days: number): string {
    const [year, month, date] = day.split('-').map(Number)
    return taskDateKey(new Date(year, month - 1, date), days)
}

function toHit(row: TaskRowResult): Omit<TaskHit, 'breadcrumb'> {
    return {
        pageId: row.page_id,
        blockLocalId: row.block_local_id,
        concept: row.concept,
        kind: row.kind,
        line: row.line,
        done: row.done !== 0,
        text: row.text,
        priority: row.priority,
        waiting: row.waiting !== 0,
        doing: row.doing !== 0,
        cancelled: row.cancelled !== 0,
        due: row.due,
        completion: row.completion,
        scheduled: row.scheduled,
    }
}
