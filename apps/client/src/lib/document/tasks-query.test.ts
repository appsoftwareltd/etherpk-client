import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
    createSchema,
    type IndexDoc,
    ingest,
    OPEN_TASK_STATUSES,
    type SqlDb,
    TASK_PRIORITY_FILTERS,
    TASK_STATUSES,
    type TaskQuery,
    tasksMatching,
    tasksMatchingCount,
} from './index-db'
import { wrapOo1Db } from './index-db-sqlite'

// The [[Tasks View]]'s query, against a real in-memory sqlite-wasm DB (ADR 0015).
// This is where ADR 0051's Task Concept rules are actually pinned down.

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>

beforeAll(async () => {
    sqlite3 = await sqlite3InitModule()
})

let db: SqlDb

beforeEach(() => {
    db = wrapOo1Db(new sqlite3.oo1.DB(':memory:'))
    createSchema(db)
})

const TODAY = '2026-09-01'

/** Everything, so each test narrows only the axis it is about. */
function query(overrides: Partial<TaskQuery> = {}): TaskQuery {
    return {
        concept: null,
        statuses: TASK_STATUSES,
        priorities: TASK_PRIORITY_FILTERS,
        due: 'any',
        groupBy: 'priority',
        today: TODAY,
        ...overrides,
    }
}

function texts(q: TaskQuery = query()): string[] {
    return tasksMatching(db, q, 0, 100).hits.map((hit) => hit.text)
}

function page(concept: string, text: string, aliases: string[] = []): IndexDoc {
    return { concept, kind: 'page', aliases, text }
}

describe('Task Concept relatedness (ADR 0051)', () => {
    beforeEach(() => {
        ingest(db, [
            page(
                '2026-09-01',
                [
                    '# Work on [[Acme Rebuild]]',
                    '- [[Acme Rebuild]] planning',
                    '  - [ ] #P1 Fix the login redirect',
                    '  - Notes from standup',
                    '    - [ ] #W Chase [[Bob]] for the API key',
                    '- [ ] Email [[Acme Rebuild]] invoice',
                    '- [ ] Buy milk',
                ].join('\n'),
            ),
            page('Acme Rebuild', '- [ ] #P1 Ship v2', ['Acme']),
            page('Unrelated', '- [ ] Nothing to do with anything'),
        ])
    })

    it('matches through the immediate parent, a distant ancestor, and the task line itself', () => {
        const hits = texts(query({ concept: 'Acme Rebuild' }))
        expect(hits).toContain('#P1 Fix the login redirect') // immediate parent bullet
        expect(hits).toContain('#W Chase [[Bob]] for the API key') // grandparent bullet
        expect(hits).toContain('Email [[Acme Rebuild]] invoice') // its own line
    })

    it('lets a heading claim every task in its section, including unrelated-looking ones', () => {
        // The load-bearing consequence of decision 2: `# Work on [[Acme]]` IS an ancestor.
        expect(texts(query({ concept: 'Acme Rebuild' }))).toContain('Buy milk')
    })

    it("treats a document's own concept as a virtual root, with no self-link written", () => {
        // The case the "Use <active tab>" shortcut exists for.
        expect(texts(query({ concept: 'Acme Rebuild' }))).toContain('#P1 Ship v2')
    })

    it('does not sweep in tasks from documents that never mention the concept', () => {
        expect(texts(query({ concept: 'Acme Rebuild' }))).not.toContain('Nothing to do with anything')
    })

    it('pools over aliases in both directions', () => {
        // 'Acme' is an alias of the Acme Rebuild page; filtering by it must find tasks
        // written against the canonical name, and the page's own tasks.
        const viaAlias = texts(query({ concept: 'Acme' }))
        expect(viaAlias).toContain('#P1 Fix the login redirect')
        expect(viaAlias).toContain('#P1 Ship v2')
    })

    it('is case-insensitive, like every other concept identity (ADR 0011)', () => {
        expect(texts(query({ concept: 'acme rebuild' }))).toContain('#P1 Fix the login redirect')
    })

    it('filters to a Pageless Concept, which has tasks but no page', () => {
        // [[Bob]] is referenced and never created — it still answers for the task under it.
        expect(texts(query({ concept: 'Bob' }))).toEqual(['#W Chase [[Bob]] for the API key'])
    })

    it('returns every task in the graph when no name is selected', () => {
        expect(texts()).toHaveLength(6)
    })
})

