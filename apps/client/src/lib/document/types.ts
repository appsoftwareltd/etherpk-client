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

/**
 * A synced document this device could not bring current in time, so a write that has to see its
 * whole text was refused rather than made blind: a block added to text that has not arrived would
 * sit above the document's own block once it does.
 */
export class DocumentUnconfirmedError extends Error {
    constructor(readonly target: string) {
        super(`"${target}" has not finished syncing to this device. Nothing was changed - try again once sync has caught up.`)
        this.name = 'DocumentUnconfirmedError'
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
 * What a compare-and-set write did (a [[Formatting Scan]]'s fix, ADR 0109): `written`; `changed`,
 * the document no longer held the text the write expected, so nothing was written; `gone`, no
 * document by that key; `unconfirmed`, a synced document this device could not bring current;
 * `protected`, it holds a Protected Document's cipher fence, which no fix may touch.
 */
export type SpliceOutcome = 'written' | 'changed' | 'gone' | 'unconfirmed' | 'protected'

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
 *
 * One document can have two editors (a document tab and a [[Kanban Board]]'s [[Task Detail]],
 * ADR 0113). An `editor` edit then names the subscriber it came from, and every other subscriber
 * hears it, for the reason an `external` edit is heard; the editor that made it still does not.
 */
export type ChangeOrigin = 'editor' | 'external'

/** Hears a document's text after an edit that it did not make. */
export type DocumentListener = (text: string) => void

/**
 * A live handle to one document's text. The editor reads {@link getText} once to
 * seed itself, pushes local edits via {@link applyChange}, and is pushed *external*
 * changes (git reload, a remote CRDT update) via {@link subscribe}.
 */
export interface EditorDocument {
    readonly id: string
    getText(): string
    /**
     * Apply an edit. Defaults to `editor` origin — see {@link ChangeOrigin}. An editor passes
     * the listener it subscribed with as `editor`, so the document's other editors hear the
     * edit and it does not; an `editor` edit that names no subscriber is heard by none.
     *
     * Two callers name none. A [[Draft]]'s promotion writes what was typed into the page it
     * creates or adopts (draft.ts), so another editor already open on an adopted page does not
     * hear it. And the Headless Client's body view (apps/mcp, headless-documents.ts) wraps each
     * listener and does not pass `editor` on, so telling editors apart by their listener does not
     * work through it; it has one editor per document.
     */
    applyChange(change: TextChange, origin?: ChangeOrigin, editor?: DocumentListener): void
    /**
     * Observe changes that did NOT originate from this editor's own
     * {@link applyChange} call — external and remote edits, and another editor's — which the
     * editor must reflect. Returns an unsubscribe function.
     */
    subscribe(listener: DocumentListener): () => void
}

/** Opens documents by id. One store backs one knowledge graph. */
export interface DocumentStore {
    open(target: string): EditorDocument
    /**
     * Resolves when the document's backing content has actually loaded (e.g. a Server
     * Backend's cache seed). Absent on stores whose `open` returns real text synchronously;
     * the editor shows a loading state only while this is pending.
     *
     * It settles only after an editor already subscribed has heard the loaded text. A View counts
     * a change it hears before this settles as the content it opened to show, and places a held
     * reveal on it (held-reveal.ts); a store that settled first would land every reveal into a
     * document it just opened on the first line.
     */
    whenReady?(target: string): Promise<void>
}
