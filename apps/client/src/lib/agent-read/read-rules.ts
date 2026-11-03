/**
 * What an agent may read of a graph, and how much, for both readers that give a language model the
 * graph's text: the [[Headless Client]]'s MCP tools (`apps/mcp/src/tools.ts`) and an [[Agent Chat]]
 * in the browser (`documents-reader.ts`, ADR 0147). Kept in one place so the size caps, the test for
 * protected text and the shape of a search or backlinks answer cannot drift between the two.
 *
 * Both leave a [[Protected Document]] out entirely, its name as well as its content, because what
 * either reads goes to a model provider and a name alone can say what it was protected to hide
 * (ADR 0072, amended 2026-11-03). "Protected" is the index's own flag here: a document whose text
 * holds an encrypted fence anywhere, which is the safer side of whole-document protection.
 */
import type { LinkGraph } from '@appsoftwareltd/etherpk-extension-api'

import { withoutTemplateContent } from '#lib/document/backlinks/shown-backlinks.js'
import type { ConceptCandidate, DbBacklinkGroup, PropertyKeyInfo, PropertyMatch } from '#lib/document/index-db.js'
import type { SearchCountResult, SearchTextResult } from '#lib/document/index-worker/client.js'
import { documentProtection } from '#lib/document/protection/cipher-fence.js'
import { containsCipherFence } from '#lib/document/protection/fence-info.js'
import { type PropertyFilter, parseSearchQuery } from '#lib/document/search-query.js'

/** Documents one listing returns at most; the caller pages for more. */
export const LIST_PAGE_LIMIT = 200
/** Documents one search returns at most. */
export const SEARCH_PAGE_LIMIT = 50
/** Tasks one listing returns at most. */
export const TASK_PAGE_LIMIT = 200
/** UTF-16 units of one document's text given before the rest is cut and the answer says so. */
export const READ_TEXT_CAP = 200_000
/** Documents one bulk read may ask for. */
export const READ_MANY_LIMIT = 20
/** UTF-16 units across one bulk read before the rest is cut. */
export const READ_MANY_TEXT_CAP = 400_000

/** `text` cut at `cap`, and whether it was. */
export function capText(text: string, cap = READ_TEXT_CAP): { text: string; truncated: boolean } {
    return text.length > cap ? { text: text.slice(0, cap), truncated: true } : { text, truncated: false }
}

/** Whether `text` is a Protected Document's: its whole body one encrypted fence. */
export function isProtectedDocumentText(text: string): boolean {
    return documentProtection(text).kind === 'document'
}

/**
 * Whether `text` holds encrypted text anywhere: a Protected Document, or any other document with an
 * `etherpk-cipher` fence in it. The index flags both as protected (`index-db.ts`), and a reader whose
 * answers may leave the device treats both the same, which is the safer side.
 */
export function holdsEncryptedText(text: string): boolean {
    return containsCipherFence(text)
}

/**
 * The keys of every name an agent is never shown: each the index flags protected, a page's own
 * name and each of its aliases, since the index sets the flag on both.
 */
export function protectedKeys(candidates: readonly ConceptCandidate[]): Set<string> {
    return new Set(candidates.filter((candidate) => candidate.protected).map((candidate) => candidate.key))
}

/**
 * The [[Graph View]]'s link graph with every protected document taken out: its dot, every line in
 * or out of it, and any [[Pageless Concept]] it alone named (a protected page's title scopes), so
 * no ranking, path or list built on the answer can name one. The lines in go with the dot rather
 * than staying as lines to a name, which would make the page read as a Pageless Concept and invite
 * an agent to write a page that already exists. A route through a protected document is no route:
 * two concepts joined only through one are not shown joined. `hidden` adds keys the caller knows
 * to be protected that the answer has not flagged (an alias, a document flagged since).
 */
export function linkGraphWithoutProtected(graph: LinkGraph, hidden: ReadonlySet<string> = new Set()): LinkGraph {
    const isHidden = (index: number) => {
        const concept = graph.concepts[index]
        return concept === undefined || concept.protected === true || hidden.has(concept.key)
    }
    const links = graph.links.filter((link) => !isHidden(link.source) && !isHidden(link.target))
    const linked = new Set(links.flatMap((link) => [link.source, link.target]))
    // A Pageless Concept exists only through the links naming it, so one left with none goes too.
    const kept = graph.concepts.map((concept, index) => !isHidden(index) && (concept.kind !== 'pageless' || linked.has(index)))
    const position = new Map<number, number>()
    const concepts = graph.concepts.filter((_concept, index) => {
        if (!kept[index]) return false
        position.set(index, position.size)
        return true
    })
    return {
        concepts,
        links: links.map((link) => ({ ...link, source: position.get(link.source)!, target: position.get(link.target)! })),
    }
}

/** What a text search needs of the graph's index. */
export interface TextSearchIndex {
    propertyKeys(): Promise<PropertyKeyInfo[]>
    propertyMatch(filters: readonly PropertyFilter[]): Promise<PropertyMatch[]>
    searchText(query: string, offset: number, limit: number, filters?: readonly PropertyFilter[]): Promise<SearchTextResult>
    searchTextCount(query: string, filters?: readonly PropertyFilter[]): Promise<SearchCountResult>
}

export interface TextSearchOutput {
    results: {
        concept: string
        kind: 'page' | 'journal'
        matches: number
        hits: { line: number; breadcrumb: string[]; snippet: string }[]
        /** Only for a search made of property filters alone: the properties that matched. */
        properties?: PropertyMatch['properties']
    }[]
    total: number
    totalCapped: boolean
    hasMore: boolean
}

/**
 * A page of the documents whose text matches `query`, as [[Search]] reads it: a `key:value` term
 * whose key some unprotected document carries is a [[Property Filter]] (ADR 0107), and anything
 * else is words. The index holds no protected text, so no answer here can quote one.
 */
export async function searchText(index: TextSearchIndex, query: string, offset: number, limit: number): Promise<TextSearchOutput> {
    const keys = await index.propertyKeys()
    const { words, filters } = parseSearchQuery(query, new Set(keys.map((info) => info.key.toLowerCase())))
    if (filters.length > 0 && words.trim() === '') {
        const documents = await index.propertyMatch(filters)
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
    const [result, count] = await Promise.all([index.searchText(words, offset, limit, filters), index.searchTextCount(words, filters)])
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

export interface BacklinkSource {
    concept: string
    kind: 'page' | 'journal'
    /** `kind` says what `text` quotes: a block and its subtree, the prose around the link, or the source's own title. */
    references: { kind: 'block' | 'prose' | 'title'; line: number; breadcrumb: string[]; text: string }[]
}

/**
 * The documents that link to a concept, each with the places it does. A [[Template]]'s body is a
 * pattern rather than a reference (ADR 0144), so only its name is reported.
 */
export function backlinkSources(groups: readonly DbBacklinkGroup[]): BacklinkSource[] {
    return withoutTemplateContent(groups).map((group) => ({
        concept: group.sourceConcept,
        kind: group.sourceKind,
        references: group.refs.map((ref) => ({
            kind: ref.kind,
            line: ref.line,
            breadcrumb: ref.breadcrumb,
            text: ref.kind === 'block' ? ref.subtree.map((node) => node.text).join('\n') : (ref.context?.text ?? ''),
        })),
    }))
}
