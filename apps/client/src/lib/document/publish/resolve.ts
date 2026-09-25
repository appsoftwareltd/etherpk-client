/**
 * The publication's resolver: concept → destination inside one [[Published Site]]. Alias folding
 * and case-insensitive identity come from the backlink index built over the publication's own
 * documents (`backlinks/backlink-index.ts`), so the site agrees with the app about what a link
 * means. A target outside the publication is `missing` and points at the [[404 Page]], whether
 * it is private, public in another publication, or not a document at all; the report tells
 * those apart, the site does not (`DESIGN.md` → Publishing).
 *
 * The same resolver renders a *name*: a scoped concept's display is its own wikilink rendered
 * as chained anchors (the as-notes `renderPageName`), so a heading, a menu entry and a body
 * link all show the same thing.
 */

import { parseFrontmatter } from '$lib/storage/fs/frontmatter'

import { type BacklinkIndex, buildBacklinkIndex, canonicalKey, conceptKey } from '../backlinks/backlink-index'
import { wikilinkSegments } from '../wikilink/model'
import { parseWikilinks } from '../wikilink/parser'
import { renderWikilinkSegmentsToHtml } from '../wikilink/render-html'
import type { ResolvedTarget } from '../wikilink/resolver'
import type { PublishDocument } from './types'

export type TargetStatus =
    /** In this publication. */
    | 'published'
    /** A public document another publication takes. */
    | 'elsewhere'
    /** A document the graph has that is not public here. */
    | 'private'
    /** No document answers to the concept. */
    | 'missing'

export interface PublicationTarget extends ResolvedTarget {
    /** The concept as the target document spells it (alias followed), or as asked when nothing answers. */
    canonical: string
    status: TargetStatus
    publishedIn?: string[]
}

export interface PublicationResolver {
    resolve(concept: string): PublicationTarget
    /** The concept's slug when it is in the publication. */
    slugOf(concept: string): string | undefined
    /** The display name as chained anchors, HTML-escaped; a plain name is escaped text. */
    titleHtml(concept: string): string
    /** The backlink index over the publication's documents, for the backlinks views. */
    index: BacklinkIndex
}

export interface ResolverInput {
    /** The documents the publication contains. */
    included: readonly PublishDocument[]
    /** Every document of the graph, to tell "private" from "no such document". */
    allDocuments: readonly PublishDocument[]
    /** conceptKey → slug, for the included documents. */
    slugs: ReadonlyMap<string, string>
    /** conceptKey → the other publications that take the document. */
    publishedElsewhere?: ReadonlyMap<string, readonly string[]>
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The name with every `[[` and `]]` removed: `[[Physics]] Waves` → `Physics Waves`. */
export function titleText(concept: string): string {
    return concept.replace(/\[\[|\]\]/g, '')
}

export function createPublicationResolver(input: ResolverInput): PublicationResolver {
    const index = buildBacklinkIndex(
        input.included.map((doc) => ({
            concept: doc.concept,
            kind: doc.kind,
            aliases: [...doc.aliases],
            text: parseFrontmatter(doc.text).body,
        })),
    )
    // Alias folding across the whole graph, so a link to a private page's alias is "private",
    // not "missing".
    const graphIndex = buildBacklinkIndex(
        input.allDocuments.map((doc) => ({ concept: doc.concept, kind: doc.kind, aliases: [...doc.aliases], text: '' })),
    )

    function resolve(concept: string): PublicationTarget {
        const key = canonicalKey(index, concept)
        const slug = input.slugs.get(key)
        if (slug !== undefined && index.existing.has(key)) {
            return { href: `${slug}.html`, missing: false, canonical: index.display.get(key) ?? concept, status: 'published' }
        }
        const graphKey = canonicalKey(graphIndex, concept)
        const canonical = graphIndex.display.get(graphKey) ?? concept
        const elsewhere = input.publishedElsewhere?.get(graphKey)
        if (elsewhere && elsewhere.length > 0) {
            return { href: '404.html', missing: true, canonical, status: 'elsewhere', publishedIn: [...elsewhere] }
        }
        if (graphIndex.existing.has(graphKey)) return { href: '404.html', missing: true, canonical, status: 'private' }
        return { href: '404.html', missing: true, canonical: concept, status: 'missing' }
    }

    function titleHtml(concept: string): string {
        if (!concept.includes('[[')) return escapeHtml(concept)
        const text = `[[${concept}]]`
        const segments = wikilinkSegments(parseWikilinks(text))
        return renderWikilinkSegmentsToHtml(text, segments, (c) => resolve(c))
    }

    return {
        resolve,
        slugOf: (concept) => input.slugs.get(canonicalKey(index, conceptKey(concept))),
        titleHtml,
        index,
    }
}
