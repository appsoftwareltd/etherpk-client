/**
 * The tab ↔ index-worker message protocol (ADR 0041).
 *
 * The worker CANNOT read documents: graph keys and Y.Docs live in the tab, and the
 * [[Derived Index]] is built from content the tab hands over. So every message carrying
 * document text flows tab → worker, and the worker only ever answers.
 *
 * Deliberately small. Two of the index's three reads (`conceptExists`, `allConcepts`) are
 * answered on the main thread from a snapshot the worker PUSHES after each ingest, never by
 * a round trip — the editor's missing-link styling reads one of them on every keystroke.
 */

import type {
    AssetUsage,
    ConceptCandidate,
    DbBacklinkGroup,
    IndexDoc,
    SearchDocumentGroup,
    TaskHit,
    TaskQuery,
} from '../index-db'
import type { EmbeddingRow, PendingPassage, SemanticDocumentGroup, SemanticStatus } from '../semantic/embedding-db'

export interface IndexDelta {
    revision: number
    existingAdded: string[]
    existingRemoved: string[]
    candidateUpserts: ConceptCandidate[]
    candidateRemoved: string[]
    backlinkTargetsChanged: string[]
}

export type IndexRequest =
    /** Attach to a graph's index, creating or reusing its persisted database. */
    | { type: 'open'; graphId: string; /** Correlates acceptance/opened across replayed opens. */ openId?: number }
    /**
     * Replace the whole index — sent when the document SET changes, or nothing is persisted.
     * Streamed as begin → docs… → commit rather than one message: a whole graph's text in a
     * single postMessage is one giant structured clone, and that clone froze the loading
     * spinner on a 2431-document graph (live, 2026-07-28). Nothing applies until commit.
     */
    | { type: 'rebuild-begin'; rebuildId: string; total: number }
    | { type: 'rebuild-docs'; rebuildId: string; docs: IndexDoc[] }
    | { type: 'rebuild-commit'; rebuildId: string }
    /** Re-index named documents. Unchanged ones are skipped by content hash. */
    | { type: 'ingest'; docs: IndexDoc[] }
    /** Recover after a missed delta or owner failover. */
    | { type: 'snapshot-request' }
    /** Confirm that every earlier request on this connection has committed. */
    | { type: 'barrier'; id: number }
    | { type: 'backlinks'; id: number; concept: string }
    /**
     * [[Search]]'s text group. Two requests rather than one because the count is capped and
     * can be slow on a prefix query — it runs in parallel and must never delay the rows.
     */
    | { type: 'search-text'; id: number; query: string; offset: number; limit: number }
    | { type: 'search-count'; id: number; query: string }
    /**
     * The [[Tasks View]]'s page. ONE request, unlike Search's split pair: the total here is a
     * COUNT over the same indexed join the rows come from, not a capped scan of a text index,
     * so there is nothing slow to keep out of the rows' way.
     */
    | { type: 'tasks'; id: number; query: TaskQuery; offset: number; limit: number }
    /**
     * Which documents reference an [[Asset]] — the gate in front of a permanent delete
     * (ADR 0054). `needles` are the forms the reference can be written in: the asset's
     * identity, plus its percent-encoded form when that differs.
     */
    | { type: 'asset-usage'; id: number; needles: string[] }
    /**
     * [[Semantic Search]] (ADR 0076). The worker holds the vectors and the scan and knows no
     * model: the caller embeds, both the passages it is handed and the query it asks with, so
     * the runtime that does that lives wherever the caller can afford it - the Headless
     * Client's process, or a worker of the browser's own beside this one - and never in this
     * worker's serial lane. `model` names whose numbers the rows are; two models never mix.
     */
    | { type: 'semantic-status'; id: number; model: string }
    /** Up to `limit` live passages with no vector yet: the build loop's next batch. */
    | { type: 'semantic-pending'; id: number; model: string; limit: number }
    | { type: 'semantic-put'; id: number; model: string; dims: number; rows: EmbeddingRow[] }
    | { type: 'semantic-search'; id: number; model: string; vector: Float32Array; offset: number; limit: number; floor: number }
    /** Drop vectors no passage references; the build loop asks once when its queue is empty. */
    | { type: 'semantic-sweep'; id: number; model: string }
    | { type: 'close' }

export type IndexResponse =
    /**
     * `persisted` is false when this index lives only in memory — no OPFS, or a browser
     * without SharedWorker — which the app tells the user about once (ADR 0041 §4).
     * `persistenceBlocked` says WHY when known: 'held' means another live context (typically a
     * stale window) holds the pool, which is actionable; 'unsupported' means this environment
     * cannot persist at all.
     */
    | {
          type: 'opened'
          persisted: boolean
          indexedDocuments: number
          /** Echoed from the open request; absent only for compatibility with older workers. */
          openId?: number
          persistenceBlocked?: 'held' | 'unsupported'
      }
    /**
     * Sent the instant a ferried port is adopted, before any queued core work. Proof for
     * the attaching tab that the owner's WORKER is alive, so ferry retries can stop.
     */
    | { type: 'attached' }
    /**
     * Sent when an `open` is admitted to the worker's serial queue, before work already in
     * that queue drains. Correlation matters because compatibility ferrying may replay the
     * same open, and a late acknowledgement for an older open must not disable a newer one's
     * startup failure detection.
     */
    | { type: 'open-accepted'; openId: number }
    /**
     * Emitted by the SHARED TRANSPORT on the attaching tab itself, never by a worker,
     * while port ferrying is still in progress. Purely a liveness pulse: the open's
     * activity-based timeout must not reject into the inline in-memory fallback while a
     * live owner's adoption bursts are still pending (ADR 0042).
     */
    | { type: 'attaching' }
    /**
     * Also transport-local: the shared transport swapped to a DIFFERENT worker (ferry win,
     * owner takeover, lonely fallback). The client honours an unsolicited empty `opened`,
     * the fresh-empty-worker recovery, only after one of these, so duplicate open answers
     * from compatibility nudges can never masquerade as a worker replacement (each such
     * answer used to schedule ANOTHER full derivation during bring-up).
     */
    | { type: 'transport-changed' }
    /** The synchronous-read caches. Pushed after every ingest; never requested. */
    | {
          type: 'snapshot'
          revision: number
          existing: string[]
          candidates: ConceptCandidate[]
          /** Present when this snapshot atomically committed a staged rebuild. */
          rebuildId?: string
      }
    | ({ type: 'delta' } & IndexDelta)
    | { type: 'progress'; phase: 'indexing'; done: number; total: number }
    | { type: 'barrier'; id: number }
    | { type: 'backlinks'; id: number; groups: DbBacklinkGroup[] }
    | { type: 'search-text'; id: number; groups: SearchDocumentGroup[]; hasMore: boolean }
    | { type: 'search-count'; id: number; total: number; capped: boolean }
    | { type: 'tasks'; id: number; hits: TaskHit[]; hasMore: boolean; total: number }
    | { type: 'asset-usage'; id: number; usage: AssetUsage }
    | { type: 'semantic-status'; id: number; status: SemanticStatus }
    | { type: 'semantic-pending'; id: number; passages: PendingPassage[] }
    | { type: 'semantic-put'; id: number; stored: number }
    | { type: 'semantic-search'; id: number; groups: SemanticDocumentGroup[]; hasMore: boolean; status: SemanticStatus }
    | { type: 'semantic-sweep'; id: number; removed: number }
    | {
          type: 'error'
          message: string
          id?: number
          openId?: number
          /** Set when a rebuild request failed, so a client can ignore errors for a stream it no longer owns. */
          rebuildId?: string
      }
