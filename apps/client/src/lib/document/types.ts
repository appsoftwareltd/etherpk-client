/**
 * The backend-agnostic document seam.
 *
 * The editor binds to an {@link EditorDocument}; the backend owns the text —
 * CodeMirror is never the source of truth (see ADR 0010). The Local engine will
 * implement {@link DocumentStore} over a file buffer, the Server engine over a
 * Yjs Y.Text; the harness uses an in-memory store. All three look identical here.
 */

import type { ViewRef } from '$lib/layout'

export class DocumentNotFoundError extends Error {
    constructor(readonly target: string) {
        super(`No document for "${target}"`)
        this.name = 'DocumentNotFoundError'
    }
}

export class DocumentSyncDegradedError extends Error {
    constructor(
        readonly target: string,
        readonly status:
            | 'key-unavailable'
            | 'ciphertext-corrupt'
            | 'generation-stale'
            | 'sequence-gap',
    ) {
        super(`Document "${target}" is sync-degraded: ${status}`)
        this.name = 'DocumentSyncDegradedError'
    }
}

/** A {@link ViewRef} narrowed to documents — `kind` is always `'document'`. */
export interface DocumentRef extends ViewRef {
    kind: 'document'
    /** The document's stable id (its concept name / file id). */
    target: string
}

/** A single text edit, expressed as a range replacement (CodeMirror-shaped). */
export interface TextChange {
    /** UTF-16 offset where the replacement starts. */
    from: number
    /** UTF-16 offset where the replacement ends (`from` for a pure insert). */
    to: number
    /** Replacement text (`''` for a pure delete). */
    insert: string
}

/**
 * Who made an edit — which decides whether the document's subscribers hear about it.
 *
 * `editor` is the default and the historical behaviour: the editor that called
 * {@link EditorDocument.applyChange} already shows the edit, so echoing it back would be a
 * pointless round trip (and, for CodeMirror, a fight with its own transaction).
 *
 * `external` is an edit made by anything that is NOT the editor — the [[Tasks View]] ticking a
 * checkbox, for one. Those MUST notify, or an open editor keeps rendering text the buffer no
 * longer holds, and its next keystroke applies an offset against a document it disagrees with.
 */
export type ChangeOrigin = 'editor' | 'external'

/**
 * A live handle to one document's text. The editor reads {@link getText} once to
 * seed itself, pushes local edits via {@link applyChange}, and is pushed *external*
 * changes (git reload, a remote CRDT update) via {@link subscribe}.
 */
export interface EditorDocument {
    readonly id: string
    getText(): string
    /** Apply an edit. Defaults to `editor` origin — see {@link ChangeOrigin}. */
    applyChange(change: TextChange, origin?: ChangeOrigin): void
    /**
     * Observe changes that did NOT originate from this editor's own
     * {@link applyChange} call — i.e. external/remote edits the editor must
     * reflect. Returns an unsubscribe function.
     */
    subscribe(listener: (text: string) => void): () => void
}

/** Opens documents by id. One store backs one knowledge graph. */
export interface DocumentStore {
    open(target: string): EditorDocument
    /**
     * Resolves when the document's backing content has actually loaded (e.g. a Server
     * Backend's cache seed). Absent on stores whose `open` returns real text synchronously;
     * the editor shows a loading state only while this is pending.
     */
    whenReady?(target: string): Promise<void>
}
