/**
 * `context.documents` (ADR 0147): the open graph's documents as an [[Agent Chat]] reads them for a
 * language model, over the graph's own store and index.
 *
 * Every answer leaves out a [[Protected Document]] entirely, its name as well as its content, even
 * while the person holds the Protection Key, because what is read here may be sent to a model
 * provider. Two checks keep it out:
 *
 * - The index flags a document whose stored text holds an encrypted fence anywhere, on its own row
 *   and on each of its aliases. A flagged name answers as if there were no such document.
 * - Text is read from the store's own copy, never through the projection a workspace hands its
 *   editors, which shows an unlocked Protected Document's plaintext. Text holding an encrypted
 *   fence anywhere is refused too, so a document protected since the index last looked stays out.
 *
 * The caps and the shape of a search are the Headless Client's (`read-rules.ts`).
 */
import type {
    DocumentBacklink,
    DocumentSearchResult,
    DocumentSummary,
    DocumentTask,
    DocumentText,
    ExtensionDocuments,
} from '@appsoftwareltd/etherpk-extension-api'

import type { ConceptCandidate, DbBacklinkGroup, TaskHit, TaskQuery } from '$lib/document/index-db'
import type { TaskPageResult } from '$lib/document/index-worker/client'
import { wikilinkOccurrencesInSource } from '$lib/document/wikilink/source'
import { frontmatterSpan } from '$lib/storage/fs/frontmatter-span'
import { conceptKey } from '$lib/storage/fs/identity'

import { formatGuide } from './format-guide'
import { backlinkSources, capText, holdsEncryptedText, LIST_PAGE_LIMIT, SEARCH_PAGE_LIMIT, searchText, TASK_PAGE_LIMIT, type TextSearchIndex } from './read-rules'

/** The graph's documents and their text, from whichever store holds the graph. */
export interface AgentReadSource {
    /** Every document the store holds: its name, its kind and its aliases. */
    list(): readonly { concept: string; kind: 'page' | 'journal'; aliases: readonly string[] }[]
    /**
     * The whole stored text, frontmatter included, of each document named that the store holds and
     * could read; any other name is absent from the answer. Never the protected projection.
     */
    texts(concepts: readonly string[]): Promise<Map<string, string>>
}

/** What the reader asks the graph's index. */
export interface AgentReadIndex extends TextSearchIndex {
    allConcepts(): readonly ConceptCandidate[]
    backlinks(concept: string): Promise<DbBacklinkGroup[]>
    tasks(query: TaskQuery, offset: number, limit: number): Promise<TaskPageResult>
}

export interface DocumentsReaderDeps {
    source: AgentReadSource
    /** The open graph's index, read at call time because the workspace can swap it. Null while it is not open. */
    index: () => AgentReadIndex | null
    /** Today, `YYYY-MM-DD`, at the moment a task window is asked about. */
    today: () => string
}

/** The statuses a task listing shows unless asked for others: the unfinished ones. */
const OPEN_STATUSES: DocumentTask['status'][] = ['open', 'doing', 'waiting']

