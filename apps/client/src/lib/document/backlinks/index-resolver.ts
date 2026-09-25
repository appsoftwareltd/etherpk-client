/**
 * An index-backed {@link WikilinkResolver}: turns a concept into a destination
 * using the live graph index, so the editor can mark links to missing concepts and
 * (later) navigate. Resolution order is concept → alias → canonical, all
 * case-insensitive (ADR 0011). A concept with no document is `missing`.
 */

import { type WikilinkResolver, publishSlug } from '../wikilink'

import { type BacklinkIndex, canonicalKey, conceptExists } from './backlink-index'

export function createIndexResolver(index: BacklinkIndex): WikilinkResolver {
    return (concept) => {
        const missing = !conceptExists(index, concept)
        // Resolve through any alias to the canonical concept's display name for the slug.
        const canonical = canonicalKey(index, concept)
        const display = index.display.get(canonical) ?? concept
        return { href: `${publishSlug(display)}.html`, missing }
    }
}
