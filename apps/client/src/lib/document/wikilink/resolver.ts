/**
 * The resolver seam: turns a concept into a destination. Pluggable so the parser
 * and renderer stay pure and unaware of storage/URLs. Concept matching is
 * case-insensitive (ADR 0011). The editor will later supply an index-backed
 * resolver; publish uses a slug resolver.
 */

import { publishSlug } from './derive'

export interface ResolvedTarget {
    /** Where the anchor points. */
    href: string
    /** True when the concept has no public/existing target (→ 404 + missing styling). */
    missing: boolean
}

export type WikilinkResolver = (concept: string) => ResolvedTarget

/**
 * A slug-based resolver for publish/tests. If `publicConcepts` is given, a concept
 * outside it (case-insensitively) is `missing` and points at `404.html`; otherwise
 * every concept resolves to its slug. Aliases would be folded into the known set by
 * the caller.
 */
export function createSlugResolver(publicConcepts?: Iterable<string>): WikilinkResolver {
    const known = publicConcepts
        ? new Set([...publicConcepts].map((c) => c.toLowerCase()))
        : undefined
    return (concept) => {
        if (known && !known.has(concept.toLowerCase())) return { href: '404.html', missing: true }
        return { href: `${publishSlug(concept)}.html`, missing: false }
    }
}
