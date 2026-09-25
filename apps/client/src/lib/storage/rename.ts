/**
 * The shared vocabulary of a [[Rename]] (ADR 0037, 0038, 0064), used by both
 * [[Storage Backend]]s.
 *
 * A rename acts on the [[Concept]]; a page is a passenger. The decision the two options
 * encode: renaming a page leaves every `[[Old Name]]` in the graph pointing at a concept with
 * no page behind it, and neither fix is right often enough to impose. Aliasing touches one
 * document and honours "the source is always canonical"; rewriting makes the prose read
 * correctly but is N concurrent document edits with no transaction around them on a synced
 * graph. A [[Pageless Concept]] has nothing to alias, so for it there is no choice: renaming
 * one IS the rewrite (ADR 0064).
 */

import { dayIsNotAPageName, isJournalConcept } from '$lib/document/journal-concept'

/** How the rename deals with existing inbound links. */
export type RenameLinkStrategy =
    /** Add the old name to the page's [[Alias]]es; every existing link keeps resolving. */
    | 'alias'
    /** Rewrite top-level `[[old]]` occurrences across the graph to the new name. */
    | 'rewrite'

export interface RenameOptions {
    strategy: RenameLinkStrategy
    /**
     * The documents whose bodies reference the concept, by name, as the [[Derived Index]]
     * knows them (the dialog's "N documents link to X" set). On a [[Server Backend]] these are
     * the documents the rewrite brings current before it splices, and the only ones it reads
     * beyond the rename's own steps; absent, every document is read, which is right for a
     * caller with no index and slow on a large graph.
     */
    referencing?: readonly string[]
    /** How long a document may take to catch up with the relay before the rename is refused. */
    timeoutMs?: number
}

export interface RenameResult {
    /** The page's new concept. */
    concept: string
    /** Documents whose text was rewritten (`0` for the alias strategy). */
    rewritten: number
    /** The concepts of those documents, so a caller can say which - and an agent can check them. */
    rewrittenDocuments: string[]
    /** Scoped concepts dragged along by the cascade. */
    cascaded: number
    /** Steps that landed on a taken name and so merged. */
    merged: number
}

/**
 * A rename refused because a document it would have to read - a referencing document under
 * the rewrite arm, or a document one of its steps moves or merges - could not be brought to
 * text this device can trust in time. Refused whole rather than applied to the documents that
 * could be confirmed: a graph with half its links rewritten is worse than one with none, and
 * the second attempt, once sync has caught up, costs nothing.
 */
export class RenameUnconfirmedError extends Error {
    readonly name = 'RenameUnconfirmedError'

    constructor(readonly concepts: readonly string[]) {
        const list = concepts.slice(0, 5).join(', ') + (concepts.length > 5 ? '…' : '')
        super(
            `${concepts.length === 1 ? 'A document' : `${concepts.length} documents`} the rename would change ${concepts.length === 1 ? 'has' : 'have'} not finished syncing to this device: ${list}. Nothing was renamed; try again once sync has caught up.`,
        )
    }
}

/**
 * Why a rename was refused, as a user-facing message, or null when it may proceed.
 * Shared so both backends refuse identically.
 *
 * A [[Journal Entry]] is refused because its concept *is* its date and there is exactly one
 * per day; renaming it would break that invariant rather than express anything. A
 * journal-shaped [[Pageless Concept]] (a day nobody has written yet) is refused for the same
 * reason: its name is its day whether or not the entry exists.
 *
 * The same holds in the other direction: a page renamed TO a day is refused, rather than left
 * in `pages/` answering to the day or merged into its journal entry with a `title` block the
 * entry never carries (ADR 0056).
 *
 * A collision is NOT a refusal (ADR 0038 §4): it is a [[Merge]], confirmed in the dialog.
 */
export function renameRefusal(options: {
    from: string
    to: string
    /** The document's kind, or null when the concept has no document (ADR 0064). */
    kind: 'journal' | 'page' | null
}): string | null {
    const to = options.to.trim()
    if (to === '') return 'A page needs a non-empty name.'
    if (options.kind === 'journal' || (options.kind === null && isJournalConcept(options.from))) {
        return 'A journal entry cannot be renamed - its name is its date, and there is exactly one per day.'
    }
    // Only a page is refused: a pageless concept renamed to a day moves its links and writes no
    // document, and the links then name the day's entry, which is where they now point.
    if (options.kind === 'page' && isJournalConcept(to)) return dayIsNotAPageName(to)
    return null
}

/** One concept the rename moves: its current name and the name it takes. */
export interface RenameStep {
    from: string
    to: string
    /**
     * Whether `from` has a document. A step without one - a [[Pageless Concept]], directly
     * or in the cascade - moves only its links; there is no identity to write (ADR 0064).
     */
    hasDocument: boolean
    /**
     * True when `to` is already held by a different document AND `from` has one, so this
     * step is a [[Merge]] rather than a plain rename. A Merge joins two documents; with one
     * there is nothing to join.
     */
    merges: boolean
    /**
     * True when `from` has no document and `to` is held by one: the links are simply
     * redirected to the page that already has the name. Nothing is at risk, which is why the
     * dialog reports it neutrally rather than as a Merge (ADR 0064 §2).
     */
    redirects: boolean
    /**
     * The concept of the document this step ends up in. Equal to `to` unless `to` is another
     * document's [[Alias]]: a name is taken by whatever document answers to it, by title or by
     * alias, and a Merge joins into that document under ITS title - the alias already resolves
     * there, so nothing else needs to change for the asked-for name to work (ADR 0038 §4).
     */
    into: string
}

/**
 * Everything a rename will do, computed before anything is written (ADR 0038 §1).
 *
 * The dialog renders this so the user confirms the real blast radius - renaming one page and
 * silently retitling twelve others is precisely the surprise the informed-consent principle
 * exists to prevent - and the appliers consume the same plan, so preview and effect cannot
 * drift apart.
 */
export interface RenamePlan {
    /** The concept the user actually named. */
    direct: RenameStep
    /**
     * Scoped concepts dragged along, at any depth. Ordered deepest-first so a document is
     * never renamed onto a name a later step is about to vacate.
     */
    cascade: RenameStep[]
    /** Documents whose body text references the old name (the rewrite arm's cost). */
    referencingDocuments: number
    /** Refusal message, or null. When set, nothing else here should be acted on. */
    refusal: string | null
}

/** Every step, direct first - what an applier iterates. */
export function renameSteps(plan: RenamePlan): RenameStep[] {
    return [plan.direct, ...plan.cascade]
}

/** How many steps merge - what the dialog warns about. */
export function mergeCount(plan: RenamePlan): number {
    return renameSteps(plan).filter((s) => s.merges).length
}
