import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createSchema, ingest, ingestOne, type IndexDoc, type SqlDb } from './index-db'
import { wrapOo1Db } from './index-db-sqlite'
import { deriveDoc } from './index-derive'
import { mapItems, type MapItemsResult } from './index-map-items'

// The [[Map View]]'s one query (ADR 0118): every [[Place]] and [[Route]] a [[Map Block]] holds,
// for one concept by [[Block Concept]] or for the whole graph, read from rows the Derived Index
// derives as it indexes each document. A [[Protected Document]] contributes nothing, and a Map
// Block's coordinates never reach text search or Semantic Search. Run against a real in-memory
// sqlite-wasm database, as the rest of the index's query layer is (ADR 0015).

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>

beforeAll(async () => {
    sqlite3 = await sqlite3InitModule()
})

let db: SqlDb

beforeEach(() => {
    db = wrapOo1Db(new sqlite3.oo1.DB(':memory:'))
    createSchema(db)
})

const page = (concept: string, text = '', aliases: string[] = []): IndexDoc => ({ concept, kind: 'page', aliases, text })
const journal = (day: string, text = ''): IndexDoc => ({ concept: day, kind: 'journal', aliases: [], text })

const fence = (...lines: string[]) => ['```map', ...lines, '```'].join('\n')
const seal = 'Seal Bay @ 50.74860, -1.07890'
const haven = 'Wild Haven @ 51.12345, -2.12345'
const walk = 'Coast walk @ 50.7486, -1.0789 > 50.75, -1.08'

/** Each hit as `document: name`, so a failure says which place went missing or appeared. */
function names(result: MapItemsResult): string[] {
    return result.items.map((hit) => `${hit.concept}: ${hit.item.name}`)
}

describe('deriving map items', () => {
    it('reads each line of a map fence with its document line and its fence', () => {
        const derived = deriveDoc(['# Trip', '', fence(seal, 'not a place', walk)].join('\n'))
        expect(derived.mapItems.map((item) => [item.line, item.fenceLine, item.kind, item.name])).toEqual([
            [3, 2, 'place', 'Seal Bay'],
            [5, 2, 'route', 'Coast walk'],
        ])
    })

    it('reads a map fence inside a bullet, de-indented to the fence column', () => {
        const text = ['- Ideas', '  ```map', `  ${seal}`, '  ```'].join('\n')
        expect(deriveDoc(text).mapItems).toMatchObject([{ line: 2, fenceLine: 1, name: 'Seal Bay', text: seal }])
    })

    it("reads a map fence opened on a bullet's line, as /map writes one on an empty bullet", () => {
        const text = ['- Ideas', '- ```map', `  ${seal}`, '  ```'].join('\n')
        expect(deriveDoc(text).mapItems).toMatchObject([{ line: 2, fenceLine: 1, name: 'Seal Bay', text: seal }])
    })

    it('ignores a map fence shown as an example inside another fence, and every other fence', () => {
        const sample = ['````markdown', fence(seal), '````', '```js', seal, '```'].join('\n')
        expect(deriveDoc(sample).mapItems).toEqual([])
    })

    it('derives nothing from a document holding protected content', () => {
        const text = [fence(seal), '```etherpk-cipher', 'v1:abc', '```'].join('\n')
        expect(deriveDoc(text).mapItems).toEqual([])
    })
})

