/**
 * Where the [[Agent Chat]]'s reader (`documents-reader.ts`) finds a graph's documents and their
 * text, for each backend, read as the [[Formatting Scan]] reads them (`formatting-sources.ts`):
 * from the store's own copy, never through the projection that shows an unlocked Protected
 * Document's plaintext.
 */
import type { FilesystemDocumentStore } from '$lib/storage/fs/filesystem-store'
import type { ServerDocumentStore } from '$lib/storage/server/server-document-store'

import type { AgentReadSource } from './documents-reader'

/**
 * A synced graph. Texts come as the Local Mirror reads them: cache-seeded, checked against the relay,
 * and from the live document where one is open, without starting an editing engine per document.
 * A text the relay could not confirm is still the best this device has, so it is read as it stands.
 */
export function serverReadSource(store: Pick<ServerDocumentStore, 'listIdentities' | 'readTexts'>): AgentReadSource {
    return {
        list: () => store.listIdentities().map(({ concept, kind, aliases }) => ({ concept, kind, aliases })),
        async texts(concepts) {
            const wanted = new Set(concepts)
            // Two documents may share a name after a concurrent create: the first stands for it.
            const identities = new Map<string, string>()
            for (const identity of store.listIdentities()) if (wanted.has(identity.concept) && !identities.has(identity.concept)) identities.set(identity.concept, identity.docId)
            const read = await store.readTexts([...identities.values()])
            const out = new Map<string, string>()
            for (const [concept, docId] of identities) {
                const text = read.get(docId)
                if (text) out.set(concept, text.text)
            }
            return out
        },
    }
}

/** A folder graph, the Demo Graph or a browser-private graph: an open document is read from its buffer. */
export function filesystemReadSource(store: Pick<FilesystemDocumentStore, 'listDocuments' | 'documentText'>): AgentReadSource {
    return {
        list: () => store.listDocuments().map(({ concept, kind, aliases }) => ({ concept, kind, aliases })),
        async texts(concepts) {
            const out = new Map<string, string>()
            for (const concept of concepts) {
                try {
                    const text = await store.documentText(concept)
                    if (text !== null) out.set(concept, text)
                } catch {
                    // An unreadable file is left out, as a document that is not there.
                }
            }
            return out
        },
    }
}
