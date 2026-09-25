import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { beforeAll, describe, expect, it } from 'vitest'

import { assetUsage, createSchema, type IndexDoc, ingest, type SqlDb } from './index-db'
import { wrapOo1Db } from './index-db-sqlite'

// Which documents reference an [[Asset]] — the safety gate in front of a permanent delete
// (ADR 0054). Exercised against a real in-memory sqlite-wasm DB, like the rest of index-db.

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>

beforeAll(async () => {
    sqlite3 = await sqlite3InitModule()
})

const page = (concept: string, text: string): IndexDoc => ({ concept, kind: 'page', aliases: [], text })

function dbWith(...docs: IndexDoc[]): SqlDb {
    const db = wrapOo1Db(new sqlite3.oo1.DB(':memory:'))
    createSchema(db)
    ingest(db, docs)
    return db
}

const NAME = 'q3-report.a1b2c3d4.pdf'

describe('assetUsage', () => {
    it('finds nothing when no document mentions the asset', () => {
        const db = dbWith(page('Alpha', 'Just some prose.'))

        expect(assetUsage(db, [NAME])).toEqual({ references: 0, documents: [] })
    })

    it('names every document that references it, in concept order', () => {
        const db = dbWith(
            page('Zulu', `See [report](../assets/${NAME}) for detail.`),
            page('Alpha', `- [q3](../assets/${NAME})`),
            page('Bravo', 'nothing here'),
        )

        const usage = assetUsage(db, [NAME])

        expect(usage.references).toBe(2)
        expect(usage.documents.map((d) => d.concept)).toEqual(['Alpha', 'Zulu'])
        expect(usage.documents[0]).toEqual({ concept: 'Alpha', kind: 'page', references: 1 })
    })

    it('counts two references in one document as two, not one', () => {
        const db = dbWith(page('Alpha', `[a](../assets/${NAME}) and again [b](../assets/${NAME})`))

        const usage = assetUsage(db, [NAME])

        expect(usage.references).toBe(2)
        expect(usage.documents).toEqual([{ concept: 'Alpha', kind: 'page', references: 2 }])
    })

    it('counts references in separate blocks of one document', () => {
        const db = dbWith(page('Alpha', `- one [a](../assets/${NAME})\n- two [b](../assets/${NAME})`))

        expect(assetUsage(db, [NAME]).references).toBe(2)
    })

    it('counts a reference inside a fenced code block, because deleting must never break one', () => {
        const db = dbWith(page('Alpha', '```\n' + `see ../assets/${NAME}` + '\n```'))

        expect(assetUsage(db, [NAME]).references).toBe(1)
    })

    it('matches a percent-encoded reference as well as a plain one', () => {
        const db = dbWith(page('Alpha', '[x](../assets/my%20file.a1b2c3d4.pdf)'))

        const usage = assetUsage(db, ['my file.a1b2c3d4.pdf', 'my%20file.a1b2c3d4.pdf'])

        expect(usage.references).toBe(1)
    })

    it('does not let a needle with LIKE wildcards match everything', () => {
        const db = dbWith(page('Alpha', 'no assets at all'), page('Bravo', 'literally %_% here'))

        expect(assetUsage(db, ['%_%']).documents.map((d) => d.concept)).toEqual(['Bravo'])
    })

    it('ignores documents from a superseded index generation', () => {
        const db = dbWith(page('Alpha', `[x](../assets/${NAME})`))
        ingest(db, [page('Alpha', 'the reference is gone now')])

        expect(assetUsage(db, [NAME])).toEqual({ references: 0, documents: [] })
    })
})