export function createDocumentsReader(deps: DocumentsReaderDeps): ExtensionDocuments {
    const index = (): AgentReadIndex => {
        const open = deps.index()
        if (!open) throw new Error("The graph's index is not open.")
        return open
    }

    /** The keys of every protected name the index knows, aliases included. */
    const protectedKeys = (): Set<string> =>
        new Set(
            index()
                .allConcepts()
                .filter((candidate) => candidate.protected)
                .map((candidate) => candidate.key),
        )

    /** The document a name or alias opens, or null for a name with no document or a protected one. */
    const resolve = (name: string): { concept: string; kind: 'page' | 'journal'; aliases: string[] } | null => {
        const key = conceptKey(name.trim())
        if (key === '' || protectedKeys().has(key)) return null
        const documents = deps.source.list()
        const own = documents.find((doc) => conceptKey(doc.concept) === key)
        const found = own ?? documents.find((doc) => doc.aliases.some((alias) => conceptKey(alias) === key))
        if (!found || protectedKeys().has(conceptKey(found.concept))) return null
        return { concept: found.concept, kind: found.kind, aliases: [...found.aliases] }
    }

    /** A document's stored text, or null when it cannot be read or holds encrypted text. */
    const storedText = async (concept: string): Promise<string | null> => {
        const text = (await deps.source.texts([concept])).get(concept)
        if (text === undefined || holdsEncryptedText(text)) return null
        return text
    }

    /** The text after the frontmatter block, whose `end` is already past its closing line break. */
    const bodyOf = (text: string): string => {
        const span = frontmatterSpan(text)
        return span ? text.slice(span.end) : text
    }

    return {
        async list(options = {}) {
            const hidden = protectedKeys()
            const offset = Math.max(0, options.offset ?? 0)
            const limit = Math.min(Math.max(0, options.limit ?? LIST_PAGE_LIMIT), LIST_PAGE_LIMIT)
            const all: DocumentSummary[] = deps.source
                .list()
                .filter((doc) => !hidden.has(conceptKey(doc.concept)))
                .filter((doc) => options.kind === undefined || doc.kind === options.kind)
                .map((doc) => ({ name: doc.concept, kind: doc.kind, aliases: [...doc.aliases] }))
            // The order the graph's own lists use: journals newest first (a day's name sorts as a
            // date), then pages by name.
            const journals = all.filter((doc) => doc.kind === 'journal').sort((a, b) => b.name.localeCompare(a.name))
            const pages = all.filter((doc) => doc.kind === 'page').sort((a, b) => a.name.localeCompare(b.name))
            const ordered = [...journals, ...pages]
            return { documents: ordered.slice(offset, offset + limit), total: ordered.length, hasMore: offset + limit < ordered.length }
        },

        async read(name): Promise<DocumentText | null> {
            const found = resolve(name)
            if (!found) return null
            const text = await storedText(found.concept)
            if (text === null) return null
            const capped = capText(bodyOf(text))
            return { name: found.concept, kind: found.kind, aliases: found.aliases, text: capped.text, truncated: capped.truncated }
        },

        async links(name) {
            const found = resolve(name)
            if (!found) return null
            const text = await storedText(found.concept)
            if (text === null) return null
            const out: string[] = []
            // The scanner skips links inside code, as the index does.
            for (const occurrence of wikilinkOccurrencesInSource(bodyOf(text))) {
                const target = resolve(occurrence.concept)
                if (!target || target.concept === found.concept || out.includes(target.concept)) continue
                out.push(target.concept)
            }
            return out
        },

        async search(query, options = {}) {
            const words = query.trim()
            if (words === '') return { results: [], total: 0, hasMore: false }
            const offset = Math.max(0, options.offset ?? 0)
            const limit = Math.min(Math.max(0, options.limit ?? 20), SEARCH_PAGE_LIMIT)
            const hidden = protectedKeys()
            const found = await searchText(index(), words, offset, limit)
            const results: DocumentSearchResult[] = found.results
                // The index holds no protected text, so this only guards a flag set since.
                .filter((result) => !hidden.has(conceptKey(result.concept)))
                .map((result) => ({ name: result.concept, kind: result.kind, matches: result.matches, hits: result.hits }))
            return { results, total: found.total, hasMore: found.hasMore }
        },

        async backlinks(name) {
            const key = conceptKey(name.trim())
            if (key === '' || protectedKeys().has(key)) return null
            const hidden = protectedKeys()
            const sources: DocumentBacklink[] = backlinkSources(await index().backlinks(name.trim()))
                .filter((source) => !hidden.has(conceptKey(source.concept)))
                .map((source) => ({
                    name: source.concept,
                    kind: source.kind,
                    references: source.references.map((reference) => ({ line: reference.line, breadcrumb: reference.breadcrumb, text: reference.text })),
                }))
            return sources
        },

        formatGuide,

        async tasks(options = {}) {
            const offset = Math.max(0, options.offset ?? 0)
            const limit = Math.min(Math.max(0, options.limit ?? 100), TASK_PAGE_LIMIT)
            const concept = options.concept?.trim() ? options.concept.trim() : null
            if (concept !== null && protectedKeys().has(conceptKey(concept))) return { tasks: [], total: 0, hasMore: false }
            const result = await index().tasks(
                {
                    concept,
                    statuses: options.statuses ?? OPEN_STATUSES,
                    priorities: [1, 2, 3, null],
                    due: 'any',
                    groupBy: 'document',
                    today: deps.today(),
                },
                offset,
                limit,
            )
            return { tasks: result.hits.map(toTask), total: result.total, hasMore: result.hasMore }
        },
    }
}

function toTask(hit: TaskHit): DocumentTask {
    return {
        name: hit.concept,
        kind: hit.kind,
        line: hit.line,
        text: hit.text,
        status: hit.cancelled ? 'cancelled' : hit.done ? 'done' : hit.doing ? 'doing' : hit.waiting ? 'waiting' : 'open',
        priority: hit.priority === 1 || hit.priority === 2 || hit.priority === 3 ? hit.priority : null,
        due: hit.due,
        scheduled: hit.scheduled,
        breadcrumb: hit.breadcrumb,
    }
}
