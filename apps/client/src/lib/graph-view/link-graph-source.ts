/**
 * One reading of the index's {@link LinkGraph} for every [[Graph View]] copy of an open graph.
 *
 * The local copy in the Sidebar and the whole graph in the editor area draw from the same link
 * graph. Read separately, every edit that changed a line cost each copy on screen its own round
 * trip to the index worker, its own copy of the answer and its own model build (about 70 ms on
 * a graph of 5,000 concepts). The source asks once and builds once. A copy that reads while
 * nothing has changed since the last answer is given that answer, and a copy that reads while
 * the other's request is still out waits for the same request.
 *
 * It can only say "nothing has changed" while it hears the index's updates, so it listens for
 * as long as some copy listens to it, and trusts nothing it read before it started listening.
 * Once no copy listens it lets go of the last answer and its model, so a graph with no Graph View
 * open holds nothing.
 */
import type { LinkGraph } from '$lib/document/index-link-graph'
import type { ExtensionContext, ExtensionIndex } from '$lib/surface/extension-context'

import { createGraphModel, type GraphModel, sameLinkGraph } from './model/graph-model'

/** One answer from the index and the model built from it. Shared by the copies, so never changed. */
export interface LinkGraphSnapshot {
    readonly graph: LinkGraph
    readonly model: GraphModel
}

export class LinkGraphSource {
    /** Goes up with each index update that touched a concept or a line, and when listening stops. */
    #version = 0
    #latest: { version: number; snapshot: LinkGraphSnapshot } | null = null
    #inFlight: { version: number; answer: Promise<LinkGraphSnapshot> } | null = null
    readonly #listeners = new Set<() => void>()
    #stopListening: (() => void) | null = null
    readonly #index: Pick<ExtensionIndex, 'linkGraph' | 'onUpdated'>

    constructor(index: Pick<ExtensionIndex, 'linkGraph' | 'onUpdated'>) {
        this.#index = index
    }

    /**
     * Hear when the link graph may have changed: an update that touched a concept or a
     * document's wikilinks. An edit to plain text changes no line, so it is not reported.
     * Returns the unsubscribe.
     */
    onStale(listener: () => void): () => void {
        this.#listeners.add(listener)
        if (!this.#stopListening) {
            // Nothing read before now was checked against the index's updates, so none of it is
            // trusted, and a request already out is not shared.
            this.#version++
            this.#stopListening = this.#index.onUpdated((update) => {
                if (!update.full && update.changedConceptKeys.size === 0 && update.backlinkTargetsChanged.size === 0) return
                this.#version++
                for (const each of [...this.#listeners]) each()
            })
        }
        return () => {
            this.#listeners.delete(listener)
            if (this.#listeners.size > 0 || !this.#stopListening) return
            this.#stopListening()
            this.#stopListening = null
            // No copy is left to show the model, so it is let go rather than kept for as long as
            // the graph is open.
            this.#latest = null
        }
    }

    /** The link graph as it is now. Asks the index only when no answer is known to be current. */
    read(): Promise<LinkGraphSnapshot> {
        const listening = this.#stopListening !== null
        if (listening && this.#latest?.version === this.#version) return Promise.resolve(this.#latest.snapshot)
        // A request sent before the latest update may be answered from before it, so only a
        // request sent since then is shared.
        if (listening && this.#inFlight?.version === this.#version) return this.#inFlight.answer
        const version = this.#version
        const answer = this.#index.linkGraph().then((graph) => this.#settle(version, graph))
        const inFlight = { version, answer }
        this.#inFlight = inFlight
        // Answered or failed, the request is no longer one to wait on. A failure reaches every
        // caller through `answer`, so this branch handles it rather than reporting it unhandled.
        const finished = () => {
            if (this.#inFlight === inFlight) this.#inFlight = null
        }
        answer.then(finished, finished)
        return answer
    }

    #settle(version: number, graph: LinkGraph): LinkGraphSnapshot {
        const latest = this.#latest
        // Most edits that touch a wikilink leave the lines as they were (a link typed and deleted,
        // a second mention of a concept already linked): keep the same snapshot, so no copy redraws.
        const snapshot = latest && sameLinkGraph(latest.snapshot.graph, graph) ? latest.snapshot : { graph, model: createGraphModel(graph) }
        // Kept only while a copy listens: nothing else would ever be handed it. The index answers in
        // the order it was asked, but an older answer must never replace a newer one.
        if (this.#stopListening && (!latest || version >= latest.version)) this.#latest = { version, snapshot }
        return snapshot
    }
}

const sources = new WeakMap<ExtensionContext, LinkGraphSource>()

/** The source every Graph View copy of the graph `context` belongs to reads from. */
export function linkGraphSource(context: ExtensionContext): LinkGraphSource {
    let source = sources.get(context)
    if (!source) {
        source = new LinkGraphSource(context.index)
        sources.set(context, source)
    }
    return source
}