describe('mapItems for one concept', () => {
    it('finds the Map Blocks on the concept\'s own page', () => {
        ingest(db, [page('Campsites', fence(seal, haven)), page('Pubs', fence('The Ship @ 50, -1'))])
        expect(names(mapItems(db, 'Campsites'))).toEqual(['Campsites: Seal Bay', 'Campsites: Wild Haven'])
    })

    it('finds a Map Block nested under a bullet or a heading that links the concept, in any document', () => {
        const under = ['- Shortlist for [[Campsites]]', '  ```map', `  ${seal}`, '  ```', '- Not this one', '  ```map', '  The Ship @ 50, -1', '  ```'].join('\n')
        const heading = ['## [[Campsites]] to try', '', fence(haven)].join('\n')
        ingest(db, [journal('2026-07-14', under), page('Trip', heading)])
        expect(names(mapItems(db, 'Campsites'))).toEqual(['2026-07-14: Seal Bay', 'Trip: Wild Haven'])
    })

    it('counts the scopes in a document\'s name, as a task does', () => {
        ingest(db, [page('[[Campsites]] Wales', fence(seal))])
        expect(names(mapItems(db, 'Campsites'))).toEqual(['[[Campsites]] Wales: Seal Bay'])
    })

    it('pools the concept\'s aliases and ignores case', () => {
        const text = ['- Ideas for [[camping]]', '  ```map', `  ${seal}`, '  ```'].join('\n')
        ingest(db, [page('Campsites', '', ['Camping']), journal('2026-07-14', text)])
        expect(names(mapItems(db, 'campsites'))).toEqual(['2026-07-14: Seal Bay'])
        expect(names(mapItems(db, 'CAMPING'))).toEqual(['2026-07-14: Seal Bay'])
    })

    it('returns places and routes with their points read again', () => {
        ingest(db, [page('Campsites', fence(seal, walk))])
        expect(mapItems(db, 'Campsites').items).toEqual([
            {
                concept: 'Campsites',
                kind: 'page',
                line: 1,
                fenceLine: 0,
                text: seal,
                item: { kind: 'place', name: 'Seal Bay', point: { lat: 50.7486, lon: -1.0789 } },
            },
            {
                concept: 'Campsites',
                kind: 'page',
                line: 2,
                fenceLine: 0,
                text: walk,
                item: { kind: 'route', name: 'Coast walk', points: [{ lat: 50.7486, lon: -1.0789 }, { lat: 50.75, lon: -1.08 }], track: null },
            },
        ])
    })

    it('finds nothing for a concept nothing answers to', () => {
        ingest(db, [page('Campsites', fence(seal))])
        expect(mapItems(db, 'Pubs')).toEqual({ items: [], truncated: false })
    })
})

describe('mapItems for the whole graph', () => {
    it('lists every place and route in document order, leaving out protected documents', () => {
        const locked = ['```etherpk-cipher', 'v1:abc', '```'].join('\n')
        ingest(db, [page('Pubs', fence('The Ship @ 50, -1')), page('Campsites', fence(seal)), page('Secret', locked), journal('2026-07-14', fence(walk))])
        expect(names(mapItems(db, null))).toEqual(['2026-07-14: Coast walk', 'Campsites: Seal Bay', 'Pubs: The Ship'])
    })

    it('says when it stopped at its cap', () => {
        ingest(db, [page('Campsites', fence(seal, haven, walk))])
        const capped = mapItems(db, null, 2)
        expect(capped.items).toHaveLength(2)
        expect(capped.truncated).toBe(true)
    })

    it('follows an edit to one document', () => {
        ingest(db, [page('Campsites', fence(seal, haven))])
        ingestOne(db, page('Campsites', fence(haven)))
        expect(names(mapItems(db, null))).toEqual(['Campsites: Wild Haven'])
    })
})

describe('what search can read', () => {
    it('keeps a Map Block\'s names in text search and leaves its coordinates out', () => {
        ingest(db, [page('Campsites', ['Places we liked', '', fence(seal, walk)].join('\n'))])
        const text = db.all<{ text: string }>('SELECT text FROM block_fts').map((row) => row.text).join('\n')
        expect(text).toContain('Seal Bay')
        expect(text).toContain('Coast walk')
        expect(text).not.toMatch(/50\.7486|1\.0789/)
    })

    it('leaves the coordinates out of Semantic Search\'s passages', () => {
        ingest(db, [page('Campsites', ['Places we liked', '', fence(seal, walk)].join('\n'))])
        const text = db.all<{ text: string }>('SELECT text FROM passages').map((row) => row.text).join('\n')
        expect(text).toContain('Seal Bay')
        expect(text).not.toMatch(/50\.7486|1\.0789/)
    })

    it('keeps the coordinates in the block text an asset usage scan reads', () => {
        const route = 'Ridge @ 54.6, -3.1 > 54.7, -3.2 (../assets/ridge.a1b2c3d4.gpx)'
        ingest(db, [page('Walks', fence(route))])
        const text = db.all<{ text: string }>('SELECT text FROM blocks').map((row) => row.text).join('\n')
        expect(text).toContain('../assets/ridge.a1b2c3d4.gpx')
    })
})
