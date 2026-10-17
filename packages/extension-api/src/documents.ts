/**
 * Reading the open graph's documents, as a language model may read them for a person (ADR 0147).
 *
 * Every answer leaves out a [[Protected Document]] entirely: not its content, and not its name
 * either, even while the person holds the Protection Key. That is stricter than the index's
 * answers (`context.index`), which list a Protected Document by name, because what an extension
 * reads here may be sent to a model provider. A document whose text holds an encrypted fence
 * anywhere counts as protected here too.
 *
 * Every answer is bounded: a list is paged, and a document's text is cut at a cap and says so. A
 * page of a listing holds at most 200 documents or tasks, and a page of a search 50 results. A
 * document's text is cut after 200,000 characters. The format guide's wording changes as the format
 * does, so an extension passes it on and never reads meaning into its words.
 */

/**
 * A document as a listing names it.
 *
 * @public
 */
export interface DocumentSummary {
    /** The document's name: a page's title, or a journal entry's day, `YYYY-MM-DD`. */
    name: string
    /** A page or a journal entry. */
    kind: 'page' | 'journal'
    /** The page's other names. */
    aliases: string[]
}

/**
 * A document's text, as {@link ExtensionDocuments.read} answers.
 *
 * @public
 */
export interface DocumentText extends DocumentSummary {
    /** The body: the text after the frontmatter block, cut at the cap. */
    text: string
    /** True when the text was cut at the cap. */
    truncated: boolean
}

/**
 * One document a search matched, with the lines that matched.
 *
 * @public
 */
export interface DocumentSearchResult extends Omit<DocumentSummary, 'aliases'> {
    /** How many lines matched. */
    matches: number
    /** The matching lines, best first. */
    hits: {
        /** The line's number in the document's text, from 0. */
        line: number
        /** The labels of the blocks the line sits under, outermost first. */
        breadcrumb: string[]
        /** The line's text around the match. */
        snippet: string
    }[]
}

/**
 * One document whose text links to the concept asked about, with each place it does.
 *
 * @public
 */
export interface DocumentBacklink extends Omit<DocumentSummary, 'aliases'> {
    references: {
        /** The line's number in the source's text, from 0. */
        line: number
        /** The labels of the blocks the reference sits under, outermost first. */
        breadcrumb: string[]
        /** The block holding the link with its children, or the prose around it. */
        text: string
    }[]
}

/**
 * One task, as the Tasks View lists it.
 *
 * @public
 */
export interface DocumentTask extends Omit<DocumentSummary, 'aliases'> {
    /** The task's line in the document's text, from 0. */
    line: number
    /** The task's words, without the checkbox. */
    text: string
    status: 'open' | 'doing' | 'waiting' | 'done' | 'cancelled'
    /** 1 is the highest; null when the task has none. */
    priority: 1 | 2 | 3 | null
    /** `YYYY-MM-DD`, or null. */
    due: string | null
    /** `YYYY-MM-DD`, or null. */
    scheduled: string | null
    /** The labels of the blocks the task sits under, outermost first. */
    breadcrumb: string[]
}

/**
 * Reading the open graph's documents.
 *
 * @public
 */
export interface ExtensionDocuments {
    /** Pages and journal entries, journals newest first and then pages by name, a page at a time. */
    list(options?: { kind?: 'page' | 'journal'; offset?: number; limit?: number }): Promise<{ documents: DocumentSummary[]; total: number; hasMore: boolean }>
    /**
     * A document's text by its name or an alias, or null when there is no such document or it is
     * protected. The text is the document as it is now, edits not yet saved included.
     */
    read(name: string): Promise<DocumentText | null>
    /**
     * The names of the documents a document's wikilinks name directly, in the order they first
     * appear, each once. Names with no document, and protected documents, are left out. Null when
     * the document cannot be read.
     */
    links(name: string): Promise<string[] | null>
    /** The documents whose text matches the words, best first, a page at a time. */
    search(query: string, options?: { offset?: number; limit?: number }): Promise<{ results: DocumentSearchResult[]; total: number; hasMore: boolean }>
    /** The documents that link to a concept, or null when the concept is a protected document. */
    backlinks(name: string): Promise<DocumentBacklink[] | null>
    /**
     * How the graph's documents are written, as the Client describes it to agents: names and
     * wikilinks, the outline, tasks and the rest of the syntax, in markdown. The same words the
     * `AGENTS.md` of a graph folder carries, less what is about files on a disk, so a model reading
     * the graph's text understands it and names documents as `[[Name]]`.
     */
    formatGuide(): string
    /** Tasks, open ones unless asked otherwise, of one concept or of the whole graph, a page at a time. */
    tasks(options?: {
        /** Only the tasks that answer to this concept. */
        concept?: string
        statuses?: DocumentTask['status'][]
        offset?: number
        limit?: number
    }): Promise<{ tasks: DocumentTask[]; total: number; hasMore: boolean }>
}
