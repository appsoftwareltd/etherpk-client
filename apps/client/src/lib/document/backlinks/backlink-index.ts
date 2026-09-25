/**
 * The pure backlink (linked-references) index — Logseq-style. Built from a snapshot
 * of every document's body, it answers "which documents reference this concept?",
 * folding aliases into the canonical concept and matching case-insensitively
 * (ADR 0011). Browser-private and fully rebuildable from the markdown (DESIGN.md →
 * Derived state is browser-private), so a simple in-memory build is the source of
 * truth; a SQLite-WASM/OPFS persistence layer is a later optimisation.
 *
 * Inspired by the AS Notes index (concept→sources, alias-folding, case-insensitive
 * filename match). EtherPK keeps the line of source as the reference context; the
 * AS Notes outline-chain enrichment (grouping references by their indentation
 * ancestry) is a noted follow-on.
 */

import type { DocumentKind } from '$lib/storage'

import { wikilinkOccurrencesInSource } from '../wikilink'

/** Case-insensitive concept identity key (mirrors storage identity / ADR 0011). */
export function conceptKey(concept: string): string {
    return concept.toLowerCase()
}

/** One document fed into the index: identity, aliases, and the body to scan. */
export interface IndexDoc {
    concept: string
    kind: DocumentKind
    /** Alternate names declared in frontmatter (`aliases:`). */
    aliases: string[]
    /** The document body (frontmatter stripped) to scan for wikilinks. */
    text: string
}

/** One reference to a concept, located in a source document. */
export interface BacklinkRef {
    sourceConcept: string
    sourceKind: DocumentKind
    /** 0-based line in the source body. */
    line: number
    /** The source line (the reference's context). */
    lineText: string
    /** Column range of the `[[…]]` within `lineText` (for highlighting). */
    matchStart: number
    matchEnd: number
}

/** References to one source document, in line order. */
export interface BacklinkGroup {
    sourceConcept: string
    sourceKind: DocumentKind
    refs: BacklinkRef[]
}

export interface BacklinkIndex {
    /** conceptKey(link concept) → every reference to it. */
    byTarget: Map<string, BacklinkRef[]>
    /** aliasKey → canonical conceptKey. */
    aliasToCanonical: Map<string, string>
    /** Every key that resolves to a real document (canonical concept or alias). */
    existing: Set<string>
    /** key → a display concept name (canonical casing as authored). */
    display: Map<string, string>
}

export function buildBacklinkIndex(docs: Iterable<IndexDoc>): BacklinkIndex {
    const byTarget = new Map<string, BacklinkRef[]>()
    const aliasToCanonical = new Map<string, string>()
    const existing = new Set<string>()
    const display = new Map<string, string>()

    // 1) Register identities + aliases first, so resolution sees the whole graph.
    for (const doc of docs) {
        const ck = conceptKey(doc.concept)
        existing.add(ck)
        display.set(ck, doc.concept)
        for (const alias of doc.aliases) {
            const ak = conceptKey(alias)
            existing.add(ak)
            aliasToCanonical.set(ak, ck)
            if (!display.has(ak)) display.set(ak, alias)
        }
    }

    // 2) Record every wikilink occurrence as a backlink against its concept key.
    for (const doc of docs) {
        for (const occ of wikilinkOccurrencesInSource(doc.text)) {
            const tk = conceptKey(occ.concept)
            const ref: BacklinkRef = {
                sourceConcept: doc.concept,
                sourceKind: doc.kind,
                line: occ.line,
                lineText: occ.lineText,
                matchStart: occ.matchStart,
                matchEnd: occ.matchEnd,
            }
            const list = byTarget.get(tk)
            if (list) list.push(ref)
            else byTarget.set(tk, [ref])
        }
    }

    return { byTarget, aliasToCanonical, existing, display }
}

/** True when the concept resolves to a real document (by canonical name or alias). */
export function conceptExists(index: BacklinkIndex, concept: string): boolean {
    return index.existing.has(conceptKey(concept))
}

/** The canonical concept key for a concept (following an alias to its page). */
export function canonicalKey(index: BacklinkIndex, concept: string): string {
    const key = conceptKey(concept)
    return index.aliasToCanonical.get(key) ?? key
}

/** Every key that targets the same canonical concept (the canonical key + its aliases). */
function namesForCanonical(index: BacklinkIndex, canonical: string): Set<string> {
    const names = new Set<string>([canonical])
    for (const [alias, c] of index.aliasToCanonical) if (c === canonical) names.add(alias)
    return names
}

/**
 * All references to a concept — pooling the concept's own name and any of its
 * aliases (Logseq/AS Notes alias-folding), case-insensitively. Returned grouped by
 * source document: journals first (most-recent date first), then pages
 * alphabetically; references within a document in line order.
 */
export function backlinksFor(index: BacklinkIndex, concept: string): BacklinkGroup[] {
    const canonical = canonicalKey(index, concept)
    const names = namesForCanonical(index, canonical)

    const refs: BacklinkRef[] = []
    for (const name of names) refs.push(...(index.byTarget.get(name) ?? []))

    // Group by source document.
    const groups = new Map<string, BacklinkGroup>()
    for (const ref of refs) {
        let group = groups.get(ref.sourceConcept)
        if (!group) {
            group = { sourceConcept: ref.sourceConcept, sourceKind: ref.sourceKind, refs: [] }
            groups.set(ref.sourceConcept, group)
        }
        group.refs.push(ref)
    }
    for (const group of groups.values()) {
        group.refs.sort((a, b) => a.line - b.line || a.matchStart - b.matchStart)
    }

    return [...groups.values()].sort(compareGroups)
}

/** Journals first (date desc), then pages (concept asc, case-insensitive). */
function compareGroups(a: BacklinkGroup, b: BacklinkGroup): number {
    if (a.sourceKind !== b.sourceKind) return a.sourceKind === 'journal' ? -1 : 1
    if (a.sourceKind === 'journal') return b.sourceConcept.localeCompare(a.sourceConcept)
    return conceptKey(a.sourceConcept).localeCompare(conceptKey(b.sourceConcept))
}

/** Total reference count across all groups (for the view's summary). */
export function backlinkCount(groups: BacklinkGroup[]): number {
    return groups.reduce((n, g) => n + g.refs.length, 0)
}
