/**
 * The eight tools an agent gets, as plain functions over an open {@link HeadlessGraph}. The MCP
 * layer (`mcp-server.ts`) only serialises these; everything an agent can and cannot do is
 * decided here, and tested here over both backends - the loopback relay standing in for the
 * Sync Server, and an in-memory folder - without a server or a transport. The tools see only
 * `HeadlessDocuments`: every one starts with `refresh()` so a folder is re-read before it is
 * answered from, and a write ends with `settle()` so success means durable.
 *
 * The rules (ADR 0072, [[2026-09-15 Headless Client And MCP]]):
 *
 * - A [[Protected Document]] is listed by name and nothing else. Reading refuses; every write
 *   refuses, frontmatter included. The Headless Client never holds a Protection Key, so this is
 *   a courtesy to the agent rather than the guarantee - the guarantee is that there is nothing
 *   here to serve.
 * - Edits are anchored: `edit_document` replaces one exact, unique occurrence and lands as one
 *   `applyChange` range, which the sync engine carries as one `Y.Text` change that merges with
 *   whoever is typing elsewhere in the page. There is no whole-page replace.
 * - Every write passes through the paste / import indent normaliser, so an agent that writes
 *   four-space bullets lands on the grid like everyone else.
 * - Every result is bounded: pages are paged, a document read is capped and says so.
 * - `search` has a `mode`: `text` (the index's FTS, the default), `semantic` (nearest
 *   [[Passage]]s by [[Embedding]], ADR 0076) and `hybrid` (both, as two labelled groups rather
 *   than one fused ranking - the same choice the Search modal makes, so the agent can see WHY
 *   something matched). Semantic mode needs the model set up on this machine; without it the
 *   refusal says what to run.
 */

import { todayISO } from '$lib/document/calendar/month-grid-core'
import { normaliseIndentUnit } from '$lib/document/indent-unit'
import { lineFeedsOnly } from '$lib/document/line-endings'
import { isJournalConcept } from '$lib/document/journal-concept'
import { documentProtection } from '$lib/document/protection/cipher-fence'
import { DocumentUnconfirmedError } from '$lib/document/types'
import { withAliasesInAddedBlock } from '$lib/document/frontmatter/identity'
import { withFrontmatterPatch } from '$lib/document/frontmatter/patch'
import { withPublishing } from '$lib/document/frontmatter/publishing'
import { isPublicationId } from '$lib/document/publish/publication'
import { parseSearchQuery } from '$lib/document/search-query'
import { parseFrontmatter } from '$lib/storage/fs/frontmatter'
import { frontmatterSpan } from '$lib/storage/fs/frontmatter-span'
import { conceptKey } from '$lib/storage/fs/identity'
import { OPEN_TASK_STATUSES, TASK_PRIORITY_FILTERS, TASK_STATUSES, type TaskDueWindow, type TaskPriorityFilter, type TaskStatus, referencedInBody } from '$lib/document/index-db'
import { type RenameLinkStrategy, RenameUnconfirmedError, mergeCount, renameSteps } from '$lib/storage/rename'
import { buildAssetMarkdown, displayAssetName, mimeTypeForExt, splitNameExt } from '$lib/storage/fs/asset-store'
import { AssetRefusedError, assetIdFromRef } from '$lib/storage/server/server-asset-store'

import { readLocalFile, writeDownload } from './headless-assets'
import { FolderRefused, folderUnder } from './local-folders'
import { parseTaskLine, type TaskPriority } from '$lib/document/task-tags'
import {
    everyIndexedTask,
    parseTaskReference,
    type ResolvedTaskReference,
    resolveTaskReference,
    type TaskReferenceSources,
    taskFingerprint,
    taskReferenceUrl,
} from '$lib/document/task-reference'
import { ancestorChain, bulletLabel, deriveDoc } from '$lib/document/index-derive'
import { type ConceptFacts, createGraphModel, type GraphFilter, shortestPath, visibleGraph } from '@appsoftwareltd/etherpk-extension-graph-view/model'
import { bridges, findClusters, hubs, isolatedDocuments, pagelessByDocuments, type RankedConcept } from '@appsoftwareltd/etherpk-extension-graph-view/model'
import { taskLineWith } from '$lib/document/task-write'
import { minimalReplacement } from '$lib/document/view/minimal-replacement'

import type { HeadlessDocument } from './headless-documents'
import type { HeadlessGraph } from './headless-graph'

/** Sizes an agent's context can absorb; the caller can page or narrow, never exceed them. */
export const LIST_PAGE_LIMIT = 200
export const SEARCH_PAGE_LIMIT = 50
export const TASK_PAGE_LIMIT = 200
/** UTF-16 units of document text returned before `truncated` is set. */
export const READ_TEXT_CAP = 200_000

export type ToolErrorCode =
    /** The graph could not be opened (not logged in, the keys no longer open the vault, no such graph); the message says why. */
    | 'graph_unavailable'
    | 'semantic_unavailable'
    | 'not_found'
    | 'protected_document'
    | 'already_exists'
    | 'ambiguous_match'
    | 'no_match'
    | 'invalid_argument'
    | 'not_settled'
    /** A `set_frontmatter` patch named `title`, `aliases` or `publication`, which other tools own. */
    | 'identity_key'
    /** The rename's plan holds a [[Merge]] and the call did not say `confirm_merge: true`. */
    | 'merge_requires_confirmation'
    /** A document the rename would read could not be brought current in time; nothing was renamed. */
    | 'unconfirmed_documents'
    /** An alias is already another document's name or alias. */
    | 'name_taken'
    /** This process has no asset storage for the graph. */
    | 'assets_unavailable'
    /** The server declined the upload on policy (a quota); the message carries its code. */
    | 'asset_refused'
    /** No document the agent can read references the asset, or the graph does not hold it. */
    | 'asset_not_found'
    /** The line `set_task` was given is no longer that task: the document moved on. */
    | 'task_moved'
    /** No task in the graph has the words a Task Reference names: edited or deleted since. */
    | 'task_not_found'
    /** More than one task has the words a Task Reference names, so none is chosen. */
    | 'task_ambiguous'
    /** A Task Reference to another synced graph than the one served. */
    | 'other_graph'
    /** More documents were asked for in one call than the cap allows. */
    | 'too_many'
    /** No publication has that id. */
    | 'publication_not_found'
    /** No Publish Folder is set for the publication on this machine (ADR 0086). */
    | 'no_publish_folder'
    /** The publish needs a browser for Mermaid and none is set up (ADR 0084). */
    | 'chromium_unavailable'
    /** No theme answers to that reference: not in the graph, not bundled, not a url. */
    | 'theme_not_found'
    /** A bundled theme: never edited in place, copy it into the graph first. */
    | 'theme_not_editable'
    /** A publication's saved settings name the theme, so it cannot be deleted. */
    | 'theme_in_use'
    /** The Sync Server ended this account's access to the graph: it left, was removed, or the graph was deleted. */
    | 'access_removed'
    /** The Sync Server no longer accepts this computer's access token: revoked, expired, or the account was signed out. */
    | 'token_revoked'
    /**
     * The Sync Server refused the write on a quota (a lapsed or unconfirmed plan, a used-up storage
     * allowance). The edit is held and sent again automatically; the agent need not retry it.
     */
    | 'write_refused'

/** A refusal the agent can act on: a stable code first, a sentence second. */
export class ToolError extends Error {
    constructor(
        readonly code: ToolErrorCode,
        message: string,
    ) {
        super(message)
        this.name = 'ToolError'
    }
}

export interface DocumentSummary {
    concept: string
    kind: 'page' | 'journal'
    aliases: string[]
    /** Present only when true, so an ordinary document's shape is unchanged. */
    protected?: true
}

export interface ListDocumentsArgs {
    kind?: 'page' | 'journal'
    /** Journal entries on or after this day (`YYYY-MM-DD`). Implies `kind: journal`. */
    from?: string
    /** Journal entries on or before this day (`YYYY-MM-DD`). Implies `kind: journal`. */
    to?: string
    offset?: number
    limit?: number
}

