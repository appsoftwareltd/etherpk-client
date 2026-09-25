/**
 * Adapter from the `@sqlite.org/sqlite-wasm` oo1 DB to the engine-agnostic
 * {@link SqlDb} the index query layer uses. Shared by node tests (in-memory) and the
 * browser runtime (OPFS). Keeping the SQL surface tiny is what lets the query layer
 * (index-db.ts) be node-tested without a browser.
 */

import { createSchema, type SqlDb } from './index-db'

/**
 * The oo1 `Database` (and `:memory:` constructor) typed loosely at this single
 * boundary — the package's overloaded `exec` signatures are awkward to satisfy
 * structurally, and this adapter is the only place that touches them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Oo1Db = any

/**
 * Open a fresh in-memory SQLite DB with the index schema. sqlite-wasm is loaded
 * dynamically so it is pulled into the bundle only when a graph actually opens (not
 * by every module that transitively imports the document barrel).
 *
 * NOTE: this is the **main-thread, in-memory** runtime — rebuilt from documents each
 * session, exactly like the in-memory index it replaces. OPFS/worker *persistence*
 * (ADR 0015) is the remaining runtime step; the schema, derivation, and queries are
 * identical regardless of where the DB physically lives.
 */
export async function openInMemorySqlDb(): Promise<SqlDb> {
    const { default: sqlite3InitModule } = await import('@sqlite.org/sqlite-wasm')
    const sqlite3 = await sqlite3InitModule()
    const db = wrapOo1Db(new sqlite3.oo1.DB(':memory:') as Oo1Db)
    createSchema(db)
    return db
}

export function wrapOo1Db(db: Oo1Db): SqlDb {
    let closed = false
    // Overwrite freed pages with zeros. A document's rows leave the index when it is protected,
    // but without this the pages they sat on keep the text until reused - readable from the
    // OPFS file by anyone with the profile directory, which is the adversary protection is for.
    db.exec('PRAGMA secure_delete = ON')
    return {
        exec(sql) {
            db.exec(sql)
        },
        run(sql, params = []) {
            db.exec({ sql, bind: params as unknown[] })
        },
        all<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
            const resultRows: unknown[] = []
            db.exec({ sql, bind: params, rowMode: 'object', resultRows })
            return resultRows as T[]
        },
        close() {
            if (closed) return
            closed = true
            db.close()
        },
    }
}
