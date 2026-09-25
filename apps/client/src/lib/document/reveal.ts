/**
 * "Open this document at this line" — the seam [[Search]] needs, and that a [[Tasks View]] row
 * and a [[Backlink]]'s body land through (`openConceptAtLine` in open-concept.ts).
 *
 * A plain observable, not a rune store, because the caller is a command handler outside any
 * component. It carries a LINE rather than a character offset: the caller knows which block
 * matched, only the editor knows where that line starts, and converting in between needs the
 * document text that only the editor has.
 *
 * Two cases, one mechanism. The document may not be open yet, in which case its View consumes
 * the pending request as it mounts; or it may already be open, in which case its live editor
 * hears the request and moves. Announcing to subscribers AND retaining the request covers both
 * without the caller having to know which it is.
 */

import { frontmatterSpan } from '$lib/storage/fs/frontmatter-span'

export interface RevealRequest {
    /** The document's concept, as the ViewRef target spells it. */
    target: string
    /** 0-based source line. */
    line: number
}

let pending: RevealRequest | null = null
const listeners = new Set<(request: RevealRequest) => void>()

/**
 * Ask for `target` to show `line`. The caller opens the View separately — this only says
 * where to land, so a document that is already open is not re-opened just to be scrolled.
 */
export function revealLine(target: string, line: number): void {
    pending = { target, line }
    for (const listener of [...listeners]) {
        // Isolated: this is called on the way to opening a document, and one View failing to
        // move its caret must never stop the navigation that follows.
        try {
            listener(pending)
        } catch {
            /* a View that cannot land is left where it was */
        }
    }
}

/**
 * Consume a pending request for `target`, if there is one. Taking it clears it, so a View
 * that mounts later for a different document does not inherit someone else's landing spot.
 */
export function takeReveal(target: string): RevealRequest | null {
    if (pending?.target !== target) return null
    const request = pending
    pending = null
    return request
}

export function subscribeReveal(listener: (request: RevealRequest) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

/** Test seam: forget any pending request. */
export function resetReveal(): void {
    pending = null
}

/**
 * How many lines of frontmatter sit above a document's body.
 *
 * The [[Derived Index]] derives from the BODY (a [[Filesystem Backend]] hands it
 * `parseFrontmatter(text).body`), so every line number it records — a [[Search]] hit's, a
 * [[Backlink]]'s — is body-relative. The editor shows the whole file. Without this offset a
 * search result lands some lines above the block it matched, and on a graph whose frontmatter
 * is longer than usual it lands somewhere unrelated.
 *
 * Measured from the text in hand rather than passed around, so it is 0 on a
 * [[Server Backend]] (no frontmatter) without anyone having to know which backend they are on.
 * What counts as [[Frontmatter]] is `frontmatterSpan`'s to say - one rule, shared with the
 * storage parse and the editor's analysis.
 */
export function frontmatterLineOffset(text: string): number {
    return frontmatterSpan(text)?.lines ?? 0
}
