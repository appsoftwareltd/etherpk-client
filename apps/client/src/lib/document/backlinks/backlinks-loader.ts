/**
 * What a view showing one concept's [[Backlink]]s knows, and when it asks the graph index again.
 * Both places Backlinks are shown read it: the Backlinks panel in the right [[Sidebar]] and the
 * section beneath every document (ADR 0135), so the two cannot drift apart in what they say while
 * an answer is on its way, which answers they keep, or which references they leave out.
 *
 * Framework free so it is Node tested; a Svelte view holds the state it reports in `$state.raw`.
 *
 * - **Whose answer.** An answer is shown only under its own concept's name. While another
 *   concept's answer is on its way the state is `loading`, never the previous concept's
 *   references under the new name. A refresh of the same concept keeps its answer meanwhile, so
 *   an edit never blanks the list. An answer that arrives after another concept was asked for is
 *   dropped (the index is a worker round trip, ADR 0041, and the user can move faster than it).
 * - **Failure.** A first fetch that fails is `failed` until `retry`; a refresh that fails keeps
 *   the answer it has.
 * - **Off screen** (`setOnScreen(false)`) nothing is fetched. A change of concept or an update
 *   about it meanwhile is remembered, and asked for once when the view comes back.
 * - **Updates.** Only an update naming the concept, by its name or any alias, is fetched again
 *   ({@link updateNamesConcept}). An answer equal to the one held is not reported, because the
 *   section sits under the text being typed and every edit there is an update about it.
 * - **Self references.** A group whose source is the concept's own page is left out: a document
 *   is never its own backlink. The index keeps those links, because a [[Rename]] rewrites them.
 */

import type { ConceptCandidate, DbBacklinkGroup } from '../index-db'
import type { IndexUpdate } from '../index-worker/client'
import { conceptKey } from './backlink-index'
import { shownBacklinkGroups } from './shown-backlinks'

/** The part of the graph index (`RemoteGraphIndex`) the loader reads. */
export interface BacklinksIndex {
    backlinks(concept: string): Promise<DbBacklinkGroup[]>
    onUpdated(listener: (update: IndexUpdate) => void): () => void
    candidate(name: string): ConceptCandidate | undefined
}

/** Looks a name up in the index's pushed snapshot (`RemoteGraphIndex.candidate`). */
export type CandidateLookup = (name: string) => ConceptCandidate | undefined

export type BacklinksStatus = 'idle' | 'loading' | 'ready' | 'failed'

export interface BacklinksState {
    /** The concept whose backlinks are wanted, or null when there is none. */
    concept: string | null
    /** `idle` with no concept or no index; `ready` only while the answer held is this concept's. */
    status: BacklinksStatus
    /** The concept's groups, without its own page's; empty unless `ready`. */
    groups: DbBacklinkGroup[]
    /** How many references the groups hold. */
    count: number
}

export interface BacklinksLoader {
    state(): BacklinksState
    /** Show `concept`'s backlinks, or none. Showing the concept already shown changes nothing. */
    show(concept: string | null): void
    /** Whether the view is on screen; coming back asks for whatever it missed while away. */
    setOnScreen(onScreen: boolean): void
    /** Ask again after a failure. */
    retry(): void
    /** Stop listening to the index; answers still on their way are dropped. */
    destroy(): void
}

export interface BacklinksLoaderOptions {
    /** The graph's index, or null outside a graph (the `/dev` harnesses), which leaves the loader idle. */
    index: BacklinksIndex | null
    /** Hears every state the view should draw. */
    onChange(state: BacklinksState): void
    /** Whether the view starts on screen; true when the presenter says nothing. */
    onScreen?: boolean
}

/** One empty list, so a state with no groups compares equal to the last one. */
const NO_GROUPS: DbBacklinkGroup[] = []

