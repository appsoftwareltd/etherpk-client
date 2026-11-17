/**
 * Watch the documents a view of tasks across documents shows (the [[Kanban Board]], the [[Tasks
 * View]]), so edits made elsewhere reach it while it is open. A tab subscribes to relay updates only
 * for the documents it shows, and these views show tasks from documents no tab has open: a move made
 * on a phone, in another window or by an agent would otherwise wait for a reload. An edit heard is a
 * change event of the store, which the index takes in, and its update reads the view again.
 *
 * A store without `watchDocuments` (a folder graph, whose files are the one copy) is not asked.
 * The set is replaced as the view reads again; the new one is watched before the old is let go, so a
 * document in both is never unsubscribed in between.
 */
import type { DocumentStore } from './types'

/** At most this many documents a view watches: well inside the relay's limit on one connection's subscriptions. */
export const WATCHED_DOCUMENTS_LIMIT = 1000

export interface DocumentWatch {
    /** Watch these documents, in place of the last set. Names compared without case; at most the limit. */
    watch(documents: readonly string[]): void
    /** Stop watching. */
    dispose(): void
}

export function createDocumentWatch(store: () => DocumentStore | null | undefined, limit = WATCHED_DOCUMENTS_LIMIT): DocumentWatch {
    let release: (() => void) | undefined
    let watched = ''
    return {
        watch(documents) {
            const at = store()
            if (!at?.watchDocuments) return
            const names = new Map<string, string>()
            for (const name of documents) if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name)
            const sorted = [...names.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, limit).map(([, name]) => name)
            const key = sorted.join('\n')
            if (key === watched) return
            const next = at.watchDocuments(sorted)
            release?.()
            release = next
            watched = key
        },
        dispose() {
            release?.()
            release = undefined
            watched = ''
        },
    }
}
