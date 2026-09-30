/**
 * The [[Formatting Scan]]'s source per backend (ADR 0109): which documents to check, how to read
 * each one's whole text, and the compare-and-set write that fixes it. The scan itself is
 * `document/formatting/scan.ts`; this is the wiring, kept out of the component so it can be tested.
 */
import { createBreather } from '$lib/activity/breathe'
import type { DocumentRead, FormattingSource, ScanDocument } from '$lib/document/formatting/scan'
import type { FilesystemDocumentStore } from '$lib/storage/fs/filesystem-store'
import type { ServerDocumentStore } from '$lib/storage/server/server-document-store'

/** Journals newest first, then pages by name: the order the graph's lists use. */
function inListOrder(documents: ScanDocument[]): ScanDocument[] {
    const journals = documents.filter((d) => d.kind === 'journal').sort((a, b) => b.concept.localeCompare(a.concept))
    const pages = documents.filter((d) => d.kind === 'page').sort((a, b) => a.concept.localeCompare(b.concept))
    return [...journals, ...pages]
}

/**
 * A synced graph: documents by docId, so two that share a name after a concurrent create are both
 * checked, and a rename after the scan still fixes the right one. Texts are read as the Local
 * Mirror reads them, cache-seeded and checked against the relay; one the relay could not confirm
 * current is not checked, since its fix would be computed against text that may be behind.
 */
export function serverFormattingSource(store: Pick<ServerDocumentStore, 'listIdentities' | 'readTexts' | 'spliceIfUnchanged'>): FormattingSource {
    return {
        // One watermark request per call, so larger than a folder's: 200 documents is a few seconds at most.
        chunkSize: 200,
        async list() {
            return inListOrder(store.listIdentities().map(({ docId, concept, kind }) => ({ key: docId, concept, kind })))
        },
        async read(keys) {
            const known = new Set(store.listIdentities().map((identity) => identity.docId))
            const texts = await store.readTexts(keys.filter((key) => known.has(key)))
            const out = new Map<string, DocumentRead>()
            for (const key of keys) {
                const read = texts.get(key)
                if (!known.has(key) || !read) out.set(key, { kind: 'gone' })
                else out.set(key, read.settled ? { kind: 'text', text: read.text } : { kind: 'unread', reason: 'syncing' })
            }
            return out
        },
        write: (key, expected, splices) => store.spliceIfUnchanged(key, expected, splices),
    }
}

/**
 * A folder graph, the Demo Graph, or a browser-private graph: documents by name. The folder is
 * followed before the listing, so files added, removed or edited outside the app since it was last
 * looked at are checked as they are. An open document is read from its buffer, which is what its
 * fix goes through (`documentText`).
 */
export function filesystemFormattingSource(store: Pick<FilesystemDocumentStore, 'reconcile' | 'listDocuments' | 'documentText' | 'spliceIfUnchanged'>): FormattingSource {
    const breathe = createBreather()
    return {
        chunkSize: 25,
        async list() {
            await store.reconcile()
            return store.listDocuments().map((entry) => ({ key: entry.concept, concept: entry.concept, kind: entry.kind }))
        },
        async read(keys, signal) {
            const out = new Map<string, DocumentRead>()
            for (const key of keys) {
                // Yields a frame now and then, and is where Cancel is heard.
                await breathe(signal)
                let text: string | null
                try {
                    text = await store.documentText(key)
                } catch {
                    out.set(key, { kind: 'unread', reason: 'unreadable' })
                    continue
                }
                out.set(key, text === null ? { kind: 'gone' } : { kind: 'text', text })
            }
            return out
        },
        write: (key, expected, splices) => store.spliceIfUnchanged(key, expected, splices),
    }
}
