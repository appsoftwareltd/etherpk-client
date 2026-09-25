/**
 * The database host used inside a worker: persist to OPFS when the environment allows it,
 * and fall back to memory when it does not (ADR 0041). A worker that cannot persist is still
 * worth having — it keeps every rebuild off the main thread.
 */

import { discardPersistedSqlDb, openPersistedSqlDb, persistenceBlockFor } from '../index-db-opfs'
import { openInMemorySqlDb } from '../index-db-sqlite'
import type { IndexDbHost } from './core'

export function opfsDbHost(): IndexDbHost {
    return {
        async open(graphId) {
            const db = await openPersistedSqlDb(graphId)
            if (db) return { db, persisted: true }
            return { db: await openInMemorySqlDb(), persisted: false, blocked: persistenceBlockFor(graphId) }
        },
        async discard(graphId) {
            await discardPersistedSqlDb(graphId)
            const db = await openPersistedSqlDb(graphId)
            if (db) return { db, persisted: true }
            return { db: await openInMemorySqlDb(), persisted: false, blocked: persistenceBlockFor(graphId) }
        },
    }
}
