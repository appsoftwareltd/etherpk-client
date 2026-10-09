/**
 * "Show in document" from a [[Map View]] (ADR 0118): the document opens at the [[Map Block]]
 * holding the chosen place or route, and that Map Block selects it, so the person lands on the
 * place itself rather than somewhere near it.
 *
 * The Map View cannot reach the widget, which may not exist yet (the document is still opening,
 * or the block is off screen) or may be drawn already. So the request is kept and announced, as
 * `reveal.ts` keeps the line a document should land on: a Map Block takes it as it mounts, or
 * hears it when it is open already. Taking it clears it, so one request selects one item once.
 */
import { conceptKey } from '$lib/document/backlinks/backlink-index'

/** How long a request waits for its Map Block: long enough for a cold document to open. */
const WAIT_MS = 30_000

export interface MapSelectRequest {
    /** The document holding the item, by its concept. */
    document: string
    /** The item's line as written, which finds it in its Map Block whatever line it is on now. */
    text: string
}

export interface MapSelectRequests {
    request(request: MapSelectRequest): void
    /**
     * The request for a Map Block in `document` whose body holds the line asked for, taken so no
     * other block takes it too; null when there is none for this block.
     */
    take(document: string | null, body: readonly string[]): string | null
    /** Hear each request as it is made. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void
}

export function createMapSelectRequests(now: () => number = Date.now): MapSelectRequests {
    let pending: (MapSelectRequest & { at: number }) | null = null
    const listeners = new Set<() => void>()
    return {
        request(request) {
            pending = { ...request, at: now() }
            for (const listener of [...listeners]) listener()
        },
        take(document, body) {
            if (!pending || document === null) return null
            if (now() - pending.at > WAIT_MS) {
                pending = null
                return null
            }
            if (conceptKey(pending.document) !== conceptKey(document) || !body.includes(pending.text)) return null
            const { text } = pending
            pending = null
            return text
        },
        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
    }
}
