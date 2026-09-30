/**
 * An in-memory {@link DocumentStore}. Holds each document's text in a Map; the
 * dev harness and unit tests use it as a stand-in for a real Storage Backend.
 *
 * The split that matters (and that real backends must preserve): a local
 * {@link EditorDocument.applyChange} mutates the text *without* notifying
 * the editor that made it (it already has the edit), while an `external` change, and
 * {@link InMemoryDocumentStore.setText}, which simulates one, notify every subscriber, so
 * the editor reflects it. An editor's edit reaches the document's other editors. This is
 * exactly where a git reload or a Yjs remote update will hook in later.
 */

import { lineFeedsOnly } from './line-endings'
import type { DocumentListener, DocumentStore, EditorDocument, TextChange } from './types'

export interface InMemoryDocumentStore extends DocumentStore {
    /** Simulate an external change (git reload, remote update). Notifies subscribers. */
    setText(target: string, text: string): void
}

function applyTextChange(text: string, change: TextChange): string {
    return text.slice(0, change.from) + change.insert + text.slice(change.to)
}

export function createInMemoryDocumentStore(
    seed: Record<string, string> = {},
): InMemoryDocumentStore {
    // Line feeds only, as every editor buffer holds (ADR 0112).
    const texts = new Map<string, string>(Object.entries(seed).map(([target, text]) => [target, lineFeedsOnly(text)]))
    const listeners = new Map<string, Set<(text: string) => void>>()
    const docs = new Map<string, EditorDocument>()

    /** Tell the document's subscribers its text, all but `except` (the editor that made the edit). */
    function notify(target: string, except?: DocumentListener): void {
        const text = texts.get(target) ?? ''
        for (const listener of listeners.get(target) ?? []) if (listener !== except) listener(text)
    }

    function makeDoc(target: string): EditorDocument {
        return {
            id: target,
            getText: () => texts.get(target) ?? '',
            applyChange(change, origin = 'editor', editor) {
                texts.set(target, applyTextChange(texts.get(target) ?? '', change))
                // The originating editor already reflects this edit; any other editor must hear it.
                if (origin === 'external') notify(target)
                else if (editor) notify(target, editor)
            },
            subscribe(listener) {
                let set = listeners.get(target)
                if (!set) listeners.set(target, (set = new Set()))
                set.add(listener)
                return () => set!.delete(listener)
            },
        }
    }

    return {
        open(target) {
            let doc = docs.get(target)
            if (!doc) {
                if (!texts.has(target)) texts.set(target, '')
                docs.set(target, (doc = makeDoc(target)))
            }
            return doc
        },
        setText(target, text) {
            texts.set(target, lineFeedsOnly(text))
            notify(target)
        },
    }
}
