/**
 * The [[Slug]] each document occupies in a [[Published Site]] (`DESIGN.md` → URLs): a `slug:` key
 * in the frontmatter when the document names one, otherwise the concept slugified (a page's
 * title *is* its concept; a journal entry's day slugs to itself), with a deterministic numeric
 * suffix when two documents want one slug, so a publish never silently overwrites one page with
 * another. An explicit slug is allocated before every derived one, so a document that asked for
 * an address keeps it whatever order the source listed it in. The generated files' names are
 * reserved.
 */

import { parseFrontmatter } from '$lib/storage/fs/frontmatter'

import { conceptKey } from '../backlinks/backlink-index'
import { publishSlug } from '../wikilink/derive'
import type { PublishDocument } from './types'

/** Names the publisher writes itself; a document wanting one is suffixed instead. */
export const RESERVED_SLUGS: readonly string[] = ['index', '404', 'journal', 'search']

export interface SlugCollision {
    concept: string
    /** The slug the document wanted. */
    wanted: string
    /** The slug it got. */
    slug: string
    /** Whether the document asked for the slug in its frontmatter. */
    explicit: boolean
}

export interface IgnoredSlug {
    concept: string
    /** The `slug:` value as written. */
    value: string
    reason: 'reserved' | 'empty' | 'not-text'
}

export interface SlugAllocation {
    /** conceptKey → slug. */
    slugs: Map<string, string>
    collisions: SlugCollision[]
    /** Explicit slugs that could not be used. */
    ignored: IgnoredSlug[]
}

/** The document's `slug:` key normalised like any slug, or null when it has none. */
export function explicitSlugOf(text: string): string | null {
    const value = parseFrontmatter(text).data.slug
    if (typeof value !== 'string' && typeof value !== 'number') return null
    const slug = publishSlug(String(value))
    return slug === '' ? null : slug
}

function derivedSlug(doc: PublishDocument): string {
    const slug = publishSlug(doc.concept)
    return slug === '' ? (doc.kind === 'journal' ? 'journal-entry' : 'page') : slug
}

/** Allocate a slug per document: explicit slugs first, then derived ones, each in source order. */
function allocate(documents: readonly PublishDocument[]): SlugAllocation {
    const taken = new Set<string>(RESERVED_SLUGS)
    const slugs = new Map<string, string>()
    const collisions: SlugCollision[] = []
    const ignored: IgnoredSlug[] = []

    const claim = (doc: PublishDocument, wanted: string, explicit: boolean) => {
        let slug = wanted
        for (let n = 2; taken.has(slug); n++) slug = `${wanted}-${n}`
        taken.add(slug)
        slugs.set(conceptKey(doc.concept), slug)
        if (slug !== wanted) collisions.push({ concept: doc.concept, wanted, slug, explicit })
    }

    const derived: PublishDocument[] = []
    for (const doc of documents) {
        const value = parseFrontmatter(doc.text).data.slug
        if (value === undefined) {
            derived.push(doc)
            continue
        }
        if (typeof value !== 'string' && typeof value !== 'number') {
            ignored.push({ concept: doc.concept, value: JSON.stringify(value), reason: 'not-text' })
            derived.push(doc)
            continue
        }
        const wanted = publishSlug(String(value))
        if (wanted === '') {
            ignored.push({ concept: doc.concept, value: String(value), reason: 'empty' })
            derived.push(doc)
            continue
        }
        if (RESERVED_SLUGS.includes(wanted)) {
            ignored.push({ concept: doc.concept, value: String(value), reason: 'reserved' })
            derived.push(doc)
            continue
        }
        claim(doc, wanted, true)
    }
    for (const doc of derived) claim(doc, derivedSlug(doc), false)
    return { slugs, collisions, ignored }
}

/** conceptKey → slug for every document. `allocateSlugs.withReport` also says who was renamed. */
export function allocateSlugs(documents: readonly PublishDocument[]): Map<string, string> {
    return allocate(documents).slugs
}
allocateSlugs.withReport = allocate
