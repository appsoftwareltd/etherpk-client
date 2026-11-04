/**
 * One entry of a [[Favourite]]s list (CONTEXT.md; ADR 0036, ADR 0159, ADR 0169), as it is stored and
 * compared. Framework-free and import-free, because the list is read by the Sidebar, by Graph
 * Settings on a folder graph, by each Member's list in the root document and by the Headless Client.
 *
 * - **A document**: the concept's name, a plain string, as every favourite was before View
 *   favourites. Older Clients read these as they always did.
 * - **A View**: `{ kind, concept? }`, for a View kind that can be a favourite (a [[Kanban Board]], a
 *   [[Map View]], the whole-graph Graph View). A View about one concept carries that concept, so a
 *   [[Rename]] moves it as it moves a document favourite; a kind with one View per graph carries no
 *   concept at all, so no rename can ever touch it. Its target is the one the kind declares.
 *
 * An object, never a string with a prefix: a concept may be called anything, so no string could
 * stand for a View without one day being the name of a page.
 */

/** A favourited View: its kind, and the concept it is about when its kind has one View per concept. */
export interface ViewFavourite {
    kind: string
    concept?: string
    /** What the row is called when the View cannot name itself: a PDF's file name. */
    name?: string
}

/** A favourited document (its concept's name) or View. */
export type Favourite = string | ViewFavourite

/** Longest stored kind kept. A kind is `<extension id>.<name>`, far shorter than this. */
const MAX_KIND = 200

export function isViewFavourite(favourite: Favourite): favourite is ViewFavourite {
    return typeof favourite !== 'string'
}

/**
 * A clean entry from whatever was stored, or null for one that cannot be read: a blank name, a View
 * without a kind, or a concept that is not a non-empty string. Fields it does not know are dropped.
 */
export function sanitizeFavourite(raw: unknown): Favourite | null {
    if (typeof raw === 'string') {
        const concept = raw.trim()
        return concept === '' ? null : concept
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    return sanitizeViewFavourite(raw as { kind?: unknown; concept?: unknown; name?: unknown })
}

function sanitizeViewFavourite({ kind, concept, name }: { kind?: unknown; concept?: unknown; name?: unknown }): ViewFavourite | null {
    if (typeof kind !== 'string') return null
    const cleanKind = kind.trim()
    if (cleanKind === '' || cleanKind.length > MAX_KIND) return null
    if (concept === undefined) return { kind: cleanKind }
    if (typeof concept !== 'string' || concept.trim() === '') return null
    const cleanName = typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined
    return { kind: cleanKind, concept: concept.trim(), ...(cleanName ? { name: cleanName } : {}) }
}

/**
 * The identity two entries share when they are the same favourite: a concept compared
 * case-insensitively, as [[Concept]] identity is, and a kind exactly. The two forms start with
 * different letters, so a concept named like a kind is never taken for a View.
 */
export function favouriteKey(favourite: Favourite): string {
    if (typeof favourite === 'string') return `d:${favourite.trim().toLowerCase()}`
    return `v:${favourite.kind}\n${favourite.concept?.trim().toLowerCase() ?? ''}`
}

export function sameFavourite(a: Favourite, b: Favourite): boolean {
    return favouriteKey(a) === favouriteKey(b)
}

/** The concept a favourite follows through a [[Rename]]: a document's own, a View's subject, or none. */
export function favouriteConcept(favourite: Favourite): string | undefined {
    return typeof favourite === 'string' ? favourite : favourite.concept
}

/** The favourite with its concept renamed to `to`. Only called on one that has a concept. */
export function withFavouriteConcept(favourite: Favourite, to: string): Favourite {
    return typeof favourite === 'string' ? to : { ...favourite, concept: to }
}