/** Documents one `read_documents` call may ask for. */
export const READ_MANY_LIMIT = 20
/** UTF-16 units across one `read_documents` call before the rest is cut. */
export const READ_MANY_TEXT_CAP = 400_000

export interface SetTaskArgs {
    /** The task by document and line, or by `reference`. */
    concept?: string
    /** The task's 0-based line in the document's text, as `tasks` and `read_document` count lines. */
    line?: number
    /** A [[Task Reference]] as a person copied it, in place of `concept`, `line` and `expect`. */
    reference?: string
    changes: {
        status?: TaskStatus
        priority?: TaskPriority | null
        /** `YYYY-MM-DD`, or null to clear. */
        due?: string | null
        scheduled?: string | null
    }
    /** The task's text as `tasks` returned it; the edit is refused if the line no longer says this. */
    expect?: string
}

export interface ReadDocumentResult {
    concept: string
    kind: 'page' | 'journal'
    aliases: string[]
    /** The body: the document's text after its frontmatter block, on either backend. */
    text: string
    /**
     * The frontmatter block as data, minus what other tools own: `title` and `aliases` are the
     * document's identity (`rename`, `set_aliases`) and `publication` is a publication page's
     * definition (the publication tools). `{}` when there is no block.
     */
    frontmatter: Record<string, unknown>
    /** True when `text` was cut at {@link READ_TEXT_CAP}. */
    truncated: boolean
}

export type SearchMode = 'text' | 'semantic' | 'hybrid'

export interface SearchArgs {
    query: string
    /** Default `text`. */
    mode?: SearchMode
    offset?: number
    limit?: number
}

/** The text group as the agent sees it: unchanged from before `mode` existed. */
export interface TextSearchOutput {
    results: Array<{
        concept: string
        kind: 'page' | 'journal'
        matches: number
        hits: Array<{ line: number; breadcrumb: string[]; snippet: string }>
        /**
         * Only when the query was Property Filters and no words (ADR 0107): each document the
         * filters let through, with the values of the keys they named. It has no hits.
         */
        properties?: Array<{ key: string; value: string }>
    }>
    total: number
    totalCapped: boolean
    hasMore: boolean
}

/** The By-meaning group as the agent sees it. */
export interface SemanticSearchOutput {
    results: Array<{
        concept: string
        kind: 'page' | 'journal'
        /** The document's best passage's cosine similarity to the query, 0..1. */
        similarity: number
        passages: Array<{ line: number; endLine: number; breadcrumb: string[]; text: string; similarity: number }>
    }>
    hasMore: boolean
    /** Passages with a vector so far, of the live total: `complete` is `embedded >= total`. */
    embedded: number
    total: number
    complete: boolean
}

export interface TasksArgs {
    /** Tasks about this concept (its own line, an ancestor block, or the document), or every task. */
    concept?: string
    /** Default: every unfinished state. */
    statuses?: TaskStatus[]
    priorities?: Array<1 | 2 | 3 | 'none'>
    due?: TaskDueWindow
    offset?: number
    limit?: number
}

export interface EditDocumentArgs {
    concept: string
    /** Exact text to replace; must occur exactly once. */
    old: string
    new: string
}

export interface AppendDocumentArgs {
    /** A page's name, a journal day `YYYY-MM-DD`, or `today`. */
    concept: string
    text: string
}

export interface CreatePageArgs {
    title: string
    text?: string
    /** Frontmatter keys to set on the new page, under the same rules as `set_frontmatter`. */
    frontmatter?: Record<string, unknown>
}

export interface PlanRenameArgs {
    from: string
    to: string
}

export interface RenameArgs {
    from: string
    to: string
    /** Default `rewrite`: every `[[from]]` in the graph comes to say `to`. `alias` keeps the old name resolving instead. */
    strategy?: RenameLinkStrategy
    /** A rename that would join two documents (the new name is taken) is refused unless this is true. */
    confirm_merge?: boolean
}

export interface SetAliasesArgs {
    concept: string
    /** The complete list; replaces what the document had. */
    aliases: string[]
}

export interface UploadAssetArgs {
    /**
     * Path of an ordinary file on this machine, at most 100 MiB. Refused: a hidden file or one in a
     * hidden folder (`.ssh`, `.env`), and the Headless Client's own config and cache.
     */
    path: string
    /** The name to store it under; the file's own name by default. */
    name?: string
}

export interface ReadAssetArgs {
    /** The reference as it appears in a document (`../assets/<name>`), or the name alone. */
    ref: string
    /** A folder under the graph's downloads directory to write the file to; the downloads directory itself by default. */
    out_dir?: string
}

export interface ListAssetsArgs {
    /** Only the assets this document references. */
    concept?: string
}

export interface SetFrontmatterArgs {
    concept: string
    /** Keys to set; `null` removes a key. Keys not named are left as they are. */
    patch: Record<string, unknown>
}

/** Keys the frontmatter tools never read or write; each has a tool of its own. */
const OWNED_KEYS = new Set(['title', 'aliases', 'publication'])

/** The block's keys an agent sees: everything but the owned ones. */
function agentFrontmatter(rawText: string): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(parseFrontmatter(rawText).data)) {
        if (!OWNED_KEYS.has(key)) out[key] = value
    }
    return out
}

/**
 * The block after a patch. `public` and `publications` go through the publishing writer, so its
 * rules hold whoever writes them: an id is lower-case letters, digits and hyphens, and a public
 * document with an empty list keeps the key, written bare, as the prompt it is. Everything else is a
 * plain key. An invalid publication id is refused rather than dropped, which is what the
 * writer would do: an agent that misspells an id must hear about it.
 */
function patchedText(rawText: string, patch: Record<string, unknown>): string {
    const rest: Record<string, unknown> = {}
    let publishing: { public?: boolean | null; publications?: string[] | null } | undefined
    for (const [key, value] of Object.entries(patch)) {
        if (OWNED_KEYS.has(key)) {
            const owner = key === 'publication' ? 'the publication tools' : key === 'title' ? 'rename' : 'set_aliases'
            throw new ToolError('identity_key', `\`${key}\` is not set here: use ${owner}.`)
        }
        if (key === 'public') {
            if (value !== null && typeof value !== 'boolean') throw new ToolError('invalid_argument', '`public` must be true, false or null.')
            publishing = { ...publishing, public: value }
            continue
        }
        if (key === 'publications') {
            if (value !== null && !(Array.isArray(value) && value.every((v) => typeof v === 'string'))) {
                throw new ToolError('invalid_argument', '`publications` must be a list of publication ids, like ["docs", "blog"], or null.')
            }
            if (Array.isArray(value)) {
                const bad = value.find((v) => !isPublicationId(v))
                if (bad !== undefined) throw new ToolError('invalid_argument', `"${String(bad)}" is not a publication id: lower-case letters, digits and hyphens, like \`docs\`.`)
            }
            publishing = { ...publishing, publications: value as string[] | null }
            continue
        }
        rest[key] = value
    }
    let next = rawText
    if (publishing) next = withPublishing(next, publishing, { addBlock: true })
    if (Object.keys(rest).length > 0) next = withFrontmatterPatch(next, rest, { addBlock: true })
    return next
}

/**
 * Rewrite a document's block to what `next` holds, as one change over the block alone: the body
 * is untouched, an open editor sees the change, and on a synced graph it is one CRDT edit.
 */
function applyBlock(graph: HeadlessGraph, concept: string, rawText: string, next: string): void {
    if (next === rawText) return
    const before = frontmatterSpan(rawText)?.end ?? 0
    const after = frontmatterSpan(next)?.end ?? 0
    graph.store.openRaw(concept).applyChange({ from: 0, to: before, insert: next.slice(0, after) }, 'external')
}

