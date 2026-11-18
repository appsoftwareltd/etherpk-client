/**
 * Document URL construction (CONTEXT.md: **Document URL**; ADR 0023).
 *
 * `<graph address>/d/[...concept]`, where the [[Graph Address]] is `/graph/<where>/<name>`
 * (ADR 0192, graph-address.ts) — the rest param carries the concept, so a
 * concept containing `/` spans several path segments and round-trips through
 * SvelteKit's `params.concept` (which re-joins segments with `/` and decodes
 * each). Pure string helpers; no router imports.
 *
 * An [[Asset]] opened in its own tab is addressable the same way, at
 * `<graph address>/a/[assetId]`, and a graph [[Theme]] in its editor at `<graph address>/t/[themeId]`.
 * An extension's View is addressed as its manifest declares (ADR 0121): a [[Kanban Board]] at
 * `<graph address>/k/<concept>`, a [[Map View]] at `<graph address>/m/<concept>` or
 * `<graph address>/map` for the whole graph's. One from the Extension Directory is under its id:
 * `<graph address>/x/<id>/…`.
 * ADR 0023 made the main region's active [[View]] the thing the address bar names and the Back
 * button walks; both are main-region Views like any other, and leaving either unaddressed meant
 * opening it changed no URL and pushed no history entry - so Back skipped straight past it to
 * the document before. For the Theme editor that bit hardest: Settings sends people there, and
 * Back was meant to find Settings again (2026-09-20).
 */

import { DIRECTORY_SEGMENT, EXTENSION_ADDRESS_KIND } from '#lib/extensions/addresses.js'
import type { ViewRef } from '#lib/layout/index.js'

import { encodeConceptPath } from './concept-path'
import { extensionAddresses } from './extension-addresses'
import { graphAddressPath, type GraphAddress } from './graph-address'

export { encodeConceptPath }

/** The Document URL for a concept within a graph. */
export function documentUrl(graph: GraphAddress, concept: string): string {
    return `${graphUrl(graph)}/d/${encodeConceptPath(concept)}`
}

/** The URL for an [[Asset]] opened in its own tab, keyed by its identity (never by a reference). */
export function assetUrl(graph: GraphAddress, assetId: string): string {
    return `${graphUrl(graph)}/a/${encodeURIComponent(assetId)}`
}

/** The URL for a graph [[Theme]] open in the Theme editor, keyed by the theme's id. */
export function themeUrl(graph: GraphAddress, themeId: string): string {
    return `${graphUrl(graph)}/t/${encodeURIComponent(themeId)}`
}

/** The bare workspace URL for a graph. */
export function graphUrl(graph: GraphAddress): string {
    return graphAddressPath(graph)
}

/**
 * The URL naming a [[View]], or `null` when that kind has no address.
 *
 * The one place that decides what is addressable, so the history engine never has to know the
 * kinds: a View with a URL is a [[Visit]], and a View without one (backlinks, tasks, the graph
 * sidebar) is chrome you look through rather than a place you go (ADR 0023). A new addressable
 * kind is one line here.
 */
export function viewUrl(graph: GraphAddress, view: ViewRef): string | null {
    if (view.kind === 'document') return documentUrl(graph, view.target)
    if (view.kind === 'asset') return assetUrl(graph, view.target)
    if (view.kind === 'theme') return themeUrl(graph, view.target)
    // A page of an extension not installed here keeps the address it was opened at.
    if (view.kind === EXTENSION_ADDRESS_KIND) return `${graphUrl(graph)}/${DIRECTORY_SEGMENT}/${encodeConceptPath(view.target)}`
    // Every other kind is an extension's, addressed as its manifest declares (ADR 0121).
    return extensionAddresses()?.url(graph, view) ?? null
}
