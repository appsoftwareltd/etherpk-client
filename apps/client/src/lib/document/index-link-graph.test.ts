import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createSchema, ingest, type IndexDoc, type SqlDb } from './index-db'
import { wrapOo1Db } from './index-db-sqlite'
import { type LinkGraph, linkGraph } from './index-link-graph'

// The [[Graph View]]'s one query: every concept and every (source, target) pair, read from the
// Derived Index's `links` table without opening a document. Exercised against a real
// in-memory sqlite-wasm database, as the rest of the index's query layer is (ADR 0015).

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

/** The pairs as readable `source -> target` names, so a failure says which line is wrong. */
function pairs(graph: LinkGraph): string[] {
    return graph.links.map((link) => `${graph.concepts[link.source].name} -> ${graph.concepts[link.target].name}`)
}

function link(graph: LinkGraph, source: string, target: string) {
    return graph.links.find((l) => graph.concepts[l.source].name === source && graph.concepts[l.target].name === target)
}

describe('linkGraph', () => {
    it('is empty for an empty index', () => {
        expect(linkGraph(db)).toEqual({ concepts: [], links: [] })
    })

    it('lists every page, journal entry and Pageless Concept once, aliases folded into their page', () => {
        ingest(db, [page('Plants', 'see [[Soil]] and [[Greenery]]', []), page('Gardening', '', ['Greenery']), journal('2026-09-15', '[[Plants]]')])
        const graph = linkGraph(db)
        expect(graph.concepts.map((c) => [c.name, c.kind])).toEqual([
            ['2026-09-15', 'journal'],
            ['Gardening', 'page'],
            ['Plants', 'page'],
            ['Soil', 'pageless'],
        ])
        expect(graph.concepts.map((c) => c.key)).toEqual(['2026-09-15', 'gardening', 'plants', 'soil'])
    })

    it('draws one line per pair, counting every mention under any name', () => {
        ingest(db, [page('Plants', '[[Gardening]] then [[greenery]] and [[GARDENING]]\n- [[Soil]]'), page('Gardening', '', ['Greenery'])])
        const graph = linkGraph(db)
        expect(pairs(graph)).toEqual(['Plants -> Gardening', 'Plants -> Soil'])
        expect(link(graph, 'Plants', 'Gardening')?.mentions).toBe(3)
        expect(link(graph, 'Plants', 'Soil')?.mentions).toBe(1)
    })

    it('keeps both directions of a pair as two lines', () => {
        ingest(db, [page('A', '[[B]]'), page('B', '[[A]]')])
        expect(pairs(linkGraph(db))).toEqual(['A -> B', 'B -> A'])
    })

    it('leaves out a page linking to itself, by its name or an alias', () => {
        ingest(db, [page('Plants', '[[Plants]] [[Flora]] [[Soil]]', ['Flora'])])
        expect(pairs(linkGraph(db))).toEqual(['Plants -> Soil'])
    })

    it("marks the line a scope in a page's own name draws", () => {
        ingest(db, [page('Physics'), page('[[Physics]] Quantum Mechanics', 'see [[Waves]]')])
        const graph = linkGraph(db)
        expect(link(graph, '[[Physics]] Quantum Mechanics', 'Physics')?.inTitle).toBe(true)
        expect(link(graph, '[[Physics]] Quantum Mechanics', 'Waves')?.inTitle).toBeUndefined()
    })

    it('names a Pageless Concept by the casing most of its mentions use', () => {
        ingest(db, [page('A', '[[soil]] [[Soil]]'), page('B', '[[Soil]]')])
        expect(linkGraph(db).concepts.find((c) => c.key === 'soil')?.name).toBe('Soil')
    })

    it('shows a protected page by name, flagged, with lines in from plaintext and none out', () => {
        const cipher = '```etherpk-cipher\nAQQAAAGZaLmAAG5vdGUgWyxbU2VjcmV0XV0\n```'
        ingest(db, [page('Bank', cipher), page('Money', '[[Bank]]')])
        const graph = linkGraph(db)
        expect(graph.concepts.find((c) => c.name === 'Bank')).toEqual({ key: 'bank', name: 'Bank', kind: 'page', protected: true })
        expect(pairs(graph)).toEqual(['Money -> Bank'])
    })

    it("keeps a page whose name is also another page's alias, and its links go to it", () => {
        // Foo is a page, and Bar answers to Foo too: a page's own name wins, as when a link opens.
        ingest(db, [page('Foo', '[[Other]]'), page('Bar', '', ['Foo']), page('Other', '[[Foo]]')])
        const graph = linkGraph(db)
        expect(graph.concepts.map((c) => c.name)).toEqual(['Bar', 'Foo', 'Other'])
        expect(pairs(graph)).toEqual(['Foo -> Other', 'Other -> Foo'])
    })

    it('refers to concepts by their position in the list, so the message stays small', () => {
        ingest(db, [page('A', '[[B]]'), page('B')])
        const graph = linkGraph(db)
        expect(graph.links).toEqual([{ source: 0, target: 1, mentions: 1 }])
    })
})
