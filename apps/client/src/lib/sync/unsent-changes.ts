/**
 * Changes a synced graph holds on this device that the server never acknowledged: the documents
 * with rows still in the Local Cache's outbox.
 *
 * Two places need them once they can no longer be sent. An open graph whose membership ended
 * counts them and offers them as a download. Accepting an invite to a graph this browser still
 * holds a copy of must discard that copy, because replaying it would put the old membership's
 * edits into the shared graph as if they were typed today; before it does, the Graphs page asks,
 * names how many documents would be lost, and offers the same download. Forget and Leave on the
 * Graphs page delete the same copy, so they ask the same way, and the workspace's sync chip
 * offers the download while changes are refused or waiting for a connection. One reader and one
 * file format serve them all.
 *
 * The cache rows are plaintext Yjs state, so this needs no keyring and no relay.
 */
import * as Y from 'yjs'
import { sanitizeQuickNotes } from '$lib/document/quick-notes'
import { openGraphCache, type GraphCache } from './local-cache'
import type { RegistryEntry } from './graph-sync'

export interface UnsentDocument {
    docId: string
    /** The document's title or journal day; the root document is named for what it holds. */
    name: string
    /** The document's text as this device holds it; for the root, its quick notes as a list. */
    text: string
}

/** How the root document reads in the count and the download: it holds these, not a page. */
export const ROOT_DOCUMENT_NAME = 'Quick notes and graph settings'

/** The state this device holds for one document: the cache row merged with a live engine's. */
async function heldDoc(cache: GraphCache, docId: string, live?: (docId: string) => Y.Doc | undefined): Promise<Y.Doc> {
    const doc = new Y.Doc()
    const row = await cache.docCache(docId).load()
    if (row) Y.applyUpdate(doc, row.update)
    // A live engine can be ahead of its row by the save debounce: the last few keystrokes.
    const engine = live?.(docId)
    if (engine) Y.applyUpdate(doc, Y.encodeStateAsUpdate(engine))
    return doc
}

/**
 * Every document in `cache` with changes the server has not acknowledged, content documents
 * first in the order the outbox lists them, then the root document if it has any.
 */
export async function readUnsentChanges(
    cache: GraphCache,
    rootDocId: string,
    live?: (docId: string) => Y.Doc | undefined,
): Promise<UnsentDocument[]> {
    const pending = await cache.pendingDocIds()
    if (pending.length === 0) return []
    const root = await heldDoc(cache, rootDocId, live)
    try {
        const registry = root.getMap<RegistryEntry>('registry')
        const documents: UnsentDocument[] = []
        for (const docId of pending) {
            if (docId === rootDocId) continue
            const doc = await heldDoc(cache, docId, live)
            const entry = registry.get(docId)
            documents.push({ docId, name: entry?.title ?? entry?.date ?? docId, text: doc.getText('content').toString() })
            doc.destroy()
        }
        if (pending.includes(rootDocId)) {
            const notes = sanitizeQuickNotes(root.getArray('quickNotes').toArray())
            documents.push({ docId: rootDocId, name: ROOT_DOCUMENT_NAME, text: notes.map((note) => `- ${note.text}`).join('\n') })
        }
        return documents
    } finally {
        root.destroy()
    }
}

/**
 * What an earlier membership left unsent in this browser's copy of `graphId`, read without
 * changing it: a person who decides not to accept the invite keeps everything.
 */
export async function staleCopyUnsentChanges(graphId: string, rootDocId: string): Promise<UnsentDocument[]> {
    const cache = await openGraphCache(graphId)
    try {
        return await readUnsentChanges(cache, rootDocId)
    } finally {
        cache.dispose()
    }
}

export type DiscardOutcome =
    | { kind: 'done' }
    /** Nothing was discarded: the person must see what would be lost and confirm, or cancel and keep it. */
    | { kind: 'confirm'; unsent: UnsentDocument[] }

/**
 * Discard this browser's copy of a graph (Forget, Leave, accepting an invite over a stale copy)
 * only when nothing in it is unsent, or when everything unsent is what the person was shown and
 * agreed to lose (`agreed`, by document id). Otherwise nothing is discarded and the caller asks.
 *
 * The check runs again at the moment of discarding rather than trusting the count the dialog
 * opened with: another tab of this browser can still be typing into the graph.
 */
export async function discardUnlessUnsent(
    graph: { graphId: string; rootDocId: string },
    deps: {
        inspect: (graphId: string, rootDocId: string) => Promise<UnsentDocument[]>
        discard: () => Promise<void>
        agreed?: readonly string[]
    },
): Promise<DiscardOutcome> {
    const unsent = await deps.inspect(graph.graphId, graph.rootDocId)
    const agreed = new Set(deps.agreed ?? [])
    if (unsent.some((document) => !agreed.has(document.docId))) return { kind: 'confirm', unsent }
    await deps.discard()
    return { kind: 'done' }
}

export type InviteAcceptance =
    | { kind: 'accepted' }
    /** Not accepted: the person must see what would be lost and confirm, or cancel and keep it. */
    | { kind: 'confirm'; unsent: UnsentDocument[] }

/**
 * Accept an invite to a graph this browser may already hold a copy of. Accepting discards that
 * copy (`accept` does), so it goes ahead at once only when nothing in it is unsent; otherwise
 * nothing is accepted and nothing is deleted, and the caller asks. Changes left from before a
 * removal and changes made while still a member but not yet acknowledged look the same from
 * here, so neither is ever discarded without the person's say.
 */
export async function acceptUnlessUnsent(
    invite: { graphId: string; rootDocId: string },
    deps: {
        inspect: (graphId: string, rootDocId: string) => Promise<UnsentDocument[]>
        accept: () => Promise<void>
    },
): Promise<InviteAcceptance> {
    const outcome = await discardUnlessUnsent(invite, { inspect: deps.inspect, discard: deps.accept })
    return outcome.kind === 'done' ? { kind: 'accepted' } : outcome
}

/** One Markdown file, a heading per document. */
export function unsentChangesMarkdown(documents: readonly UnsentDocument[]): string {
    return `${documents.map((document) => `# ${document.name}\n\n${document.text}`).join('\n\n')}\n`
}

/** Hand the file to the browser as a download. */
export function saveUnsentChangesFile(documents: readonly UnsentDocument[], graphName: string): void {
    const url = URL.createObjectURL(new Blob([unsentChangesMarkdown(documents)], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${graphName} unsent changes.md`
    link.click()
    // Long enough for the browser to start the download; the URL holds the text in memory.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
