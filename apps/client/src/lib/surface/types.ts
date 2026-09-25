/**
 * The extension **surface** — the one shared mechanism set that first-party
 * features and (later) third-party Extensions build on. Phase 1 ships the
 * **Event bus**; the Command and Contribution registries follow in step 4 once
 * they have a genuine first consumer.
 *
 * An **Event** is an observe-only notification (CONTEXT.md): a listener reacts
 * but cannot alter the outcome, and a throwing listener can never corrupt the
 * producer (that is what keeps an Event distinct from a Hook). The catalogue is
 * designed from the domain model up front but emitted lazily — only events with a
 * live consumer are emitted, so nothing fires into the void.
 */

/**
 * The typed event catalogue: event name → the payload a listener receives.
 *
 * Graph-specific events carry their originating `graphId`
 * (docs/adr/0014-surface-is-app-global-but-graph-scoped-delivery-is-mandatory.md);
 * the bus injects it, so emitters never supply it. Only the events with a live
 * consumer today are listed — the rest of the catalogue lives in
 * Extension Architecture.md and joins here when it is first emitted.
 */
export interface EventPayloads {
    /** The document the user is working in changed. Consumer: the Backlinks View. */
    'document:active-changed': { graphId: string; documentId: string | null }
    /**
     * A document's protection changed (protected, unprotected, or a block protected within it).
     * Consumer: the Document View, which must REMOUNT rather than merely redraw — protection
     * decides whether a document can be collab-bound at all, and that is fixed at mount.
     */
    'document:protection-changed': { graphId: string; documentId: string }
    /**
     * The graph's lock state changed — the key was taken into memory or discarded. Graph-wide, not
     * per document: the key is the unit (ADR 0058). Consumers: the Document View (a collab-bound
     * editor holding protected content remounts, because it can never show a projection) and the
     * sidebar's lock control.
     */
    'protection:changed': { graphId: string }
    /** The set of documents in the graph changed (create / delete). Consumer: the document tree. */
    'documents:changed': { graphId: string }
    /**
     * The user asked for the [[Quick Notes View]]'s box (the `quickNotes.open` Command, Alt+N).
     * The workspace has already focused the tab and expanded the Sidebar; the View puts the
     * caret in its textarea. An Event because the View is mounted through the layout renderer
     * and nothing else holds a reference to it.
     */
    'quick-notes:focus': { graphId: string }
    /**
     * The [[Search]] modal was closed by the user: \`opened\` when they opened a result,
     * \`dismissed\` for Escape or a click on the backdrop. Consumer: [[Quick Find]], which empties
     * itself when a Search it handed its text to ends in a result, as it does after opening one
     * of its own rows.
     */
    'search:closed': { graphId: string; outcome: 'opened' | 'dismissed' }
}

export type EventName = keyof EventPayloads

/**
 * The Event bus. `emit` is graph-scoped: the bus is created for one graph and
 * injects its `graphId` into every payload, so callers pass everything *except*
 * `graphId`. Dispatch is synchronous, in registration order, and error-isolated.
 */
export interface EventBus {
    /** Notify every listener of `name`. The bus adds `graphId`; pass the rest. */
    emit<K extends EventName>(name: K, payload: Omit<EventPayloads[K], 'graphId'>): void
    /** Subscribe to `name`; returns a dispose fn that removes exactly this listener. */
    on<K extends EventName>(name: K, listener: (payload: EventPayloads[K]) => void): () => void
}
