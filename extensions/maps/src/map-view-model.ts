/**
 * What a [[Map View]] makes of the [[Derived Index]]'s answer (index-map-items.ts), kept apart
 * from the component so it can be tested without a browser: the list beside the map grouped by
 * document, the filter, the summary line, and finding the selected item again each time the
 * answer is read.
 *
 * Every item is known by its place in the answer (its key), which is also the number the map's
 * engine draws it under, so a click on the map and a row in the list name the same item.
 */
import type { MapItemHit, MapItemsResult } from '$lib/document/index-map-items'
import type { IndexUpdate } from '$lib/document/index-worker/client'
import type { MapLine } from '$lib/document/map-text'
import type { DocumentKind } from '$lib/storage'

import type { EngineItem } from './map-engine'

/** The documents the list shows, each with the keys of its items still kept by the filter. */
export interface MapViewGroup {
    concept: string
    kind: DocumentKind
    keys: number[]
}

/** The selected item, by where it is written and what it says, since its key changes with each read. */
export interface MapViewSelection {
    concept: string
    line: number
    text: string
}

/** Whether an index update can have changed what a Map View shows. */
export function touchesMaps(update: Pick<IndexUpdate, 'full' | 'mapsChanged'>): boolean {
    return update.full || update.mapsChanged
}

/** Whether two answers hold the same items, so a read that changed nothing draws nothing. */
export function sameAnswer(a: MapItemsResult, b: MapItemsResult): boolean {
    if (a.truncated !== b.truncated || a.items.length !== b.items.length) return false
    return a.items.every((hit, i) => {
        const other = b.items[i]
        return hit.concept === other.concept && hit.line === other.line && hit.fenceLine === other.fenceLine && hit.text === other.text
    })
}

/** An item's name, or what it is when it has none. */
export function itemLabel(item: MapLine): string {
    if (item.name !== '') return item.name
    return item.kind === 'place' ? 'Unnamed place' : 'Unnamed route'
}

/** The keys of the items whose name or document holds `query`, whatever the case; every key for none. */
export function filterKeys(hits: readonly MapItemHit[], query: string): number[] {
    const wanted = query.trim().toLocaleLowerCase()
    const keys: number[] = []
    for (const [key, hit] of hits.entries()) {
        if (wanted === '' || hit.item.name.toLocaleLowerCase().includes(wanted) || hit.concept.toLocaleLowerCase().includes(wanted)) keys.push(key)
    }
    return keys
}

/** The kept items grouped by the document they are written in, in the answer's order. */
export function groupByDocument(hits: readonly MapItemHit[], keys: readonly number[]): MapViewGroup[] {
    const groups: MapViewGroup[] = []
    for (const key of keys) {
        const hit = hits[key]
        const last = groups.at(-1)
        // The index answers in document order, so one document's items always come together.
        if (last && last.concept === hit.concept) last.keys.push(key)
        else groups.push({ concept: hit.concept, kind: hit.kind, keys: [key] })
    }
    return groups
}

const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** "3 places and 1 route in 2 documents", for the kept items. */
export function summarise(hits: readonly MapItemHit[], keys: readonly number[]): string {
    if (keys.length === 0) return 'Nothing matches'
    let places = 0
    const documents = new Set<string>()
    for (const key of keys) {
        if (hits[key].item.kind === 'place') places++
        documents.add(hits[key].concept)
    }
    const routes = keys.length - places
    const parts = []
    if (places > 0) parts.push(counted(places, 'place', 'places'))
    if (routes > 0) parts.push(counted(routes, 'route', 'routes'))
    return `${parts.join(' and ')} in ${counted(documents.size, 'document', 'documents')}`
}

/**
 * The name every place at one spot on the map shares, the same place written in several
 * documents most often, or null when their names differ.
 */
export function sharedName(spot: readonly MapItemHit[]): string | null {
    const first = itemLabel(spot[0].item)
    return spot.every((hit) => itemLabel(hit.item) === first) ? first : null
}

/** The heading of the dialog offering the places at one spot: their shared name, or how many there are. */
export function spotHeading(spot: readonly MapItemHit[]): string {
    return sharedName(spot) ?? `${spot.length} places here`
}

/** The line under that heading: how many documents hold them, or how one document does. */
export function spotSummary(spot: readonly MapItemHit[]): string {
    const documents = new Set(spot.map((hit) => hit.concept))
    if (documents.size > 1) return `In ${documents.size} documents`
    return sharedName(spot) === null ? `All in ${spot[0].concept}` : `Written ${spot.length} times in ${spot[0].concept}`
}

/**
 * The key the selected item has in this answer: the same document, line and words, or failing
 * that the same document and words (lines above it were added or removed), or null once it is gone.
 */
export function findSelection(hits: readonly MapItemHit[], selection: MapViewSelection): number | null {
    let moved: number | null = null
    for (const [key, hit] of hits.entries()) {
        if (hit.concept !== selection.concept || hit.text !== selection.text) continue
        if (hit.line === selection.line) return key
        moved ??= key
    }
    return moved
}

/** The kept items as the map's engine draws them, each under its key. */
export function engineItems(hits: readonly MapItemHit[], keys: readonly number[]): EngineItem[] {
    return keys.map((key) => ({ ...hits[key].item, key }))
}
