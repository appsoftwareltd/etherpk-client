/**
 * An in-memory {@link DocumentStore}. Holds each document's text in a Map; the
 * dev harness and unit tests use it as a stand-in for a real Storage Backend.
 *
 * The split that matters (and that real backends must preserve): a local
 * {@link EditorDocument.applyChange} mutates the text *without* notifying
 * subscribers (the editor that made the edit already has it), while
 * {@link InMemoryDocumentStore.setText} simulates an EXTERNAL change and DOES
 * notify, so the editor reflects it. This is exactly where a git reload or a
 * Yjs remote update will hook in later.
 */

import type { DocumentStore, EditorDocument, TextChange } from './types'

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
    const texts = new Map<string, string>(Object.entries(seed))
    const listeners = new Map<string, Set<(text: string) => void>>()
    const docs = new Map<string, EditorDocument>()

    function notify(target: string): void {
        const text = texts.get(target) ?? ''
        for (const listener of listeners.get(target) ?? []) listener(text)
    }

    function makeDoc(target: string): EditorDocument {
        return {
            id: target,
            getText: () => texts.get(target) ?? '',
            applyChange(change) {
                texts.set(target, applyTextChange(texts.get(target) ?? '', change))
                // No notify: the originating editor already reflects this edit.
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
            texts.set(target, text)
            notify(target)
        },
    }
}
