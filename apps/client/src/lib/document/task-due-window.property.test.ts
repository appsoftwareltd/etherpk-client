import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'

import { createSchema, ingest, type TaskDueWindow, TASK_DUE_WINDOWS, TASK_PRIORITY_FILTERS, TASK_STATUSES, tasksMatching } from './index-db'
import { wrapOo1Db } from './index-db-sqlite'
import { formatISODate, parseISODate, shiftDate } from './calendar/month-grid-core'
import { inDueWindow } from './task-due-window'

/**
 * A Due window is answered in two places: the index's SQL, for the lists the Tasks View and a
 * Kanban Board read, and `inDueWindow`, for a card the board holds while its move is being written.
 * Over any set of due dates around today, the two let through exactly the same tasks, so a card
 * never shows under a filter the index would leave it out of.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261119 : Number(seed) }
}

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>
beforeAll(async () => {
    sqlite3 = await sqlite3InitModule()
})

const TODAY = '2026-09-01'
const day = (offset: number) => formatISODate(shiftDate(parseISODate(TODAY)!, offset))

describe('a Due window', () => {
    it('lets through the same tasks in the index and in inDueWindow', () => {
        // Each task: no due date, or one up to 10 days either side of today.
        const dues = fc.array(fc.option(fc.integer({ min: -10, max: 10 }), { nil: null }), { minLength: 1, maxLength: 12 })
        fc.assert(
            fc.property(dues, fc.constantFrom<TaskDueWindow>(...TASK_DUE_WINDOWS), (offsets, window) => {
                const db = wrapOo1Db(new sqlite3.oo1.DB(':memory:'))
                createSchema(db)
                const lines = offsets.map((offset, k) => `- [ ] ${offset === null ? '' : `#D-${day(offset)} `}task ${k}`)
                ingest(db, [{ concept: 'Garden', kind: 'page', aliases: [], text: lines.join('\n') }])
                const query = { concept: null, statuses: TASK_STATUSES, priorities: TASK_PRIORITY_FILTERS, due: window, groupBy: 'priority', today: TODAY } as const
                const fromIndex = tasksMatching(db, query, 0, 100).hits.map((hit) => hit.text.replace(/^#D-\S+ /, '')).sort()
                const fromPredicate = offsets
                    .map((offset, k) => ({ due: offset === null ? null : day(offset), text: `task ${k}` }))
                    .filter((task) => inDueWindow(task.due, window, TODAY))
                    .map((task) => task.text)
                    .sort()
                expect(fromIndex).toEqual(fromPredicate)
            }),
            fuzz(150),
        )
    })
})
