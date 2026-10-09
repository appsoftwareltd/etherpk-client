/**
 * The [[Map View]]'s query over the [[Derived Index]] (ADR 0118): every [[Place]] and [[Route]]
 * held in a [[Map Block]] that answers to one [[Concept]] by [[Block Concept]], or every one in
 * the graph, in one answer.
 *
 * The rows are derived as each document is indexed (`index-derive.ts`), so no document is opened
 * or parsed here. A concept is pooled over its [[Alias]]es exactly as the Tasks View's Name
 * Filter is, so a map and a Kanban Board for one concept agree on what lies under it. A
 * [[Protected Document]] contributes nothing: derivation gives it no rows, and the query leaves
 * out every page the index flags as protected as well.
 */
import type { DocumentKind } from '$lib/storage'

import { conceptKey } from './backlinks/backlink-index'
import { activeIndexGeneration, conceptFamilyKeys, type SqlDb } from './index-db'
import { type MapLine, readMapLine } from './map-text'

/** One place or route, where it is written, and what it says. */
export interface MapItemHit {
    /** The document holding the Map Block, by its concept. */
    concept: string
    kind: DocumentKind
    /** 0-based line of the item in its document. */
    line: number
    /** 0-based line of its Map Block's opening fence. */
    fenceLine: number
    /** The line as written, which finds the item again in its Map Block. */
    text: string
    item: MapLine
}

export interface MapItemsResult {
    /** In document order, then line order. */
    items: MapItemHit[]
    /** True when the cap cut the answer short; the Map View says so rather than fitting a part. */
    truncated: boolean
}

/**
 * The most items one answer carries. Far beyond a real graph's maps (hundreds of Map Blocks of
 * tens of places each), and small enough that a pathological graph cannot stall the worker or
 * the drawing.
 */
export const MAP_ITEMS_CAP = 20_000

interface MapItemRowResult {
    concept: string
    kind: DocumentKind
    line: number
    fence_line: number
    text: string
}

/**
 * Whether the document with this concept key holds any place or route in the active generation.
 * Asked before and after a document is indexed again, so an update can say whether it touched a
 * map and an open Map View reads again only when one did.
 */
export function pageHasMapItems(db: SqlDb, key: string): boolean {
    return (
        db.all<{ found: number }>(
            `SELECT 1 AS found FROM map_items m JOIN pages p ON p.id = m.page_id
             WHERE p.generation = ? AND p.concept_key = ? LIMIT 1`,
            [activeIndexGeneration(db), key],
        ).length > 0
    )
}

/** Every place and route answering to `concept`, or in the whole graph when it is null. */
export function mapItems(db: SqlDb, concept: string | null, cap = MAP_ITEMS_CAP): MapItemsResult {
    const where = ['p.generation = ?', 'p.protected = 0']
    const params: unknown[] = [activeIndexGeneration(db)]
    if (concept !== null) {
        const names = conceptFamilyKeys(db, conceptKey(concept))
        where.push(
            `EXISTS (SELECT 1 FROM map_concepts mc
                     WHERE mc.page_id = m.page_id AND mc.block_local_id = m.block_local_id
                       AND mc.concept_key IN (${names.map(() => '?').join(',')}))`,
        )
        params.push(...names)
    }
    // One extra row decides `truncated` without a second COUNT, as the Tasks View's page does.
    const rows = db.all<MapItemRowResult>(
        `SELECT p.concept, p.kind, m.line, m.fence_line, m.text
         FROM map_items m JOIN pages p ON p.id = m.page_id
         WHERE ${where.join(' AND ')}
         ORDER BY p.concept_key, p.id, m.line
         LIMIT ?`,
        [...params, cap + 1],
    )
    const truncated = rows.length > cap
    const items: MapItemHit[] = []
    for (const row of truncated ? rows.slice(0, cap) : rows) {
        // The row was written from a line that read, so it reads again; the check keeps a row
        // from an older derivation from drawing nonsense if one ever outlives a schema bump.
        const item = readMapLine(row.text)
        if (item) items.push({ concept: row.concept, kind: row.kind, line: row.line, fenceLine: row.fence_line, text: row.text, item })
    }
    return { items, truncated }
}