/** How `concept`, `today` and aliases resolve to one document, case-insensitively. */
function resolveIdentity(graph: HeadlessGraph, target: string): HeadlessDocument | null {
    const wanted = conceptKey(target === 'today' ? todayISO() : target.trim())
    for (const identity of graph.store.listDocuments()) {
        if (identity.key === wanted) return identity
        if (identity.aliases.some((alias) => conceptKey(alias) === wanted)) return identity
    }
    return null
}

function requireIdentity(graph: HeadlessGraph, target: string): HeadlessDocument {
    const identity = resolveIdentity(graph, target)
    if (!identity) throw new ToolError('not_found', `No document is named "${target}".`)
    return identity
}

/**
 * The document's current text from a live handle, once the backend says it can be trusted:
 * caught up with the relay, or read from disk (`HeadlessDocuments.whenReady`). A fresh process
 * seeds every document empty until then, and a tool must never believe that emptiness.
 */
async function liveText(graph: HeadlessGraph, identity: HeadlessDocument): Promise<string> {
    await graph.store.whenReady(identity.concept)
    return graph.store.open(identity.concept).getText()
}

function refuseIfProtected(concept: string, text: string): void {
    if (documentProtection(text).kind === 'document') {
        throw new ToolError(
            'protected_document',
            `"${concept}" is a protected document. Its content is encrypted under a key this client never holds, so it cannot be read or changed here - the user can unlock it in EtherPK.`,
        )
    }
}

function page<T>(items: readonly T[], offset: number, limit: number): { items: T[]; hasMore: boolean } {
    return { items: items.slice(offset, offset + limit), hasMore: items.length > offset + limit }
}

function bounded(value: number | undefined, fallback: number, max: number): number {
    if (value === undefined) return fallback
    if (!Number.isInteger(value) || value < 0) throw new ToolError('invalid_argument', 'offset and limit must be non-negative integers.')
    return Math.min(value, max)
}

/**
 * After a write: make it durable - acknowledged by the relay, or on disk - so the agent's next
 * read anywhere sees it, and refuse in the backend's own words when that did not happen.
 */
async function settle(graph: HeadlessGraph): Promise<void> {
    const result = await graph.settle()
    if (!result.settled) throw new ToolError(result.code ?? 'not_settled', result.message)
}

export async function listDocuments(graph: HeadlessGraph, args: ListDocumentsArgs = {}) {
    await graph.store.refresh()
    const offset = bounded(args.offset, 0, Number.MAX_SAFE_INTEGER)
    const limit = bounded(args.limit, LIST_PAGE_LIMIT, LIST_PAGE_LIMIT)
    for (const day of [args.from, args.to]) {
        if (day !== undefined && !isJournalConcept(day)) throw new ToolError('invalid_argument', `"${day}" is not a day: from and to are YYYY-MM-DD.`)
    }
    const kind = args.from !== undefined || args.to !== undefined ? 'journal' : args.kind
    const protectedKeys = new Set(
        graph.index
            .allConcepts()
            .filter((candidate) => candidate.protected && (candidate.kind === 'page' || candidate.kind === 'journal'))
            .map((candidate) => candidate.key),
    )
    const all: DocumentSummary[] = graph.store
        .listDocuments()
        .filter((doc) => !kind || doc.kind === kind)
        // A journal entry's concept is its day, and days as YYYY-MM-DD order as strings.
        .filter((doc) => doc.kind !== 'journal' || ((args.from === undefined || doc.concept >= args.from) && (args.to === undefined || doc.concept <= args.to)))
        .map((doc) => ({
            concept: doc.concept,
            kind: doc.kind,
            aliases: doc.aliases,
            ...(protectedKeys.has(doc.key) ? { protected: true as const } : {}),
        }))
    const paged = page(all, offset, limit)
    return { documents: paged.items, total: all.length, hasMore: paged.hasMore }
}

export async function readDocument(graph: HeadlessGraph, concept: string): Promise<ReadDocumentResult> {
    await graph.store.refresh()
    const identity = requireIdentity(graph, concept)
    const text = await liveText(graph, identity)
    refuseIfProtected(identity.concept, text)
    return {
        concept: identity.concept,
        kind: identity.kind,
        aliases: identity.aliases,
        text: text.length > READ_TEXT_CAP ? text.slice(0, READ_TEXT_CAP) : text,
        frontmatter: agentFrontmatter(graph.store.openRaw(identity.concept).getText()),
        truncated: text.length > READ_TEXT_CAP,
    }
}

export type SearchOutput =
    | ({ mode: 'text' } & TextSearchOutput)
    | ({ mode: 'semantic' } & SemanticSearchOutput)
    | { mode: 'hybrid'; text: TextSearchOutput; semantic: SemanticSearchOutput }

export function search(graph: HeadlessGraph, args: SearchArgs & { mode?: 'text' }): Promise<{ mode: 'text' } & TextSearchOutput>
export function search(graph: HeadlessGraph, args: SearchArgs & { mode: 'semantic' }): Promise<{ mode: 'semantic' } & SemanticSearchOutput>
export function search(graph: HeadlessGraph, args: SearchArgs & { mode: 'hybrid' }): Promise<{ mode: 'hybrid'; text: TextSearchOutput; semantic: SemanticSearchOutput }>
export function search(graph: HeadlessGraph, args: SearchArgs): Promise<SearchOutput>
export async function search(graph: HeadlessGraph, args: SearchArgs): Promise<SearchOutput> {
    const query = args.query.trim()
    if (query === '') throw new ToolError('invalid_argument', 'query must not be empty.')
    await graph.store.refresh()
    const offset = bounded(args.offset, 0, Number.MAX_SAFE_INTEGER)
    const limit = bounded(args.limit, 20, SEARCH_PAGE_LIMIT)
    const mode: SearchMode = args.mode ?? 'text'
    if (mode !== 'text' && mode !== 'semantic' && mode !== 'hybrid') throw new ToolError('invalid_argument', 'mode must be text, semantic or hybrid.')
    if (mode === 'text') return { mode, ...(await searchText(graph, query, offset, limit)) }
    if (mode === 'semantic') return { mode, ...(await searchSemantic(graph, query, offset, limit)) }
    const [text, semantic] = await Promise.all([searchText(graph, query, offset, limit), searchSemantic(graph, query, offset, limit)])
    return { mode, text, semantic }
}

async function searchSemantic(graph: HeadlessGraph, query: string, offset: number, limit: number): Promise<SemanticSearchOutput> {
    let semantic
    try {
        semantic = await graph.semantic()
    } catch (error) {
        throw new ToolError('semantic_unavailable', error instanceof Error ? error.message : String(error))
    }
    const result = await semantic.search(query, offset, limit)
    return {
        results: result.groups.map((group) => ({
            concept: group.concept,
            kind: group.kind,
            similarity: round(group.similarity),
            passages: group.hits.map((hit) => ({
                line: hit.line,
                endLine: hit.endLine,
                breadcrumb: hit.breadcrumb,
                text: hit.text,
                similarity: round(hit.similarity),
            })),
        })),
        hasMore: result.hasMore,
        embedded: result.status.embedded,
        total: result.status.total,
        complete: result.status.embedded >= result.status.total,
    }
}

function round(similarity: number): number {
    return Math.round(similarity * 1000) / 1000
}

