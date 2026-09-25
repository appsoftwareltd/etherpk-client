/**
 * Whether a [[Draft]]'s concept now has a document underneath it - the question a Draft View
 * asks on every documents-changed signal before rebinding to the real document (ADR 0050).
 *
 * The **store is asked first**. A local create - the Draft-adopt race, an [[Import]], a
 * [[Quick Note]] move landing in today's entry - is in the store's registry the moment it
 * resolves, while the derived index learns of it only on its next ingest, which can be
 * seconds later or, on a graph whose index is busy, much longer. Gating on the index alone
 * left the Draft blank until a reload (2026-09-17). The index still answers for what arrives
 * by [[Sync]] before the store's registry has it, and for a store that cannot list itself.
 */

import { conceptKey } from './backlinks/backlink-index'
import type { DocumentStore } from './types'

export interface ConceptIndexLike {
    conceptExists(concept: string): boolean
}

export function draftConceptNowExists(
    store: DocumentStore,
    index: ConceptIndexLike | null | undefined,
    concept: string,
): boolean {
    const listing = store as { listDocuments?: () => readonly { key: string }[] }
    if (typeof listing.listDocuments === 'function') {
        const key = conceptKey(concept)
        if (listing.listDocuments().some((entry) => entry.key === key)) return true
    }
    return index?.conceptExists(concept) === true
}
