/**
 * How the open workspace answers the in-document delete's question about [[Protected Document]]s
 * (ADR 0054): which documents to read, how to read their stored text without opening them,
 * and what to settle first. The policy itself is `protectedAssetUsage` (document/asset-delete.ts);
 * this is the wiring, kept out of the component so it can be tested.
 *
 * Stored text is read the way the Local Mirror reads it, never through `open()`: an open handle on
 * a synced graph starts a live engine, and on a folder graph a buffer, for a document nobody is
 * looking at. A synced read the relay could not confirm current, and a file that could not be
 * read, come back as null, which the policy counts as unread.
 */
import { type ProtectedAssetUsage, protectedAssetUsage } from '$lib/document/asset-delete'
import type { ConceptCandidate } from '$lib/document/index-db'
import type { DirectoryAdapter } from '$lib/storage/fs/directory-adapter'
import { type DocumentEntry, conceptKey } from '$lib/storage'
import type { DocumentIdentity, DocumentText } from '$lib/storage/server/server-document-store'

/** A batch of concepts to their stored text, or null for any that could not be read. */
export type StoredTextReader = (concepts: readonly string[]) => Promise<Map<string, string | null>>

/**
 * Stored text on a synced graph: cache-seeded reads checked against the relay's watermarks. A name
 * that two documents answer to (a concurrent create's duplicate) is unread: which of the two the
 * index flagged as protected is unknown, and reading the other would find nothing.
 */
export function serverStoredTexts(store: {
    listIdentities(): DocumentIdentity[]
    readTexts(docIds: readonly string[]): Promise<Map<string, DocumentText>>
}): StoredTextReader {
    return async (concepts) => {
        const byKey = new Map<string, string[]>()
        for (const identity of store.listIdentities()) {
            const k = conceptKey(identity.concept)
            byKey.set(k, [...(byKey.get(k) ?? []), identity.docId])
        }
        const only = (concept: string) => {
            const ids = byKey.get(conceptKey(concept)) ?? []
            return ids.length === 1 ? ids[0] : undefined
        }
        const wanted = concepts.map((concept) => [concept, only(concept)] as const)
        const texts = await store.readTexts(wanted.flatMap(([, docId]) => (docId ? [docId] : [])))
        const out = new Map<string, string | null>()
        for (const [concept, docId] of wanted) {
            const read = docId ? texts.get(docId) : undefined
            out.set(concept, read && read.settled ? read.text : null)
        }
        return out
    }
}

/**
 * Stored text on a folder graph: the files themselves, after the buffers have been flushed. A
 * name two files answer to is unread, for the same reason as on a synced graph.
 */
export function filesystemStoredTexts(store: { listDocuments(): DocumentEntry[] }, adapter: Pick<DirectoryAdapter, 'read'>): StoredTextReader {
    return async (concepts) => {
        const byKey = new Map<string, DocumentEntry[]>()
        for (const entry of store.listDocuments()) byKey.set(entry.key, [...(byKey.get(entry.key) ?? []), entry])
        const out = new Map<string, string | null>()
        for (const concept of concepts) {
            const entries = byKey.get(conceptKey(concept)) ?? []
            const entry = entries.length === 1 ? entries[0] : undefined
            out.set(concept, entry ? await adapter.read(entry.subdir, entry.fileName).then((file) => file.text, () => null) : null)
        }
        return out
    }
}

export interface ProtectedUsageDeps {
    /** The index's concepts; a page or journal flagged `protected` is read. */
    concepts(): readonly ConceptCandidate[]
    readStored: StoredTextReader
    readProtected(text: string): Promise<string | null>
    /** Commits pending protected projections and writes dirty buffers before anything is read. */
    settle(): Promise<void>
}

/** The `protectedUsage` the asset Commands are given (commands/asset-commands.ts). */
export function protectedUsageReader(deps: ProtectedUsageDeps): (needles: readonly string[]) => Promise<ProtectedAssetUsage> {
    return (needles) => {
        const documents = deps
            .concepts()
            .filter((c) => c.protected && (c.kind === 'page' || c.kind === 'journal'))
            .map((c) => ({ concept: c.display, kind: c.kind as 'page' | 'journal' }))
        return protectedAssetUsage(documents, needles, { settle: deps.settle, readStored: deps.readStored, readProtected: deps.readProtected })
    }
}