async function searchText(graph: HeadlessGraph, query: string, offset: number, limit: number): Promise<TextSearchOutput> {
    // Property Filters are read the way Search reads them: a `key:value` term whose key some
    // unprotected document carries narrows the results, and anything else is words (ADR 0107).
    const keys = await graph.index.propertyKeys()
    const { words, filters } = parseSearchQuery(query, new Set(keys.map((info) => info.key.toLowerCase())))
    if (filters.length > 0 && words.trim() === '') {
        const documents = await graph.index.propertyMatch(filters)
        return {
            results: documents.slice(offset, offset + limit).map((doc) => ({
                concept: doc.concept,
                kind: doc.kind,
                matches: 0,
                hits: [],
                properties: doc.properties,
            })),
            total: documents.length,
            totalCapped: false,
            hasMore: offset + limit < documents.length,
        }
    }
    const [result, count] = await Promise.all([
        graph.index.searchText(words, offset, limit, filters),
        graph.index.searchTextCount(words, filters),
    ])
    return {
        results: result.groups.map((group) => ({
            concept: group.concept,
            kind: group.kind,
            matches: group.matches,
            hits: group.hits.map((hit) => ({
                line: hit.line,
                breadcrumb: hit.breadcrumb,
                snippet: hit.snippet.map((segment) => segment.text).join(''),
            })),
        })),
        total: count.total,
        totalCapped: count.capped,
        hasMore: result.hasMore,
    }
}

export async function backlinks(graph: HeadlessGraph, concept: string) {
    const target = concept.trim() === 'today' ? todayISO() : concept.trim()
    if (target === '') throw new ToolError('invalid_argument', 'concept must not be empty.')
    await graph.store.refresh()
    const groups = await graph.index.backlinks(target)
    return {
        concept: target,
        sources: groups.map((group) => ({
            concept: group.sourceConcept,
            kind: group.sourceKind,
            // `kind` says what `text` quotes: a block and its subtree, the prose around the link,
            // or - for a document scoped by the concept (ADR 0083) - the source's own title.
            references: group.refs.map((ref) => ({
                kind: ref.kind,
                line: ref.line,
                breadcrumb: ref.breadcrumb,
                text:
                    ref.kind === 'block'
                        ? ref.subtree.map((node) => node.text).join('\n')
                        : (ref.context?.text ?? ''),
            })),
        })),
    }
}

/** The most rows any one list of graph_insights returns. */
export const INSIGHTS_LIST_LIMIT = 50

export interface GraphInsightsArgs {
    /** Rows per list; 15 when absent. */
    limit?: number
    /** Count journal entries in the picture (default true). Hubs and Pageless Concepts always count every document. */
    journals?: boolean
    /** Which Pageless Concepts the picture holds (default: those two or more documents mention). */
    pageless?: GraphFilter['pageless']
}

/**
 * What the whole-graph [[Graph View]] lists beside its picture, for an agent: the same model
 * and the same rules (graph-view/model), over the same index query, so an agent and a person
 * looking at the Graph View see the same Hubs, Clusters and Bridges.
 */
export async function graphInsights(graph: HeadlessGraph, args: GraphInsightsArgs = {}) {
    const limit = Math.max(1, bounded(args.limit, 15, INSIGHTS_LIST_LIMIT))
    await graph.store.refresh()
    const model = createGraphModel(await graph.index.linkGraph())
    const shown = visibleGraph(model, { journals: args.journals ?? true, pageless: args.pageless ?? 'mentioned-twice' })
    const clustered = findClusters(shown)
    const isolated = isolatedDocuments(model)
    const byDocuments = (rows: RankedConcept[]) => rows.map((row) => ({ concept: row.name, documents: row.count }))
    // A Cluster's best-known members, so an agent can say what it is about.
    const membersOf = new Map<number, ConceptFacts[]>()
    for (const [key, id] of clustered.clusterOf) {
        const facts = model.concepts.get(key)
        if (facts) membersOf.set(id, [...(membersOf.get(id) ?? []), facts])
    }
    return {
        shown: { concepts: shown.order, lines: shown.size },
        hubs: byDocuments(hubs(model, limit)),
        pageless: byDocuments(pagelessByDocuments(model, limit)),
        isolated: { total: isolated.length, concepts: isolated.slice(0, limit).map((row) => row.name), truncated: isolated.length > limit },
        clusters: clustered.clusters.slice(0, limit).map((cluster) => ({
            name: cluster.name,
            size: cluster.size,
            members: (membersOf.get(cluster.id) ?? [])
                .sort((a, b) => b.linkedFrom - a.linkedFrom || a.name.localeCompare(b.name))
                .slice(0, 5)
                .map((member) => member.name),
        })),
        bridges: bridges(shown, clustered, limit).map((bridge) => ({ concept: bridge.name, joins: bridge.between })),
    }
}

export interface GraphPathArgs {
    from: string
    to: string
    /** Let the route pass through journal entries (default true). */
    journals?: boolean
}

/** The fewest wikilink steps from one concept to another, through every concept, or null when nothing joins them. */
export async function graphPath(graph: HeadlessGraph, args: GraphPathArgs) {
    await graph.store.refresh()
    const model = createGraphModel(await graph.index.linkGraph())
    const resolve = (asked: string): string => {
        const name = asked.trim() === 'today' ? todayISO() : asked.trim()
        if (name === '') throw new ToolError('invalid_argument', 'from and to must not be empty.')
        const key = conceptKey(name)
        if (model.concepts.has(key)) return key
        // An alias names its page.
        const alias = graph.index.allConcepts().find((candidate) => candidate.key === key && candidate.kind === 'alias')
        const page = alias?.canonical === undefined ? undefined : conceptKey(alias.canonical)
        if (page !== undefined && model.concepts.has(page)) return page
        throw new ToolError('not_found', `No concept is named "${asked}". Names are case-insensitive; list_documents and search find one.`)
    }
    const from = resolve(args.from)
    const to = resolve(args.to)
    const journals = args.journals ?? true
    if (!journals) {
        // Left out, a journal end would read as "nothing joins them", which is not the answer.
        for (const end of [from, to]) {
            const concept = model.concepts.get(end)
            if (concept?.kind === 'journal') throw new ToolError('invalid_argument', `${concept.name} is a journal entry, and journals: false leaves journal entries out. Ask again with journals left on.`)
        }
    }
    const path = shortestPath(visibleGraph(model, { journals, pageless: 'all' }), from, to)
    const nameOf = (key: string) => model.concepts.get(key)?.name ?? key
    return { from: nameOf(from), to: nameOf(to), path: path?.map(nameOf) ?? null, steps: path ? path.length - 1 : null }
}

export async function tasks(graph: HeadlessGraph, args: TasksArgs = {}) {
    const offset = bounded(args.offset, 0, Number.MAX_SAFE_INTEGER)
    const limit = bounded(args.limit, 100, TASK_PAGE_LIMIT)
    const statuses = args.statuses ?? OPEN_TASK_STATUSES
    for (const status of statuses) {
        if (!TASK_STATUSES.includes(status)) throw new ToolError('invalid_argument', `Unknown task status "${status}".`)
    }
    const priorities: TaskPriorityFilter[] = args.priorities
        ? args.priorities.map((priority) => (priority === 'none' ? null : priority))
        : [...TASK_PRIORITY_FILTERS]
    await graph.store.refresh()
    const result = await graph.index.tasks(
        {
            concept: args.concept?.trim() ? (args.concept.trim() === 'today' ? todayISO() : args.concept.trim()) : null,
            statuses,
            priorities,
            due: args.due ?? 'any',
            groupBy: 'document',
            today: todayISO(),
        },
        offset,
        limit,
    )
    return {
        tasks: await Promise.all(
            result.hits.map(async (hit) => ({
                concept: hit.concept,
                kind: hit.kind,
                line: hit.line,
                text: hit.text,
                done: hit.done,
                priority: hit.priority,
                waiting: hit.waiting,
                doing: hit.doing,
                cancelled: hit.cancelled,
                due: hit.due,
                scheduled: hit.scheduled,
                completion: hit.completion,
                breadcrumb: hit.breadcrumb,
                // So an agent can hand the task back to a person, who can open it.
                reference: await referenceFor(graph, hit.concept, hit.line, hit.text),
            })),
        ),
        total: result.total,
        hasMore: result.hasMore,
    }
}

/**
 * Text an agent sent, in the form EtherPK writes: line feeds only (ADR 0112), then the
 * two-space Indent Unit (ADR 0067). Line endings go first so the normaliser reads whole lines.
 */
