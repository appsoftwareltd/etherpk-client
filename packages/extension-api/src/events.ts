/**
 * The Events an extension may listen to. An Event reports something that happened in the Client.
 * A listener reacts to it but cannot change it, and a listener that throws harms nothing else.
 */

/**
 * Each Event's name and what it carries. Every Event belongs to the open graph, named by
 * `graphId`.
 *
 * @beta
 */
export interface ExtensionEventPayloads {
    /** The document the user is working in changed, or there is none (`documentId` is null). */
    'document:active-changed': { graphId: string; documentId: string | null }
    /**
     * A concept was renamed: its page, when it has one, and every wikilink naming it. The Client's
     * own tabs, and the extension's Views about a concept, follow by themselves; this is for state
     * an extension keeps under the old name, and it is reported before those Views move.
     *
     * A rename that moves concepts scoped by the renamed one reports each concept it moved, once,
     * under the exact name it now lives on as: the scoped concepts first and the renamed concept
     * last. A listener that moves what it keeps by exact name, Event by Event, moves each thing
     * once, even when the new name is one the old name scopes (`Acme` to `[[Acme]] Archive`).
     */
    'concept:renamed': { graphId: string; from: string; to: string }
    /** A document was deleted. */
    'document:deleted': { graphId: string; documentId: string }
    /** The set of documents changed: one was added, removed or renamed. */
    'documents:changed': { graphId: string }
    /** The light or dark theme was switched on. */
    'theme:changed': { graphId: string; dark: boolean }
}

/**
 * An Event's name.
 *
 * @beta
 */
export type ExtensionEventName = keyof ExtensionEventPayloads

/**
 * Listening to Events.
 *
 * @beta
 */
export interface ExtensionEvents {
    /** Listen to one Event until the returned function is called or the extension stops. */
    on<K extends ExtensionEventName>(name: K, listener: (payload: ExtensionEventPayloads[K]) => void): () => void
}
