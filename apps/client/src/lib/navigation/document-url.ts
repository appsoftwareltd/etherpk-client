/**
 * Document URL construction (CONTEXT.md: **Document URL**; ADR 0023).
 *
 * `/g/[graphId]/d/[...concept]` — the rest param carries the concept, so a
 * concept containing `/` spans several path segments and round-trips through
 * SvelteKit's `params.concept` (which re-joins segments with `/` and decodes
 * each). Pure string helpers; no router imports.
 *
 * An [[Asset]] opened in its own tab is addressable the same way, at
 * `/g/[graphId]/a/[assetId]`, and a graph [[Theme]] in its editor at `/g/[graphId]/t/[themeId]`.
 * ADR 0023 made the main region's active [[View]] the thing the address bar names and the Back
 * button walks; both are main-region Views like any other, and leaving either unaddressed meant
 * opening it changed no URL and pushed no history entry - so Back skipped straight past it to
 * the document before. For the Theme editor that bit hardest: Settings sends people there, and
 * Back was meant to find Settings again (2026-09-20).
 */

import type { ViewRef } from '$lib/layout'

/** Encode a concept for the `[...concept]` rest param: per-segment, `/` kept. */
export function encodeConceptPath(concept: string): string {
    return concept.split('/').map(encodeURIComponent).join('/')
}

/** The Document URL for a concept within a graph. */
export function documentUrl(graphId: string, concept: string): string {
    return `${graphUrl(graphId)}/d/${encodeConceptPath(concept)}`
}

/** The URL for an [[Asset]] opened in its own tab, keyed by its identity (never by a reference). */
export function assetUrl(graphId: string, assetId: string): string {
    return `${graphUrl(graphId)}/a/${encodeURIComponent(assetId)}`
}

/** The URL for a graph [[Theme]] open in the Theme editor, keyed by the theme's id. */
export function themeUrl(graphId: string, themeId: string): string {
    return `${graphUrl(graphId)}/t/${encodeURIComponent(themeId)}`
}

/** The bare workspace URL for a graph. */
export function graphUrl(graphId: string): string {
    return `/g/${encodeURIComponent(graphId)}`
}

/**
 * The URL naming a [[View]], or `null` when that kind has no address.
 *
 * The one place that decides what is addressable, so the history engine never has to know the
 * kinds: a View with a URL is a [[Visit]], and a View without one (backlinks, tasks, the graph
 * sidebar) is chrome you look through rather than a place you go (ADR 0023). A new addressable
 * kind is one line here.
 */
export function viewUrl(graphId: string, view: ViewRef): string | null {
    if (view.kind === 'document') return documentUrl(graphId, view.target)
    if (view.kind === 'asset') return assetUrl(graphId, view.target)
    if (view.kind === 'theme') return themeUrl(graphId, view.target)
    return null
}
