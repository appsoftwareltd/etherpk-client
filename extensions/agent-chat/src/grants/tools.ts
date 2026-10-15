/**
 * The tools a model gets under the whole-graph [[Context Grant]] (ADR 0147): it searches and reads
 * the graph through `context.documents`, which leaves every Protected Document out, name and all.
 * They only read. Each call shows in the chat as a chip saying what it did (`summarizeToolCall`),
 * so the person sees every document that was read and sent.
 *
 * Only the runner imports this module, when a chat first sends, so the AI SDK stays out of the
 * Client's first download.
 */
import type { ExtensionDocuments } from '@appsoftwareltd/etherpk-extension-api'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

/** Characters of one document a tool read gives the model, so a long one cannot fill its context. */
export const TOOL_READ_CAP = 60_000

/** The names of the graph tools, which the chips are made for. */
export const GRAPH_TOOL_NAMES = ['search_documents', 'read_document', 'list_documents', 'document_links', 'backlinks', 'tasks'] as const

/** A tool call in the person's words, for its chip. */
export function summarizeToolCall(name: string, input: unknown): string {
    const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
    const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : '')
    switch (name) {
        case 'search_documents':
            return `Searched for "${text('query')}"`
        case 'read_document':
            return `Read ${text('name')}`
        case 'list_documents':
            return 'Listed documents'
        case 'document_links':
            return `Followed the links in ${text('name')}`
        case 'backlinks':
            return `Found what links to ${text('name')}`
        case 'tasks':
            return text('concept') ? `Listed the tasks of ${text('concept')}` : 'Listed tasks'
        case 'web_search':
        case 'google_search':
            return text('query') ? `Searched the web for "${text('query')}"` : 'Searched the web'
        default:
            return `Used ${name}`
    }
}

export function graphTools(documents: ExtensionDocuments): ToolSet {
    return {
        search_documents: tool({
            description: "Search the text of the person's documents. Returns the documents that match, best first, with the lines that matched.",
            inputSchema: z.object({
                query: z.string().describe('Words to look for. key:value narrows to documents with that property.'),
                limit: z.number().int().min(1).max(50).optional(),
            }),
            execute: async ({ query, limit }) => documents.search(query, { limit: limit ?? 10 }),
        }),
        read_document: tool({
            description: 'Read one document by its exact name or an alias. Returns its text, or an error when no readable document has that name.',
            inputSchema: z.object({ name: z.string().describe('The document name, as in [[Name]]: a page title or a day, YYYY-MM-DD.') }),
            execute: async ({ name }) => {
                const read = await documents.read(name)
                if (!read) return { error: `No readable document is named "${name}".` }
                const cut = read.text.length > TOOL_READ_CAP
                return { name: read.name, kind: read.kind, aliases: read.aliases, text: cut ? read.text.slice(0, TOOL_READ_CAP) : read.text, truncated: read.truncated || cut }
            },
        }),
        list_documents: tool({
            description: 'List the documents in the graph: journal entries newest first, then pages by name. Paged.',
            inputSchema: z.object({
                kind: z.enum(['page', 'journal']).optional(),
                offset: z.number().int().min(0).optional(),
                limit: z.number().int().min(1).max(200).optional(),
            }),
            execute: async ({ kind, offset, limit }) => documents.list({ kind, offset, limit: limit ?? 100 }),
        }),
        document_links: tool({
            description: 'The names of the documents one document links to directly.',
            inputSchema: z.object({ name: z.string() }),
            execute: async ({ name }) => (await documents.links(name)) ?? { error: `No readable document is named "${name}".` },
        }),
        backlinks: tool({
            description: 'The documents that link to a concept, with the text around each link.',
            inputSchema: z.object({ name: z.string() }),
            execute: async ({ name }) => (await documents.backlinks(name)) ?? { error: `Nothing can be shown for "${name}".` },
        }),
        tasks: tool({
            description: 'Tasks in the graph, unfinished ones unless statuses are given, for one concept or every document.',
            inputSchema: z.object({
                concept: z.string().optional().describe('Only the tasks that answer to this concept.'),
                statuses: z.array(z.enum(['open', 'doing', 'waiting', 'done', 'cancelled'])).optional(),
            }),
            execute: async ({ concept, statuses }) => documents.tasks({ concept, statuses, limit: 100 }),
        }),
    }
}