function asWritten(text: string): string {
    return normaliseIndentUnit(lineFeedsOnly(text))
}

export async function editDocument(graph: HeadlessGraph, args: EditDocumentArgs) {
    if (args.old === '') throw new ToolError('invalid_argument', 'old must not be empty.')
    await graph.store.refresh()
    const identity = requireIdentity(graph, args.concept)
    const text = await liveText(graph, identity)
    refuseIfProtected(identity.concept, text)
    const first = text.indexOf(args.old)
    if (first === -1) {
        throw new ToolError('no_match', `"${identity.concept}" does not contain the text to replace. Read the document again - it may have changed.`)
    }
    if (text.indexOf(args.old, first + 1) !== -1) {
        throw new ToolError('ambiguous_match', `The text to replace occurs more than once in "${identity.concept}". Include more surrounding text so it matches exactly once.`)
    }
    // Only the replacement is normalised: the surrounding document is someone else's to keep,
    // and a normaliser pass over the whole text would be a whole-page write in disguise.
    const insert = asWritten(args.new)
    graph.store.open(identity.concept).applyChange({ from: first, to: first + args.old.length, insert }, 'external')
    await settle(graph)
    return { concept: identity.concept, replaced: args.old.length, inserted: insert.length }
}

export async function appendDocument(graph: HeadlessGraph, args: AppendDocumentArgs) {
    const text = asWritten(args.text)
    if (text.trim() === '') throw new ToolError('invalid_argument', 'text must not be empty.')
    const target = args.concept.trim() === 'today' ? todayISO() : args.concept.trim()
    await graph.store.refresh()
    const existing = resolveIdentity(graph, target)
    if (!existing) {
        if (!isJournalConcept(target)) {
            throw new ToolError('not_found', `No document is named "${target}". Use create_page to start a new page.`)
        }
        // A journal entry is created by its first content, exactly as the first keystroke does.
        await graph.store.createJournal(target, text.endsWith('\n') ? text : `${text}\n`)
        await settle(graph)
        return { concept: target, created: true }
    }
    const current = await liveText(graph, existing)
    refuseIfProtected(existing.concept, current)
    const separator = current === '' || current.endsWith('\n') ? '' : '\n'
    const insert = `${separator}${text}${text.endsWith('\n') ? '' : '\n'}`
    graph.store.open(existing.concept).applyChange({ from: current.length, to: current.length, insert }, 'external')
    await settle(graph)
    return { concept: existing.concept, created: false }
}

export async function createPage(graph: HeadlessGraph, args: CreatePageArgs) {
    const title = args.title.trim()
    if (title === '') throw new ToolError('invalid_argument', 'title must not be empty.')
    if (isJournalConcept(title)) {
        throw new ToolError('invalid_argument', `"${title}" is a calendar day, so it names a journal entry - use append_document to write to it.`)
    }
    await graph.store.refresh()
    if (resolveIdentity(graph, title)) {
        throw new ToolError('already_exists', `A document already answers to "${title}". Use edit_document or append_document instead.`)
    }
    // No frontmatter block: on a Server Backend identity is the encrypted registry (ADR 0024),
    // and the app seeds a new page with its body alone - a block the text carries is a mirror the
    // store writes back when the registry changes, and adds once the page has aliases (ADR 0061),
    // never the source of the name.
    await graph.store.createPage(title, asWritten(args.text ?? ''))
    if (args.frontmatter && Object.keys(args.frontmatter).length > 0) {
        await graph.store.whenReady(title)
        const raw = graph.store.openRaw(title).getText()
        applyBlock(graph, title, raw, patchedText(raw, args.frontmatter))
    }
    await settle(graph)
    return { concept: title, created: true }
}

/**
 * Set keys of a document's frontmatter block, adding the block when there is none. A merge
 * patch: named keys are set, `null` removes, the rest of the block keeps its values and order.
 */
export async function setFrontmatter(graph: HeadlessGraph, args: SetFrontmatterArgs) {
    if (!args.patch || typeof args.patch !== 'object' || Array.isArray(args.patch)) {
        throw new ToolError('invalid_argument', 'patch must be an object of frontmatter keys.')
    }
    await graph.store.refresh()
    const identity = requireIdentity(graph, args.concept)
    const body = await liveText(graph, identity)
    refuseIfProtected(identity.concept, body)
    const raw = graph.store.openRaw(identity.concept).getText()
    // A block added here carries the page's aliases: on a synced graph they live in the registry,
    // and a block without an `aliases:` line would claim none (ADR 0061).
    const next = withAliasesInAddedBlock(raw, patchedText(raw, args.patch), identity.aliases)
    applyBlock(graph, identity.concept, raw, next)
    await settle(graph)
    return { concept: identity.concept, frontmatter: agentFrontmatter(next) }
}

/**
 * Whether the graph has anything under this name: a document, or a concept only links name (a
 * [[Pageless Concept]], which the index lists as a candidate without a document behind it).
 */
function conceptExists(graph: HeadlessGraph, concept: string): boolean {
    if (resolveIdentity(graph, concept)) return true
    return graph.index.candidate(concept) !== undefined
}

/**
 * The documents whose BODIES link to the concept by that very name - what a rewrite has to read
 * (ADR 0083: a title reference is the cascade's). The page's other names share its backlinks, and
 * the rewrite leaves links that say them alone.
 */
async function referencingDocuments(graph: HeadlessGraph, concept: string): Promise<string[]> {
    const groups = await graph.index.backlinks(concept)
    return groups.filter((group) => referencedInBody(group, concept)).map((group) => group.sourceConcept)
}

/** Protected documents in the graph: their references can be neither seen nor rewritten. */
function protectedDocumentCount(graph: HeadlessGraph): number {
    return graph.index.allConcepts().filter((c) => c.protected && (c.kind === 'page' || c.kind === 'journal')).length
}

function renameStepView(step: { from: string; to: string; into: string; hasDocument: boolean; merges: boolean; redirects: boolean }) {
    return { from: step.from, to: step.to, into: step.into, hasDocument: step.hasDocument, merges: step.merges, redirects: step.redirects }
}

/**
 * What a rename would do, before anything is written (ADR 0038): the concept named, the scoped
 * concepts the cascade carries, which documents' bodies would be rewritten, and any [[Merge]] -
 * so the agent sees the blast radius the dialog shows a person.
 */
export async function planRename(graph: HeadlessGraph, args: PlanRenameArgs) {
    const from = args.from.trim()
    const to = args.to.trim()
    if (from === '') throw new ToolError('invalid_argument', 'from must not be empty.')
    await graph.store.refresh()
    if (!conceptExists(graph, from)) throw new ToolError('not_found', `Nothing in the graph is named "${from}".`)
    const identity = resolveIdentity(graph, from)
    if (identity) refuseIfProtected(identity.concept, await liveText(graph, identity))
    // A page is renamed by its title, whichever of its names the agent gave, as `rename` does.
    const subject = identity?.concept ?? from
    const referencing = await referencingDocuments(graph, subject)
    const plan = await graph.store.planRename(subject, to, referencing.length)
    const steps = renameSteps(plan)
    return {
        from: subject,
        to,
        refusal: plan.refusal,
        direct: renameStepView(plan.direct),
        cascade: plan.cascade.map(renameStepView),
        referencingDocuments: referencing,
        merges: steps.filter((step) => step.merges).map((step) => ({ from: step.from, into: step.into })),
        // Aliases that name it as a scope move with it (ADR 0038, amended 2026-10-03).
        aliases: plan.aliases.map((alias) => ({ document: alias.holder, from: alias.from, to: alias.to })),
        protectedDocuments: protectedDocumentCount(graph),
    }
}

/**
 * Rename a concept (ADR 0037, 0038, 0064): its page if it has one, every scoped concept beneath
 * it, and - by default - every link to it. Rewrite is the default because an agent renaming is
 * nearly always correcting a name, and aliases would pile up unseen under automation; `alias`
 * is there for a name that is still a name for the thing. A merge is the one irreversible step
 * and needs `confirm_merge`.
 */
