/**
 * Which documents a [[Publication]] contains (ADR 0082). The one place the membership rule is
 * applied, so the report, the resolver and the derived files cannot disagree about it.
 *
 * Protection is checked first and wins over everything: a document holding an `etherpk-cipher`
 * fence is excluded whatever its `public` says, by the dependency-free `containsCipherFence`, so
 * this path never needs the crypto stack and never holds a [[Protection Key]]. Whole-document
 * protection (ADR 0060) makes any cipher fence enough to exclude; being strict costs nothing and
 * a document like that is never one the user meant to publish.
 */

import { conceptKey } from '../backlinks/backlink-index'
import { containsCipherFence } from '../protection/fence-info'
import { readMembership, readPublicationDefinition } from './publication'
import type { Publication, PublishDocument, PublishIssue } from './types'

export type ExclusionReason =
    /** Holds a cipher fence. Reported by name only. */
    | 'protected'
    /** No `public: true`. */
    | 'not-public'
    /** Public, but a `named` publication it does not name. */
    | 'not-named'
    /** Defines a publication; structure, never a page. */
    | 'publication-page'
    /** Taken, but named as an include somewhere: a snippet that fills slots, never a page of its own. */
    | 'include-page'

export interface ExcludedDocument {
    concept: string
    reason: ExclusionReason
    /** Ids of other publications that do take the document, so the report can say "published in blog, not here". */
    publishedIn?: string[]
    /** For `include-page`: where the document is used as an include. */
    includes?: IncludeUse[]
}

export interface IncludeUse {
    publication: string
    slot: string
}

export interface Selection {
    /** In the order the source listed them. */
    included: PublishDocument[]
    excluded: ExcludedDocument[]
    issues: PublishIssue[]
}

/** Whether `publication` takes a document with this membership. */
function takes(publication: Publication, isPublic: boolean, named: readonly string[]): boolean {
    if (!isPublic) return false
    return publication.selection === 'all-public' || named.includes(publication.id)
}

/**
 * Where the graph's publications name this document as an include, by its concept or an alias.
 * A page named anywhere is a snippet for the whole graph: an all-public publication must not
 * publish another publication's footer as a page, and a page cannot sensibly be both.
 */
export function includeUsesOf(doc: PublishDocument, publications: readonly Publication[]): IncludeUse[] {
    const keys = new Set([conceptKey(doc.concept), ...doc.aliases.map(conceptKey)])
    const uses: IncludeUse[] = []
    for (const publication of publications) {
        for (const [slot, concept] of Object.entries(publication.includes)) {
            if (keys.has(conceptKey(concept))) uses.push({ publication: publication.id, slot })
        }
    }
    return uses
}

export type IncludeStatus = 'ok' | 'protected' | 'publication-page' | 'not-public' | 'not-named'

/**
 * Whether a page can fill an include slot of `publication`: the same rule as for a page of the
 * site, because an include's body reaches the site too. The consent rule has no exception for
 * includes; what differs is only that the page is then a slot, not a page of its own.
 */
export function includeStatus(doc: PublishDocument, publication: Publication): IncludeStatus {
    if (containsCipherFence(doc.text)) return 'protected'
    if (readPublicationDefinition(doc).publication) return 'publication-page'
    const membership = readMembership(doc.text)
    if (!membership.isPublic) return 'not-public'
    if (!takes(publication, true, membership.publications)) return 'not-named'
    return 'ok'
}

export function selectDocuments(
    documents: readonly PublishDocument[],
    publication: Publication,
    allPublications: readonly Publication[],
): Selection {
    const included: PublishDocument[] = []
    const excluded: ExcludedDocument[] = []
    const issues: PublishIssue[] = []
    const knownIds = new Set(allPublications.map((p) => p.id))

    for (const doc of documents) {
        if (containsCipherFence(doc.text)) {
            excluded.push({ concept: doc.concept, reason: 'protected' })
            continue
        }
        if (readPublicationDefinition(doc).publication) {
            excluded.push({ concept: doc.concept, reason: 'publication-page' })
            continue
        }
        const membership = readMembership(doc.text, doc.concept)
        issues.push(...membership.issues)
        for (const id of membership.publications) {
            if (!knownIds.has(id)) {
                issues.push({
                    level: 'warning',
                    code: 'unknown-publication',
                    message: `"${doc.concept}" names the publication "${id}", which no page defines.`,
                    concept: doc.concept,
                })
            }
        }
        if (takes(publication, membership.isPublic, membership.publications)) {
            // Named as an include anywhere: its body fills slots, so it is not also a page (a
            // footer as `site-footer.html` in search and the sitemap is clutter, a head snippet
            // as a page is nonsense, and an all-public site would otherwise publish another
            // publication's footer). The consent above still had to hold for it to get here.
            const uses = includeUsesOf(doc, allPublications)
            if (uses.length > 0) {
                excluded.push({ concept: doc.concept, reason: 'include-page', includes: uses })
                continue
            }
            included.push(doc)
            continue
        }
        const entry: ExcludedDocument = {
            concept: doc.concept,
            reason: membership.isPublic ? 'not-named' : 'not-public',
        }
        const elsewhere = allPublications
            .filter((p) => p.id !== publication.id && takes(p, membership.isPublic, membership.publications))
            .map((p) => p.id)
        if (elsewhere.length > 0) entry.publishedIn = elsewhere
        excluded.push(entry)
    }
    return { included, excluded, issues }
}

/**
 * Public documents that no publication takes: the state the report has to surface when every
 * publication is `named`, because the document's author said "public" and nothing happened.
 */
export function publicDocumentsInNoPublication(
    documents: readonly PublishDocument[],
    publications: readonly Publication[],
): PublishDocument[] {
    if (publications.some((p) => p.selection === 'all-public')) return []
    const out: PublishDocument[] = []
    for (const doc of documents) {
        if (containsCipherFence(doc.text)) continue
        if (readPublicationDefinition(doc).publication) continue
        const membership = readMembership(doc.text)
        if (!membership.isPublic) continue
        if (publications.some((p) => takes(p, true, membership.publications))) continue
        out.push(doc)
    }
    return out
}
