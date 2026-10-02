/**
 * Test support: a {@link LinkGraph} written as readable names, so a test reads as the graph it
 * draws rather than as positions in a list. Used by the model's unit tests and the Headless
 * Client's tool tests alike.
 */
import type { LinkGraph, LinkGraphConcept } from '$lib/document/index-link-graph'

export interface LinkGraphSpec {
    pages?: string[]
    journals?: string[]
    /** Names (among the pages) that are Protected Documents. */
    protected?: string[]
    /** `[source, target, mentions?]`. A name never listed as a page or journal is a page when it is a source and pageless when only a target. */
    links?: [string, string, number?][]
    /** `[source, scope]`: the scope in the source's own name (ADR 0083). */
    titleLinks?: [string, string][]
}

export function linkGraphOf(spec: LinkGraphSpec): LinkGraph {
    const kinds = new Map<string, LinkGraphConcept['kind']>()
    for (const name of spec.pages ?? []) kinds.set(name, 'page')
    for (const name of spec.journals ?? []) kinds.set(name, 'journal')
    const pairs = [...(spec.links ?? []), ...(spec.titleLinks ?? [])]
    for (const [source] of pairs) if (!kinds.has(source)) kinds.set(source, 'page')
    for (const [, target] of pairs) if (!kinds.has(target)) kinds.set(target, 'pageless')
    const concepts = [...kinds].map(([name, kind]): LinkGraphConcept => {
        const concept: LinkGraphConcept = { key: name.toLowerCase(), name, kind }
        return spec.protected?.includes(name) ? { ...concept, protected: true } : concept
    })
    concepts.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const at = (name: string) => concepts.findIndex((c) => c.name === name)
    const links = [
        ...(spec.links ?? []).map(([source, target, mentions]) => ({ source: at(source), target: at(target), mentions: mentions ?? 1 })),
        ...(spec.titleLinks ?? []).map(([source, target]) => ({ source: at(source), target: at(target), mentions: 1, inTitle: true as const })),
    ]
    return { concepts, links }
}