export async function rename(graph: HeadlessGraph, args: RenameArgs) {
    const from = args.from.trim()
    const to = args.to.trim()
    const strategy: RenameLinkStrategy = args.strategy ?? 'rewrite'
    if (from === '') throw new ToolError('invalid_argument', 'from must not be empty.')
    if (to === '') throw new ToolError('invalid_argument', 'to must not be empty.')
    if (strategy !== 'rewrite' && strategy !== 'alias') throw new ToolError('invalid_argument', 'strategy must be "rewrite" or "alias".')
    await graph.store.refresh()
    if (!conceptExists(graph, from)) throw new ToolError('not_found', `Nothing in the graph is named "${from}".`)
    const identity = resolveIdentity(graph, from)
    if (identity) refuseIfProtected(identity.concept, await liveText(graph, identity))
    const subject = identity?.concept ?? from
    const referencing = await referencingDocuments(graph, subject)
    const plan = await graph.store.planRename(subject, to, referencing.length)
    if (plan.refusal) throw new ToolError('invalid_argument', plan.refusal)
    const merges = mergeCount(plan)
    if (merges > 0 && !args.confirm_merge) {
        const joins = renameSteps(plan)
            .filter((step) => step.merges)
            .map((step) => `"${step.from}" into "${step.into}"`)
            .join(', ')
        throw new ToolError(
            'merge_requires_confirmation',
            `Renaming "${subject}" to "${to}" would merge ${joins}: the documents' contents are joined into one and cannot be separated afterwards. Call rename again with confirm_merge: true to do it, or choose a name that is not taken.`,
        )
    }
    let result
    try {
        result = await graph.store.renamePage(subject, to, { strategy, referencing })
    } catch (error) {
        if (error instanceof RenameUnconfirmedError) throw new ToolError('unconfirmed_documents', error.message)
        throw error
    }
    await settle(graph)
    return {
        concept: result.concept,
        strategy,
        rewrittenDocuments: result.rewrittenDocuments,
        cascaded: plan.cascade.map((step) => ({ from: step.from, to: step.into })),
        merged: result.merged,
        aliasesRewritten: result.aliasesRewritten,
    }
}

/**
 * Replace a document's aliases. A name already answered to by another document - as its title
 * or one of its aliases - is refused rather than merged: an alias is cheap to choose
 * differently, and a merge from an alias edit would be a surprise.
 */
export async function setAliases(graph: HeadlessGraph, args: SetAliasesArgs) {
    if (!Array.isArray(args.aliases) || args.aliases.some((alias) => typeof alias !== 'string')) {
        throw new ToolError('invalid_argument', 'aliases must be a list of names.')
    }
    await graph.store.refresh()
    const identity = requireIdentity(graph, args.concept)
    refuseIfProtected(identity.concept, await liveText(graph, identity))
    const aliases: string[] = []
    for (const raw of args.aliases) {
        const alias = raw.trim()
        if (alias === '' || conceptKey(alias) === identity.key || aliases.some((a) => conceptKey(a) === conceptKey(alias))) continue
        const holder = resolveIdentity(graph, alias)
        if (holder && holder.key !== identity.key) {
            throw new ToolError('name_taken', `"${alias}" is already a name of "${holder.concept}", so it cannot be an alias of "${identity.concept}".`)
        }
        aliases.push(alias)
    }
    try {
        await graph.store.setAliases(identity.concept, aliases)
    } catch (error) {
        if (error instanceof DocumentUnconfirmedError) throw new ToolError('unconfirmed_documents', error.message)
        throw error
    }
    await settle(graph)
    await graph.store.refresh()
    return { concept: identity.concept, aliases: resolveIdentity(graph, identity.concept)?.aliases ?? aliases }
}

// ── Assets (ADR 0085) ─────────────────────────────────────────────────────────────────────

/** Every asset reference in a body: `../assets/<name>` at any depth, as markdown or HTML writes it. */
const ASSET_REFS = /(?:\.\.\/)+assets\/[^\s)"'<>\]]+/g

export function assetReferencesIn(body: string): string[] {
    const refs: string[] = []
    for (const match of body.matchAll(ASSET_REFS)) refs.push(match[0])
    return refs
}

function requireAssets(graph: HeadlessGraph) {
    if (!graph.assets) throw new ToolError('assets_unavailable', 'This process has no asset storage for the graph, so assets cannot be read or added here.')
    return graph.assets
}

/** `../assets/x`, `assets/x` or a bare file name, as one document-relative reference. */
function normaliseRef(ref: string): string {
    const trimmed = ref.trim()
    if (/^(?:\.\.\/)+assets\//.test(trimmed)) return trimmed
    if (trimmed.startsWith('assets/')) return `../${trimmed}`
    return `../assets/${trimmed}`
}

/** What to call an asset for a person: the reference's file name without its hash or id. */
function displayNameOf(ref: string): string {
    const file = decodeURIComponent(ref.split('/').pop() ?? ref)
    const id = assetIdFromRef(file)
    return id ? file.replace(`.${id}`, '') : displayAssetName(file)
}

/**
 * Whether an asset can reach this agent: some document it can read references it, or this
 * session uploaded it. The index counts references over unprotected bodies only, so an asset
 * named solely inside a [[Protected Document]] is not here, nor is an orphan (ADR 0085).
 */
async function reachable(graph: HeadlessGraph, identity: string): Promise<{ concept: string; kind: 'page' | 'journal' }[] | null> {
    const assets = requireAssets(graph)
    const usage = await graph.index.assetUsage([identity])
    if (usage.documents.length > 0) return usage.documents.map((d) => ({ concept: d.concept, kind: d.kind }))
    if (assets.uploaded.has(identity)) return []
    return null
}

/**
 * Add a file on this machine to the graph as an [[Asset]] and return the reference to write
 * into a document. A faithful copy of the bytes, as an [[Import]]'s is: no [[Image
 * Optimisation]], which belongs to the routes a person adds by (ADR 0080). Bytes the graph
 * already holds become a reference to the existing asset (`reused: true`).
 */
export async function uploadAsset(graph: HeadlessGraph, args: UploadAssetArgs) {
    const assets = requireAssets(graph)
    if (!args.path || args.path.trim() === '') throw new ToolError('invalid_argument', 'path must name a file on this machine.')
    let file
    try {
        file = await readLocalFile(args.path.trim(), { env: process.env, downloadsDir: assets.downloadsDir })
    } catch (error) {
        throw new ToolError('invalid_argument', `Cannot read "${args.path}": ${error instanceof Error ? error.message : String(error)}`)
    }
    const name = (args.name ?? file.name).trim() || file.name
    const type = mimeTypeForExt(splitNameExt(name).ext) || 'application/octet-stream'
    let saved
    try {
        saved = await assets.store.save({ name, bytes: file.bytes, type })
    } catch (error) {
        if (error instanceof AssetRefusedError) throw new ToolError('asset_refused', `The server declined the upload (${error.code}): ${error.message}`)
        throw error
    }
    const identity = assets.identify(saved.ref)
    if (identity) assets.uploaded.add(identity)
    return {
        ref: saved.ref,
        name: displayNameOf(saved.ref),
        type,
        bytes: file.bytes.byteLength,
        reused: saved.reused === true,
        /** Paste this into a document to show the asset: an image tag for an image, a link otherwise. */
        markdown: buildAssetMarkdown(saved),
    }
}

/**
 * Write an asset's bytes to a file on this machine and say where. Served only where a document
 * the agent can read references it (ADR 0085); otherwise `asset_not_found`, whether the graph
 * holds the asset or not.
 */
export async function readAsset(graph: HeadlessGraph, args: ReadAssetArgs) {
    const assets = requireAssets(graph)
    if (!args.ref || args.ref.trim() === '') throw new ToolError('invalid_argument', 'ref must be an asset reference or name.')
    await graph.store.refresh()
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(args.ref.trim())) throw new ToolError('invalid_argument', `"${args.ref}" is a url, not an asset of this graph.`)
    const ref = normaliseRef(args.ref)
    const identity = assets.identify(ref)
    if (!identity) throw new ToolError('invalid_argument', `"${args.ref}" is not an asset reference of this graph.`)
    const documents = await reachable(graph, identity)
    if (!documents) throw new ToolError('asset_not_found', `No document you can read references "${displayNameOf(ref)}", so it is not available here.`)
    const asset = await assets.store.readBytes(ref)
    if (!asset) throw new ToolError('asset_not_found', `The graph does not hold "${displayNameOf(ref)}" (the reference may be broken).`)
    let directory
    try {
        directory = await folderUnder(assets.downloadsDir, args.out_dir, '.')
    } catch (error) {
        if (error instanceof FolderRefused) throw new ToolError('invalid_argument', error.message)
        throw error
    }
    // The stored name is a collaborator's to set; writeDownload reduces it to one plain file name.
    const path = await writeDownload(directory, asset.name || displayNameOf(ref), asset.bytes)
    return { path, name: asset.name || displayNameOf(ref), type: asset.type, bytes: asset.bytes.byteLength, ref, documents }
}