describe('task status partition', () => {
    beforeEach(() => {
        ingest(db, [
            page(
                'States',
                [
                    '- [ ] plain open',
                    '- [ ] #D in progress',
                    '- [ ] #W waiting on someone',
                    '- [ ] #W #D waiting outranks doing',
                    '- [x] finished',
                    '- [x] #C dropped',
                ].join('\n'),
            ),
        ])
    })

    it('defaults to everything that is not finished', () => {
        expect(texts(query({ statuses: OPEN_TASK_STATUSES }))).toEqual([
            'plain open',
            '#D in progress',
            '#W waiting on someone',
            '#W #D waiting outranks doing',
        ])
    })

    it('puts a task in exactly one state', () => {
        const counted = TASK_STATUSES.map((status) => texts(query({ statuses: [status] })).length)
        expect(counted.reduce((a, b) => a + b, 0)).toBe(6)
    })

    it('keeps a cancelled task out of done, so it is reachable rather than merely absent', () => {
        expect(texts(query({ statuses: ['done'] }))).toEqual(['finished'])
        expect(texts(query({ statuses: ['cancelled'] }))).toEqual(['#C dropped'])
    })

    it('shows nothing when every status chip is off — a genuine empty selection', () => {
        expect(texts(query({ statuses: [] }))).toEqual([])
        expect(tasksMatchingCount(db, query({ statuses: [] }))).toBe(0)
    })
})

describe('priority and due filtering', () => {
    beforeEach(() => {
        ingest(db, [
            page(
                'Dated',
                [
                    '- [ ] #P1 #D-2026-08-20 overdue',
                    '- [ ] #P2 #D-2026-09-01 due today',
                    '- [ ] #P3 #D-2026-09-05 due this week',
                    '- [ ] #D-2026-10-30 due next month',
                    '- [ ] no dates at all',
                ].join('\n'),
            ),
        ])
    })

    it('selects priority levels, with "no priority" a real bucket of its own', () => {
        expect(texts(query({ priorities: [1] }))).toEqual(['#P1 #D-2026-08-20 overdue'])
        expect(texts(query({ priorities: [null] }))).toEqual([
            '#D-2026-10-30 due next month',
            'no dates at all',
        ])
    })

    it('windows on the due date relative to the supplied today', () => {
        expect(texts(query({ due: 'overdue' }))).toEqual(['#P1 #D-2026-08-20 overdue'])
        expect(texts(query({ due: 'today' }))).toEqual(['#P2 #D-2026-09-01 due today'])
        expect(texts(query({ due: 'next7' }))).toEqual([
            '#P2 #D-2026-09-01 due today',
            '#P3 #D-2026-09-05 due this week',
        ])
    })

    it('never counts an undated task as due', () => {
        for (const due of ['overdue', 'today', 'next7'] as const) {
            expect(texts(query({ due }))).not.toContain('no dates at all')
        }
    })
})

describe('ordering, grouping and paging', () => {
    beforeEach(() => {
        ingest(db, [
            page('Beta', '- [ ] #P2 beta second\n- [ ] #P1 beta first'),
            page('Alpha', '- [ ] #P3 alpha third\n- [ ] #D-2026-09-02 alpha dated'),
        ])
    })

    it('orders by the group key first, so the view can group by walking the rows', () => {
        expect(texts(query({ groupBy: 'priority' }))).toEqual([
            '#P1 beta first',
            '#P2 beta second',
            '#P3 alpha third',
            '#D-2026-09-02 alpha dated',
        ])
        // Within Beta both tasks are undated, so the second sort key decides: P1 before P2.
        expect(texts(query({ groupBy: 'document' }))).toEqual([
            '#D-2026-09-02 alpha dated',
            '#P3 alpha third',
            '#P1 beta first',
            '#P2 beta second',
        ])
    })

    it('sorts undated tasks after dated ones rather than first, as SQLite would', () => {
        expect(texts(query({ groupBy: 'due' }))[0]).toBe('#D-2026-09-02 alpha dated')
    })

    it('pages with a total order, so nothing repeats or is skipped', () => {
        const all = texts()
        const first = tasksMatching(db, query(), 0, 2)
        const second = tasksMatching(db, query(), 2, 2)
        expect(first.hasMore).toBe(true)
        expect(second.hasMore).toBe(false)
        expect([...first.hits, ...second.hits].map((h) => h.text)).toEqual(all)
    })

    it('counts every match, not just the page', () => {
        expect(tasksMatchingCount(db, query())).toBe(4)
        expect(tasksMatching(db, query(), 0, 2).hits).toHaveLength(2)
    })
})

describe('the task row', () => {
    it('carries the ancestry breadcrumb that explains why it matched', () => {
        ingest(db, [
            page(
                '2026-09-01',
                ['# Work on [[Acme]]', '- planning', '  - [ ] #P1 Fix the login redirect'].join('\n'),
            ),
        ])
        const hit = tasksMatching(db, query({ concept: 'Acme' }), 0, 10).hits[0]
        expect(hit.breadcrumb).toEqual(['Work on [[Acme]]', 'planning'])
        expect(hit.concept).toBe('2026-09-01')
        expect(hit.line).toBe(2)
        expect(hit.priority).toBe(1)
    })

    it('omits tasks inside an encrypted block entirely', () => {
        ingest(db, [
            page(
                'Secret',
                ['- [ ] visible task', '```etherpk-cipher', '- [ ] hidden task', '```'].join('\n'),
            ),
        ])
        expect(texts()).toEqual(['visible task'])
    })
})
