/**
 * What the tools need from a graph's documents, and nothing else. Two adapters stand behind
 * it: a synced graph (`headless-graph.ts`, the server document store over the sync engine) and a
 * local folder (`headless-folder.ts`, the filesystem store over a directory adapter). The tools
 * are written against this interface alone, chosen once at startup by the `serve` flag, so
 * they carry no branch and their tests run once per backend from one set of assertions
 * ([[2026-09-18 Headless Client Serves A Local Folder]]).
 *
 * The two backends differ in exactly two things, and both live here: how a document's text
 * is made current before a tool trusts it (`refresh` and `whenReady`), and what "the write is
 * done" means (`settle` on the graph, `flush` here).
 */

import type { EditorDocument } from '$lib/document/types'
import type { RenameOptions, RenamePlan, RenameResult } from '$lib/storage/rename'
import { frontmatterSpan } from '$lib/storage/fs/frontmatter-span'

export interface HeadlessDocument {
    /** Case-insensitive identity key (`conceptKey(concept)`). */
    key: string
    /** Display concept name (case-preserving). */
    concept: string
    kind: 'page' | 'journal'
    aliases: string[]
}

export interface HeadlessDocuments {
    /**
     * Bring the view up to date with whatever changed outside this process, before a tool
     * answers. A folder re-lists itself, re-reads changed files and lets the index follow; a
     * synced graph does nothing here, because the relay pushes every change as it happens.
     */
    refresh(): Promise<void>
    /** Every document, journals date-descending then pages alphabetically. */
    listDocuments(): HeadlessDocument[]
    /**
     * Resolves once `concept`'s text can be trusted as its current content: seeded and caught
     * up with the relay on a synced graph, read from disk on a folder. `open()` before this
     * hands back a handle whose text may still be empty.
     */
    whenReady(concept: string): Promise<void>
    /**
     * The document's BODY: its text after any frontmatter block, with edit offsets translated
     * past the block ({@link bodyView}). The same shape on both backends, so a read shows the
     * note and never its identity, an edit cannot reach the block, and the line numbers the
     * index reports (it strips the block too) match the text the agent was given. On a synced
     * graph the store writes no block of its own, but an imported page keeps the one it came
     * with and the store writes identity back into it (ADR 0061), so the view is needed there
     * as much as on a folder ([[2026-09-20 Headless Client Assets Rename And Publishing]]).
     */
    open(concept: string): EditorDocument
    /**
     * The document's whole text, block included - for the frontmatter tools only, which read
     * the block as data and rewrite it as one change. Never handed to a body tool.
     */
    openRaw(concept: string): EditorDocument
    /** Create the journal entry for a `YYYY-MM-DD` day, seeded with `body`. */
    createJournal(date: string, body?: string): Promise<string>
    /** Create a page from a title, seeded with `body`; rejects a case-insensitive collision. */
    createPage(title: string, body?: string): Promise<string>
    setAliases(target: string, aliases: readonly string[]): Promise<void>
    deleteDocument(concept: string): Promise<void>
    /**
     * What a rename would do, before anything is written (ADR 0038). `referencingDocuments` is
     * the count the caller already has from the index, so the store never reads every document
     * to learn it.
     */
    planRename(from: string, to: string, referencingDocuments: number): Promise<RenamePlan>
    /**
     * Apply a rename. Under the rewrite arm `options.referencing` names the documents the index
     * says link to the concept; a synced store brings them current first and refuses with
     * `RenameUnconfirmedError` if one cannot be (ADR 0038, note of 2026-09-20). Durable when this
     * resolves on a folder; on a synced graph, after the next `settle`.
     */
    renamePage(from: string, to: string, options: RenameOptions): Promise<RenameResult>
    /**
     * The body of every document this device can vouch for right now, by concept - a protected
     * document left out, and on a synced graph a document whose text could not be confirmed
     * (it is named in `unconfirmed`). What a whole-graph read wants: the asset references, not
     * a live engine per document.
     */
    readBodies(): Promise<{ bodies: Map<string, string>; unconfirmed: string[] }>
}

/**
 * What `settle()` answers after a write. The message is the backend's own words for a failure,
 * because what "not settled" means differs: the relay has not acknowledged, or the file could
 * not be written.
 */
export type SettleResult = { settled: true } | { settled: false; outstanding: number; message: string }

/** The document's text after its frontmatter block, and where that block ends. */
export function bodyOf(text: string): { head: number; body: string } {
    const head = frontmatterSpan(text)?.end ?? 0
    return { head, body: text.slice(head) }
}

/**
 * A handle over the body alone (see {@link HeadlessDocuments.open}). Offsets an edit gives are
 * body-relative and are translated past the block at the moment of the edit, so a block that
 * grows or shrinks between a read and an edit still lands the edit where the agent meant it.
 */
export function bodyView(handle: EditorDocument): EditorDocument {
    return {
        id: handle.id,
        getText: () => bodyOf(handle.getText()).body,
        applyChange(change, origin) {
            const { head } = bodyOf(handle.getText())
            handle.applyChange({ from: change.from + head, to: change.to + head, insert: change.insert }, origin)
        },
        subscribe: (listener) => handle.subscribe((text) => listener(bodyOf(text).body)),
    }
}