/**
 * The assets referenced from documents the agent can read - all of them, or one document's -
 * each with the documents that reference it. Built from the bodies rather than the server's
 * enumeration, so an orphan or a protected document's attachment is never listed (ADR 0085).
 */
export async function listAssets(graph: HeadlessGraph, args: ListAssetsArgs = {}) {
    const assets = requireAssets(graph)
    await graph.store.refresh()
    let bodies: Map<string, string>
    let unconfirmed: string[] = []
    if (args.concept !== undefined && args.concept.trim() !== '') {
        const identity = requireIdentity(graph, args.concept)
        const text = await liveText(graph, identity)
        refuseIfProtected(identity.concept, text)
        bodies = new Map([[identity.concept, text]])
    } else {
        ;({ bodies, unconfirmed } = await graph.store.readBodies())
    }
    const found = new Map<string, { ref: string; name: string; type: string; documents: Set<string> }>()
    for (const [concept, body] of bodies) {
        for (const ref of assetReferencesIn(body)) {
            const id = assets.identify(ref)
            if (!id) continue
            const entry = found.get(id) ?? { ref, name: displayNameOf(ref), type: mimeTypeForExt(splitNameExt(displayNameOf(ref)).ext), documents: new Set<string>() }
            entry.documents.add(concept)
            found.set(id, entry)
        }
    }
    let sizes: Map<string, number> | undefined
    try {
        sizes = await assets.sizes?.()
    } catch {
        sizes = undefined // the listing is still right without sizes
    }
    const list = [...found.entries()]
        .map(([id, entry]) => ({
            ref: entry.ref,
            name: entry.name,
            type: entry.type,
            ...(sizes?.has(id) ? { bytes: sizes.get(id) } : {}),
            documents: [...entry.documents].sort(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    return { assets: list, total: list.length, ...(unconfirmed.length > 0 ? { unconfirmed } : {}) }
}

// ── Reading several, tasks, orientation ───────────────────────────────────────────────────

/**
 * Several documents in one call, each as `read_document` returns it, with a refusal reported
 * per document (protected, not found) rather than failing the call. Capped per document and
 * across the call, so one call cannot flood the context.
 */
export async function readDocuments(graph: HeadlessGraph, args: { concepts: string[] }) {
    if (!Array.isArray(args.concepts) || args.concepts.length === 0) throw new ToolError('invalid_argument', 'concepts must be a non-empty list of names.')
    if (args.concepts.length > READ_MANY_LIMIT) throw new ToolError('too_many', `At most ${READ_MANY_LIMIT} documents per call - ask again for the rest.`)
    await graph.store.refresh()
    let budget = READ_MANY_TEXT_CAP
    const documents: Array<ReadDocumentResult | { concept: string; error: ToolErrorCode; message: string }> = []
    for (const wanted of args.concepts) {
        const identity = resolveIdentity(graph, wanted)
        if (!identity) {
            documents.push({ concept: wanted, error: 'not_found', message: `No document is named "${wanted}".` })
            continue
        }
        const text = await liveText(graph, identity)
        if (documentProtection(text).kind === 'document') {
            documents.push({ concept: identity.concept, error: 'protected_document', message: `"${identity.concept}" is a protected document and cannot be read here.` })
            continue
        }
        const cap = Math.max(0, Math.min(READ_TEXT_CAP, budget))
        const cut = text.length > cap
        budget -= Math.min(text.length, cap)
        documents.push({
            concept: identity.concept,
            kind: identity.kind,
            aliases: identity.aliases,
            text: cut ? text.slice(0, cap) : text,
            frontmatter: agentFrontmatter(graph.store.openRaw(identity.concept).getText()),
            truncated: cut,
        })
    }
    return { documents }
}

/**
 * Change one task's status, priority or dates, by document and line (ADR 0032's grammar).
 * The line is rewritten by the writer a Kanban Board move uses (`task-write.ts`), so a status
 * here means exactly what a lane means: exclusive, `waiting` and `doing` unchecked states, `done`
 * and `cancelled` checked ones, `open` none of them, and no completion date written. `expect` is
 * the stale-line guard, made explicit for a caller working from a list.
 */
export async function setTask(graph: HeadlessGraph, args: SetTaskArgs) {
    if (args.reference !== undefined) {
        // Found by position and words, so the line and the expected text come from the reference.
        const found = await requireReferencedTask(graph, args.reference)
        return setTask(graph, { concept: found.document, line: found.line, changes: args.changes })
    }
    if (args.concept === undefined) throw new ToolError('invalid_argument', 'Name the task by reference, or by concept and line.')
    if (args.line === undefined || !Number.isInteger(args.line) || args.line < 0) throw new ToolError('invalid_argument', 'line must be a non-negative integer.')
    const line = args.line
    const changes = args.changes ?? {}
    if (changes.status !== undefined && !TASK_STATUSES.includes(changes.status)) throw new ToolError('invalid_argument', `Unknown task status "${String(changes.status)}".`)
    if (changes.priority !== undefined && changes.priority !== null && ![1, 2, 3].includes(changes.priority)) throw new ToolError('invalid_argument', 'priority must be 1, 2, 3 or null.')
    for (const [key, value] of [['due', changes.due], ['scheduled', changes.scheduled]] as const) {
        if (value !== undefined && value !== null && !isJournalConcept(value)) throw new ToolError('invalid_argument', `${key} must be a day as YYYY-MM-DD, or null.`)
    }
    await graph.store.refresh()
    const identity = requireIdentity(graph, args.concept)
    const text = await liveText(graph, identity)
    refuseIfProtected(identity.concept, text)
    const lines = text.split('\n')
    const current = lines[line]
    const parsed = current === undefined ? null : parseTaskLine(current)
    if (!parsed) throw new ToolError('task_moved', `Line ${line} of "${identity.concept}" is not a task now - read the document or list tasks again.`)
    // `tasks` reports the text with its tag run; a caller may also pass the bare text.
    const afterCheckbox = current!.replace(/^\s*-\s+\[[ xX]\]\s?/, '').trim()
    if (args.expect !== undefined && args.expect.trim() !== afterCheckbox && args.expect.trim() !== parsed.text.trim()) {
        throw new ToolError('task_moved', `Line ${line} of "${identity.concept}" now reads "${parsed.text}", not "${args.expect}" - list tasks again before changing it.`)
    }
    // A task line, since `parsed` is not null; a task already as asked comes back unchanged.
    const next = taskLineWith(current!, changes) ?? current!
    const edit = minimalReplacement(current!, next)
    if (edit) {
        // The smallest edit over the line, so on a synced graph it merges with anyone typing
        // elsewhere in the same line rather than replacing it whole.
        const from = lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0)
        graph.store.open(identity.concept).applyChange({ from: from + edit.from, to: from + edit.to, insert: edit.insert }, 'external')
        await settle(graph)
    }
    const after = parseTaskLine(next)!
    const status: TaskStatus = after.done ? (after.cancelled ? 'cancelled' : 'done') : after.waiting ? 'waiting' : after.doing ? 'doing' : 'open'
    return {
        concept: identity.concept,
        line,
        text: after.text,
        status,
        priority: after.priority,
        due: after.due,
        scheduled: after.scheduled,
        changed: next !== current,
        reference: await referenceFor(graph, identity.concept, line, bulletLabel(next)),
    }
}

/** A task's status from its parsed line, as the index derives it (`STATUS_SQL`). */
function statusOf(task: { done: boolean; cancelled: boolean; waiting: boolean; doing: boolean }): TaskStatus {
    return task.done ? (task.cancelled ? 'cancelled' : 'done') : task.waiting ? 'waiting' : task.doing ? 'doing' : 'open'
}

/** Where a Task Reference is resolved in this graph: its documents, read live, and its index. */
function referenceSources(graph: HeadlessGraph): TaskReferenceSources {
    return {
        // A folder graph's id is its own on each computer, so a reference is not checked against it.
        graphId: graph.backend.kind === 'synced' ? graph.graphId : null,
        resolveDocument: (name) => resolveIdentity(graph, name)?.concept ?? null,
        async readBody(document) {
            const identity = resolveIdentity(graph, document)
            if (!identity) return null
            const text = await liveText(graph, identity)
            // A protected document's tasks cannot be read here, so it holds none to find.
            return documentProtection(text).kind === 'document' ? null : text
        },
        allTasks: () => everyIndexedTask(graph.index, todayISO()),
    }
}

/** The Task Reference to the task at `line` of `concept`, whose label is `label`. */
async function referenceFor(graph: HeadlessGraph, concept: string, line: number, label: string): Promise<string> {
    const fingerprint = await taskFingerprint(label)
    return taskReferenceUrl({ graphId: graph.graphId, document: concept, line, fingerprint }, graph.clientUrl ?? '')
}

/** The task a Task Reference names in this graph, or the error that says why there is none. */
async function requireReferencedTask(graph: HeadlessGraph, reference: string): Promise<ResolvedTaskReference> {
    const parsed = parseTaskReference(reference)
    if (!parsed) {
        throw new ToolError('invalid_argument', 'That is not a task reference: one ends in #task=<line>-<fingerprint>, as Copy task reference in EtherPK writes it.')
    }
    await graph.store.refresh()
    const found = await resolveTaskReference(parsed, referenceSources(graph))
    if (found.ok) return found
    if (found.code === 'other_graph') {
        throw new ToolError('other_graph', `That task reference is for another graph. This server serves "${graph.name}" (${found.servedGraphId}); ask the user to connect the graph the reference is from.`)
    }
    if (found.code === 'task_ambiguous') {
        const where = found.candidates.map((candidate) => `"${candidate.document}" line ${candidate.line}`).join(', ')
        throw new ToolError('task_ambiguous', `More than one task has those words (${where}), so none was chosen. Ask the user which one, or name it by concept and line.`)
    }
    throw new ToolError('task_not_found', 'No task in the graph has those words now: it was edited or deleted. Ask the user for a fresh reference.')
}

/**
 * The block's own lines and everything nested under it: in the index's rows, which run in
 * document order, the rows after it until one that is not its descendant.
 */
function subtreeEnd(blocks: ReturnType<typeof deriveDoc>['blocks'], localId: number): number {
    let end = blocks[localId].endLine
    const inside = new Set([localId])
    for (let i = localId + 1; i < blocks.length; i++) {
        const parent = blocks[i].parentId
        if (parent === null || !inside.has(parent)) break
        inside.add(i)
        end = Math.max(end, blocks[i].endLine)
    }
    return end
}

export interface ReadTaskArgs {
    reference: string
}

/**
 * The task a Task Reference names: its words and tags, where it is now, what is above it (the
 * headings and bullets its breadcrumb names) and its detail (its continuation lines and
 * everything nested under it), and how it was found. For the text around it, read the document.
 */
export async function readTask(graph: HeadlessGraph, args: ReadTaskArgs) {
    const found = await requireReferencedTask(graph, args.reference)
    const lines = found.body.split('\n')
    const line = lines[found.line]
    const task = parseTaskLine(line)!
    const { blocks } = deriveDoc(found.body)
    const block = blocks.find((candidate) => candidate.startLine === found.line)
    const end = block ? subtreeEnd(blocks, block.localId) : found.line
    return {
        concept: found.document,
        line: found.line,
        text: task.text,
        status: statusOf(task),
        priority: task.priority,
        due: task.due,
        scheduled: task.scheduled,
        breadcrumb: block ? ancestorChain(blocks, block.parentId) : [],
        detail: lines.slice(found.line + 1, end + 1).join('\n'),
        foundBy: found.foundBy,
        reference: await referenceFor(graph, found.document, found.line, bulletLabel(line)),
    }
}

export interface AddTaskNoteArgs {
    reference: string
    /** Markdown: a line, or bullets of its own, nested under the task after what is already there. */
    text: string
}

/**
 * Add a note under the task a Task Reference names: the text as a bullet one level under the
 * task, after its existing detail, so a Kanban Board's Task Detail shows it with the task. Text
 * that is already bullets is nested as it is.
 */
export async function addTaskNote(graph: HeadlessGraph, args: AddTaskNoteArgs) {
    if (typeof args.text !== 'string' || args.text.trim() === '') throw new ToolError('invalid_argument', 'text must not be empty.')
    const found = await requireReferencedTask(graph, args.reference)
    const lines = found.body.split('\n')
    const { blocks } = deriveDoc(found.body)
    const block = blocks.find((candidate) => candidate.startLine === found.line)
    const end = block ? subtreeEnd(blocks, block.localId) : found.line
    const childIndent = `${/^\s*/.exec(lines[found.line])![0]}  `
    const written = asWritten(args.text.trim())
    // A line of prose becomes a bullet whose later lines continue it; bullets are nested as they are.
    const note = written.startsWith('- ') ? written : `- ${written.replace(/\n/g, '\n  ')}`
    const insert = note
        .split('\n')
        .map((noteLine) => (noteLine === '' ? noteLine : childIndent + noteLine))
        .join('\n')
    const at = lines.slice(0, end + 1).reduce((n, l) => n + l.length + 1, 0) - 1
    graph.store.open(found.document).applyChange({ from: at, to: at, insert: `\n${insert}` }, 'external')
    await settle(graph)
    return {
        concept: found.document,
        line: found.line,
        noteLine: end + 1,
        reference: await referenceFor(graph, found.document, found.line, bulletLabel(lines[found.line])),
    }
}

/** What an agent should know before it starts: where it is, what is here, what is set up. */
export async function graphInfo(graph: HeadlessGraph) {
    await graph.store.refresh()
    const documents = graph.store.listDocuments()
    const protectedKeys = new Set(graph.index.allConcepts().filter((c) => c.protected && (c.kind === 'page' || c.kind === 'journal')).map((c) => c.key))
    const semantic = await graph.semanticOpened()
    const status = semantic ? await semantic.status() : undefined
    return {
        name: graph.name,
        backend: graph.backend,
        documents: {
            pages: documents.filter((d) => d.kind === 'page').length,
            journals: documents.filter((d) => d.kind === 'journal').length,
            protected: documents.filter((d) => protectedKeys.has(d.key)).length,
        },
        semantic: status
            ? { state: 'open' as const, embedded: status.embedded, total: status.total, complete: status.embedded >= status.total }
            : { state: 'not-opened' as const, note: 'The first search with mode "semantic" loads the model - if it is not set up on this computer, that search says so and names the command.' },
        assets: { available: graph.assets !== undefined },
    }
}
