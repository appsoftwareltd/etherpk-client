/**
 * What an orphan scan says beside a PDF that nothing links to. A person can read such a PDF through a
 * Favourite or Recents, so it may be in use, and deleting it takes their annotations with it.
 */
export interface OrphanNotesInput {
    /** The Favourites' targets, without the extension a synced id's tab wears. */
    favourites: ReadonlySet<string>
    /** The hashes of the PDFs this person has annotations on. */
    annotatedHashes: readonly string[]
}

/** The note for one orphan, or undefined. A folder's stored name holds the first 8 digits of the hash. */
export function orphanNote(orphan: { id: string; contentHash?: string }, input: OrphanNotesInput): string | undefined {
    const { contentHash } = orphan
    const annotated = contentHash !== undefined && input.annotatedHashes.some((hash) => hash.startsWith(contentHash))
    const favourite = input.favourites.has(orphan.id)
    if (annotated && favourite) return 'holds your annotations and is a Favourite'
    if (annotated) return 'holds your annotations'
    return favourite ? 'is a Favourite' : undefined
}
