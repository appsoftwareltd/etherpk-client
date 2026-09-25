import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { beforeAll, describe, expect, it } from 'vitest'

import { createSchema, type IndexDoc, ingest, type SqlDb } from './index-db'
import { wrapOo1Db } from './index-db-sqlite'

/**
 * The text index doubles the row count a full rebuild writes, and ADR 0041 cares about that:
 * schema v4 makes EVERY user re-derive once, on every device. This pins the cost so a later
 * change cannot quietly make a cold open unbearable.
 */
describe('full rebuild cost with the text index', () => {
    let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>
    beforeAll(async () => {
        sqlite3 = await sqlite3InitModule()
    })

    // 1,200 documents rather than the 2,838 of the graph this was built against: enough for a
    // per-row scan creeping into the ingest path to show up superlinearly, without doubling
    // the runtime of the whole unit suite.
    it('indexes a large graph without the text index costing more than linear time', { timeout: 60_000 }, () => {
        const docs: IndexDoc[] = Array.from({ length: 1200 }, (_, n) => ({
            concept: `Doc ${n}`,
            kind: 'page',
            aliases: [`Alias ${n}`],
            text: [
                `# Heading ${n}`,
                `- a bullet about [[Topic ${n % 50}]] and orphaned assets`,
                `  - a nested note with rather more words in it than the parent has`,
                `- TODO #P1 review the storage footprint of [[Topic ${(n + 1) % 50}]]`,
                `Some prose mentioning quantum mechanics and other things entirely.`,
            ].join('\n'),
        }))
        const db: SqlDb = wrapOo1Db(new sqlite3.oo1.DB(':memory:'))
        createSchema(db)

        const started = performance.now()
        ingest(db, docs)
        const elapsed = performance.now() - started

        expect(db.all<{ n: number }>('SELECT COUNT(*) AS n FROM block_fts')[0].n).toBe(1200 * 5)
        // Deliberately generous: in-memory sqlite in node is not OPFS in a worker, CI machines
        // vary, and this runs alongside the rest of the suite. It is a ceiling against a
        // regression of KIND, not a benchmark of the real thing (~1.2s unloaded).
        expect(elapsed).toBeLessThan(30_000)
        console.info(`rebuild of 1,200 documents with FTS: ${Math.round(elapsed)}ms`)
    })
})