export function createBacklinksLoader({ index, onChange, onScreen: startsOnScreen = true }: BacklinksLoaderOptions): BacklinksLoader {
    let concept: string | null = null
    let onScreen = startsOnScreen
    /** The last answer, the self group already left out, and whose it is. */
    let answer: { concept: string; groups: DbBacklinkGroup[]; json: string } | null = null
    /** The concept whose last fetch failed while it had no answer to show instead. */
    let failedFor: string | null = null
    /** The concept the newest fetch is for; an answer for any other is dropped. */
    let wanted: string | null = null
    /** Something was missed while off screen: a new concept, or an update about it. */
    let stale = false
    let destroyed = false
    let state = compute()

    const stopListening = index?.onUpdated((update) => {
        if (concept === null || !updateNamesConcept(update, concept, index.candidate)) return
        if (onScreen) fetch()
        else stale = true
    })

    function compute(): BacklinksState {
        if (!index || concept === null) return { concept, status: 'idle', groups: NO_GROUPS, count: 0 }
        if (answer?.concept === concept) {
            const count = answer.groups.reduce((n, group) => n + group.refs.length, 0)
            return { concept, status: 'ready', groups: answer.groups, count }
        }
        return { concept, status: failedFor === concept ? 'failed' : 'loading', groups: NO_GROUPS, count: 0 }
    }

    /** Recompute, and tell the view when anything it draws changed. */
    function report(): void {
        if (destroyed) return
        const next = compute()
        if (next.concept === state.concept && next.status === state.status && next.groups === state.groups) return
        state = next
        onChange(state)
    }

    function fetch(): void {
        stale = false
        const target = concept
        wanted = target
        if (!index || target === null) return
        index.backlinks(target).then(
            (groups) => {
                if (destroyed || wanted !== target) return
                const kept = shownBacklinkGroups(groups)
                const json = JSON.stringify(kept)
                // The same answer again keeps the arrays the view already drew from.
                if (answer?.concept !== target || answer.json !== json) answer = { concept: target, groups: kept, json }
                failedFor = null
                report()
            },
            () => {
                // A failed refresh leaves an answer already on screen where it is; a first fetch
                // has nothing to fall back on, so the view says it failed and offers another try.
                if (destroyed || wanted !== target) return
                failedFor = target
                report()
            },
        )
    }

    return {
        state: () => state,
        show(next) {
            if (next === concept) return
            concept = next
            if (onScreen) fetch()
            else stale = true
            report()
        },
        setOnScreen(next) {
            onScreen = next
            if (onScreen && stale) fetch()
        },
        retry() {
            failedFor = null
            fetch()
            report()
        },
        destroy() {
            destroyed = true
            wanted = null
            stopListening?.()
        },
    }
}

/**
 * The key of the page a name resolves to: an alias's canonical page, otherwise the name itself
 * (a page, a journal day, or a [[Pageless Concept]]). Case-insensitive, as concept identity is.
 */
function pageKey(name: string, candidate: CandidateLookup | undefined): string {
    const row = candidate?.(name)
    return conceptKey(row?.kind === 'alias' && row.canonical ? row.canonical : name)
}

/**
 * Whether an index update can have changed `concept`'s backlinks: a full update, or one naming
 * the concept by any of its names. `backlinkTargetsChanged` holds the names a changed document
 * links to; `changedConceptKeys` adds the changed documents themselves and their aliases, which
 * is how a page gaining or losing an alias reaches its own backlinks.
 */
export function updateNamesConcept(update: IndexUpdate, concept: string, candidate: CandidateLookup | undefined): boolean {
    if (update.full) return true
    const target = pageKey(concept, candidate)
    for (const names of [update.backlinkTargetsChanged, update.changedConceptKeys]) {
        for (const name of names) if (pageKey(name, candidate) === target) return true
    }
    return false
}

/**
 * Whether a link in a quoted line names `concept`'s page, by its name or by one of its aliases:
 * what a quote emphasises, and what Highlight leaves in full colour. Without an index, by name.
 */
export function linksToConcept(concept: string, candidate: CandidateLookup | undefined): (link: string) => boolean {
    const target = pageKey(concept, candidate)
    return (link) => pageKey(link, candidate) === target
}
