/**
 * What the [[Share Target]]'s page offers from a synced graph without opening it: the names a
 * `[[` completes to, and the concepts a note can be filed under (ADR 0186).
 *
 * Both are in the root document, and this device's copy of it is a row in the Local Cache that
 * reads without a keyring or a relay (as `unsent-changes.ts` reads it). The page asks only for a
 * graph whose keys this device holds: a graph that is locked here shows none of its names.
 * Nothing is fetched, so the names are as fresh as the last time the graph was open here.
 */
import * as Y from 'yjs'

import { conceptKey } from '#lib/document/backlinks/backlink-index.js'
import type { Favourite } from '#lib/document/favourite-entry.js'
import type { ConceptCandidate } from '#lib/document/index-db.js'
import { fileUnderChoices } from '#lib/document/quick-note-filing.js'
import { normalizeDisplaySize } from '#lib/document/view/augmentations/image-display-size.js'
import { type GraphSettings, imageDisplaySizeOf, sanitizeFavourites, sanitizeGraphSettings } from '#lib/storage/fs/graph-settings.js'

import type { RegistryEntry } from './graph-sync'
import { openGraphCache } from './local-cache'

export interface ShareNames {
    /** Every page, journal day and alias the graph's registry names, for wikilink completion. */
    concepts: ConceptCandidate[]
    /** The concepts to offer under "Link to Favourite", in the person's Favourites order. */
    fileUnder: string[]
    /** The graph's default display size for a picture, as a document's upload would write it. */
    imageSize?: string
}

export const NO_SHARE_NAMES: ShareNames = { concepts: [], fileUnder: [] }

function registryConcepts(root: Y.Doc): ConceptCandidate[] {
    const concepts: ConceptCandidate[] = []
    const seen = new Set<string>()
    const offer = (candidate: ConceptCandidate) => {
        if (seen.has(candidate.key)) return
        seen.add(candidate.key)
        concepts.push(candidate)
    }
    const entries = [...root.getMap<RegistryEntry>('registry').values()]
    // Every document's own name before any alias, so an alias never hides a page of that name.
    for (const entry of entries) {
        const name = nameOf(entry)
        if (name) offer({ display: name, key: conceptKey(name), kind: entry.kind })
    }
    for (const entry of entries) {
        const canonical = nameOf(entry)
        if (!canonical) continue
        for (const name of aliasesOf(entry)) offer({ display: name, key: conceptKey(name), kind: 'alias', canonical })
    }
    return concepts
}

/** What a document is called: a journal's day, a page's title. */
function nameOf(entry: RegistryEntry): string | undefined {
    return (entry.kind === 'journal' ? entry.date : entry.title)?.trim() || undefined
}

function aliasesOf(entry: RegistryEntry): string[] {
    if (!Array.isArray(entry.aliases)) return []
    return entry.aliases.map((alias) => (typeof alias === 'string' ? alias.trim() : '')).filter((name) => name !== '')
}

/**
 * The person's Favourites as the Sidebar shows them: their own list, joined with the shared one
 * until their own has been seeded from it (ADR 0159, `personal-favourites.ts`). With no member
 * key the graph's record names no account, and the shared list is the only one.
 */
function settingsOf(root: Y.Doc): GraphSettings {
    const settings = root.getMap<unknown>('meta').get('settings')
    return sanitizeGraphSettings(typeof settings === 'object' && settings !== null ? settings : {})
}

function favouritesOf(root: Y.Doc, memberKey: string | undefined): Favourite[] {
    const shared = settingsOf(root).favourites ?? []
    if (!memberKey) return shared
    const own = sanitizeFavourites(root.getArray<unknown>(`favourites:${memberKey}`).toArray())
    const seeded = root.getMap<unknown>(`memberFlags:${memberKey}`).get('favouritesSeeded') === true
    return seeded ? own : sanitizeFavourites([...own, ...shared])
}

/** The names a root document holds. Pure over the document, so it is pinned down without a cache. */
export function shareNamesOf(root: Y.Doc, memberKey: string | undefined): ShareNames {
    const size = imageDisplaySizeOf(settingsOf(root))
    const imageSize = size ? (normalizeDisplaySize(size) ?? undefined) : undefined
    return {
        concepts: registryConcepts(root),
        fileUnder: fileUnderChoices(favouritesOf(root, memberKey)),
        ...(imageSize ? { imageSize } : {}),
    }
}

/** Read them from this device's copy of the graph. A graph never opened here has none. */
export async function readShareNames(graphId: string, rootDocId: string, memberKey: string | undefined): Promise<ShareNames> {
    const cache = await openGraphCache(graphId)
    const row = await cache.docCache(rootDocId).load()
    if (!row) return NO_SHARE_NAMES
    const root = new Y.Doc()
    try {
        Y.applyUpdate(root, row.update)
        return shareNamesOf(root, memberKey)
    } finally {
        root.destroy()
    }
}
