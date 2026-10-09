/**
 * What an extension may ask the Derived Index, the open graph's searchable copy of its documents.
 * Every question is read-only, and a Protected Document contributes only what it does everywhere:
 * its name, never its content.
 */

/**
 * What kind of name a concept is.
 *
 * @beta
 */
export type ConceptKind = 'page' | 'journal' | 'alias' | 'pageless'

/**
 * One name the index knows: a page, a journal entry, an alias, or a Pageless Concept (a name
 * wikilinks use that has no page).
 *
 * @beta
 */
export interface ConceptCandidate {
    /** The name as written. */
    display: string
    /** The case-insensitive key every index answer uses for it. */
    key: string
    /** What kind of name it is. */
    kind: ConceptKind
    /** For an alias: the name of the page it resolves to. */
    canonical?: string
    /** For a Pageless Concept: how many wikilinks name it. */
    references?: number
    /** Present, and true, when the name opens a Protected Document. */
    protected?: true
}

/**
 * One concept in the link graph.
 *
 * @beta
 */
export interface LinkGraphConcept {
    /** The case-insensitive key every other answer uses. */
    key: string
    /** The page's title, or for a Pageless Concept the casing most of its mentions use. */
    name: string
    /** A page, a journal entry, or a name only wikilinks use. */
    kind: 'page' | 'journal' | 'pageless'
    /** For a journal entry named for a day that exists: that day, `YYYY-MM-DD`. */
    day?: string
    /** Present, and true, only for a Protected Document. */
    protected?: true
}

/**
 * One line, from the document whose text holds the wikilinks to the concept they name. Both ends
 * are positions in {@link LinkGraph.concepts}.
 *
 * @beta
 */
export interface LinkGraphLink {
    /** The document whose text holds the wikilinks, by its position in `concepts`. */
    source: number
    /** The concept they name, by its position in `concepts`. */
    target: number
    /** How many wikilinks in the source name the target, under its name or any alias. */
    mentions: number
    /** Present, and true, when the source's own name is scoped by the target. */
    inTitle?: true
}

/**
 * Every concept and every line a wikilink draws between two of them.
 *
 * @beta
 */
export interface LinkGraph {
    /** Sorted by key, so two answers over the same index are identical. */
    concepts: LinkGraphConcept[]
    /** Sorted by source, then target. A pair linked both ways is two links. */
    links: LinkGraphLink[]
}

/**
 * What changed in one update the index committed.
 *
 * @beta
 */
export interface IndexUpdate {
    /** The whole index was read again, so anything may have changed. */
    full: boolean
    /** The keys of the concepts whose documents changed. */
    changedConceptKeys: ReadonlySet<string>
    /** The keys of the concepts whose backlinks changed. */
    backlinkTargetsChanged: ReadonlySet<string>
    /** A place or route may have changed. Always true for a full update. */
    mapsChanged: boolean
}

/**
 * The questions an extension may ask the open graph's index.
 *
 * @beta
 */
export interface ExtensionIndex {
    /** Every name the index knows, aliases and Pageless Concepts included. */
    allConcepts(): readonly ConceptCandidate[]
    /** Every concept, and every pair a wikilink joins. */
    linkGraph(): Promise<LinkGraph>
    /** Called after each update the index commits. Returns the unsubscribe. */
    onUpdated(listener: (update: IndexUpdate) => void): () => void
}
