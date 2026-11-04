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
import { parseTaskLine, taskStatus } from './task-tags'

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
        // The case the "Filter to <active tab>" shortcut exists for.
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

describe("the scopes in a document's name (ADR 0051, amended 2026-09-29)", () => {
    // A project split across pages named for it - `[[Acme]] Website`, `[[Acme]] Hiring` - is the
    // project's work, and those pages are already Backlinks of Acme (ADR 0083). The scopes in a
    // document's name sit on the virtual root beside the document's own concept.
    beforeEach(() => {
        ingest(db, [
            page('Acme', '- [ ] Ship v2', ['ACME Corp']),
            page('[[Acme]] Website', '- [ ] Launch the new site'),
            page('[[[[Acme]] Website]] Launch', '- [ ] Book the photographer'),
            page('[[ACME Corp]] Hiring', '- [ ] Post the role'),
            page('Planning', ['- Work on [[[[Acme]] Website]]', '  - [ ] Draft the copy', '- Notes on [[ACME Corp]]', '  - [ ] Call the recruiter'].join('\n')),
            page('Unrelated', '- [ ] Not about Acme'),
        ])
    })

    it('lets a page named for a scope of the concept give it its tasks', () => {
        expect(texts(query({ concept: 'Acme' }))).toContain('Launch the new site')
    })

    it('counts a scope at every depth of the name', () => {
        expect(texts(query({ concept: 'Acme' }))).toContain('Book the photographer')
        expect(texts(query({ concept: '[[Acme]] Website' }))).toEqual(
            expect.arrayContaining(['Launch the new site', 'Book the photographer', 'Draft the copy']),
        )
    })

    it('counts a scope written as an alias for the page the alias names', () => {
        expect(texts(query({ concept: 'Acme' }))).toContain('Post the role')
    })

    it('counts the scope of a nested link on an ancestor, as it always has', () => {
        expect(texts(query({ concept: 'Acme' }))).toContain('Draft the copy')
    })

    it('finds a task written under an alias when the filter names the page', () => {
        expect(texts(query({ concept: 'Acme' }))).toContain('Call the recruiter')
    })

    it('still leaves out a page that names nothing of the concept', () => {
        expect(texts(query({ concept: 'Acme' }))).not.toContain('Not about Acme')
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
                    '- [ ] #T #W under test',
                    '- [ ] #A archived only when ticked',
                    '- [x] finished',
                    '- [x] #C dropped',
                    '- [x] #C #A put away',
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
            '#T #W under test',
            '#A archived only when ticked',
        ])
    })

    it('puts a task in exactly one state', () => {
        const counted = TASK_STATUSES.map((status) => texts(query({ statuses: [status] })).length)
        expect(counted.reduce((a, b) => a + b, 0)).toBe(9)
    })

    it('keeps a cancelled task out of done, so it is reachable rather than merely absent', () => {
        expect(texts(query({ statuses: ['done'] }))).toEqual(['finished'])
        expect(texts(query({ statuses: ['cancelled'] }))).toEqual(['#C dropped'])
    })

    it('puts a task under test in Test, and an archived one in Archived only when it is ticked', () => {
        expect(texts(query({ statuses: ['test'] }))).toEqual(['#T #W under test'])
        expect(texts(query({ statuses: ['waiting'] }))).toEqual(['#W waiting on someone', '#W #D waiting outranks doing'])
        expect(texts(query({ statuses: ['archived'] }))).toEqual(['#C #A put away'])
    })

    it('agrees with taskStatus, the rule the editor and the Headless Client read', () => {
        for (const status of TASK_STATUSES) {
            for (const text of texts(query({ statuses: [status] }))) {
                const task = parseTaskLine(`- [${status === 'done' || status === 'cancelled' || status === 'archived' ? 'x' : ' '}] ${text}`)!
                expect(taskStatus(task.done, task), text).toBe(status)
            }
        }
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

describe('ties the sort keys leave', () => {
    // A Kanban Board section is one status and one priority, ordered by due date (ADR 0113).
    // Whatever the date leaves tied must be something a person can see: the document's name,
    // then the task's place in it. The index's page ids decided it before, and a folder graph
    // re-derives with fresh page ids on any file change, so equal cards could swap places.
    beforeEach(() => {
        // Zulu is ingested first, so it has the lower page id.
        ingest(db, [
            page('Zulu', '- [ ] zulu undated\n- [ ] #D-2026-09-05 zulu due'),
            page('Alpha', '- [ ] alpha undated first\n- [ ] alpha undated second\n- [ ] #D-2026-09-05 alpha due'),
        ])
    })

    it('breaks a tie by document name, then by line, never by the order documents were indexed', () => {
        expect(texts(query({ groupBy: 'due' }))).toEqual([
            '#D-2026-09-05 alpha due',
            '#D-2026-09-05 zulu due',
            'alpha undated first',
            'alpha undated second',
            'zulu undated',
        ])
    })
})

describe('ordering by Free Tag, as a Kanban Board section does (ADR 0166)', () => {
    beforeEach(() => {
        ingest(db, [
            page('Shed', ['- [ ] Oil the hinge', '- [ ] Paint the door #paint', '- [ ] #D-2026-09-03 Fix the gate #bug'].join('\n')),
            page('Garden', ['- [ ] Water the beans #Bug', '- [ ] Dig the bed', '- [ ] #bug #D-2026-09-02 Mend the fence #paint'].join('\n')),
            page('2026-08-30', ['- [ ] Sweep the path #bug', '- [ ] Rake the leaves'].join('\n')),
            page('2026-08-29', ['- [ ] Sharpen the saw #paint'].join('\n')),
        ])
    })

    it('groups by the first Free Tag A–Z ignoring case, untagged last, then soonest due, then journals oldest first and pages A–Z', () => {
        expect(texts(query({ groupBy: 'due', byFreeTag: true }))).toEqual([
            // bug: due first, then undated by document (journals before pages)
            '#bug #D-2026-09-02 Mend the fence #paint',
            '#D-2026-09-03 Fix the gate #bug',
            'Sweep the path #bug',
            'Water the beans #Bug',
            // paint
            'Sharpen the saw #paint',
            'Paint the door #paint',
            // untagged
            'Rake the leaves',
            'Dig the bed',
            'Oil the hinge',
        ])
    })

    it('leaves the order alone when not asked', () => {
        expect(texts(query({ groupBy: 'due' }))[0]).toBe('#bug #D-2026-09-02 Mend the fence #paint')
        expect(texts(query({ groupBy: 'due' }))[2]).toBe('Sharpen the saw #paint')
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

    it('names the nearest task above a subtask, tag run and all, and nothing for a task under no task', () => {
        ingest(db, [
            page('Acme', ['- [ ] #P1 Launch site', '  - Notes', '    - [ ] Hear back on the API', '- Call with Bob', '  - [ ] Send the quote'].join('\n')),
        ])
        const hits = tasksMatching(db, query({ concept: 'Acme' }), 0, 10).hits
        const parentOf = (text: string) => hits.find((hit) => hit.text === text)?.parentTask
        expect(parentOf('Hear back on the API')).toBe('#P1 Launch site')
        expect(parentOf('Send the quote')).toBeNull()
        expect(parentOf('#P1 Launch site')).toBeNull()
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

describe('a board-shaped query (asBoard, ADR 0174)', () => {
    const board = (concept: string | null) => texts(query({ concept, asBoard: true, groupBy: 'document' }))

    it('leaves out a subtask whose parent is on the board, at any depth and through plain bullets, and counts what it leaves', () => {
        ingest(db, [
            page(
                'Acme',
                ['- [ ] Build the shed', '  - measure the floor', '  - [ ] Cut the timber', '    - Notes', '      - [ ] Sharpen the saw', '- [ ] Paint the gate'].join('\n'),
            ),
        ])
        expect(board('Acme')).toEqual(['Build the shed', 'Paint the gate'])
        expect(tasksMatchingCount(db, query({ concept: 'Acme', asBoard: true }))).toBe(2)
        // The Tasks View's query lists every one of them.
        expect(texts(query({ concept: 'Acme', groupBy: 'document' }))).toHaveLength(4)
    })

    it('keeps a subtask whose parent does not answer to the concept, and hides what is under that subtask', () => {
        ingest(db, [page('Planning', ['- [ ] Plan the week', '  - [ ] [[Garden]] water the beans', '    - [ ] fill the can'].join('\n'))])
        expect(board('Garden')).toEqual(['[[Garden]] water the beans'])
        expect(board('Planning')).toEqual(['Plan the week'])
    })

    it('hides what is under a task linking the concept on its own line: one card, no exception', () => {
        ingest(db, [page('Planning', ['- [[Projects]]', '  - [ ] [[Acme]]', '    - [ ] #P1 Paint the gate', '      - [ ] Buy the paint'].join('\n'))])
        expect(board('Acme')).toEqual(['[[Acme]]'])
        expect(board('Projects')).toEqual(['[[Acme]]'])
    })

    it('counts a parent as on the board by any of its concept\'s names', () => {
        ingest(db, [page('Acme Rebuild', '', ['Acme']), page('Planning', ['- [ ] [[Acme]] Paint the gate', '  - [ ] Buy the paint'].join('\n'))])
        expect(board('Acme Rebuild')).toEqual(['[[Acme]] Paint the gate'])
        expect(board('acme')).toEqual(['[[Acme]] Paint the gate'])
    })

    it('shows a subtask whose parent is Archived, and leaves one out whatever lane its parent is in', () => {
        ingest(
            db,
            [page('Acme', ['- [x] #A Print the flyers', '  - [ ] Fold the flyers', '- [x] #C Book the hall', '  - [ ] Ring the hall', '- [x] Pick a date', '  - [ ] Check the date'].join('\n'))],
        )
        expect(texts(query({ concept: 'Acme', asBoard: true, statuses: ['open'] }))).toEqual(['Fold the flyers'])
    })

    it('leaves out every subtask on the Graph Kanban, whose board holds every task', () => {
        ingest(db, [page('Planning', ['- [ ] Plan the week', '  - [ ] [[Garden]] water the beans', '- [ ] Buy milk'].join('\n'))])
        expect(board(null)).toEqual(['Plan the week', 'Buy milk'])
    })
})

describe('what a task hit says about what is around it (ADR 0174)', () => {
    const hitFor = (text: string, concept: string | null = null) => tasksMatching(db, query({ concept }), 0, 100).hits.find((hit) => hit.text === text)!

    it('names the nearest concept linked on an ancestor, leaving out the task\'s own line', () => {
        ingest(db, [page('Planning', ['- [[Projects]]', '  - [[Acme]]', '    - [ ] Paint the gate', '    - [ ] [[Garden]] Water the beans'].join('\n'))])
        expect(hitFor('Paint the gate', 'Projects').ancestorConcept).toBe('Acme')
        expect(hitFor('[[Garden]] Water the beans', 'Projects').ancestorConcept).toBe('Acme')
    })

    it('names no concept when the nearest is the one asked about, by any of its names', () => {
        ingest(db, [page('Acme Rebuild', '', ['Acme']), page('Planning', ['- [[Projects]]', '  - [[Acme]]', '    - [ ] Paint the gate'].join('\n'))])
        expect(hitFor('Paint the gate', 'Acme Rebuild').ancestorConcept).toBeNull()
        expect(hitFor('Paint the gate', 'acme').ancestorConcept).toBeNull()
        // Not the next one out: the nearest is what the task sits in.
        expect(hitFor('Paint the gate', 'Projects').ancestorConcept).toBe('Acme')
    })

    it('names no concept when the nearest is the document the task is in, or there is none', () => {
        ingest(db, [page('Acme', ['- [[Acme]]', '  - [ ] Paint the gate', '- [ ] Buy milk'].join('\n'), ['Rebuild']), page('Shed', ['- [[Rebuild]]', '  - [ ] Cut the timber'].join('\n'))])
        expect(hitFor('Paint the gate').ancestorConcept).toBeNull()
        expect(hitFor('Buy milk').ancestorConcept).toBeNull()
        expect(hitFor('Cut the timber').ancestorConcept).toBe('Rebuild')
    })

    it('takes the first concept written when a line links two, and reads a heading as an ancestor', () => {
        ingest(db, [page('Planning', ['- [[Acme]] with [[Garden]]', '  - [ ] Paint the gate', '# Work on [[Shed]]', '- [ ] Cut the timber'].join('\n'))])
        expect(hitFor('Paint the gate').ancestorConcept).toBe('Acme')
        expect(hitFor('Cut the timber').ancestorConcept).toBe('Shed')
    })

    it('counts every nested task at any depth: Done and Cancelled are finished, Archived left out', () => {
        ingest(
            db,
            [
                page(
                    'Acme',
                    ['- [ ] Build the shed', '  - [x] Cut the timber', '    - [ ] Sharpen the saw', '  - Notes', '    - [x] #C Hire a van', '  - [x] #A Old idea', '  - [ ] Fix the roof', '- [ ] Buy milk'].join('\n'),
                ),
            ],
        )
        expect(hitFor('Build the shed').subtasks).toEqual({ done: 2, total: 4 })
        expect(hitFor('Cut the timber').subtasks).toEqual({ done: 0, total: 1 })
        expect(hitFor('Buy milk').subtasks).toEqual({ done: 0, total: 0 })
    })

    it('gives the line of the task above a subtask', () => {
        ingest(db, [page('Acme', ['- Heading bullet', '  - [ ] Build the shed', '    - Notes', '      - [ ] Cut the timber'].join('\n'))])
        expect(hitFor('Cut the timber').parentTaskLine).toBe(1)
        expect(hitFor('Build the shed').parentTaskLine).toBeNull()
    })
})

describe('a title filter (titleContains)', () => {
    const matching = (titleContains: string, overrides: Partial<TaskQuery> = {}) => texts(query({ titleContains, groupBy: 'document', ...overrides }))

    beforeEach(() => {
        ingest(db, [page('Acme', ['- [ ] #P1 Paint the Gate #bug', '  - [ ] Buy the paint', '- [ ] Fix 100% of the hinges', '- [ ] Oil the gate_post', '- [ ] Sweep'].join('\n'))])
    })

    it('matches the words of the task line, ignoring case and the space around what is typed', () => {
        expect(matching('  GATE ')).toEqual(['#P1 Paint the Gate #bug', 'Oil the gate_post'])
        expect(tasksMatchingCount(db, query({ titleContains: 'gate' }))).toBe(2)
    })

    it('reads no tag as words: not the tag run, and not a Free Tag', () => {
        expect(matching('p1')).toEqual([])
        expect(matching('bug')).toEqual([])
    })

    it('takes what is typed literally, so % and _ are not wildcards', () => {
        expect(matching('100%')).toEqual(['Fix 100% of the hinges'])
        expect(matching('gate_')).toEqual(['Oil the gate_post'])
        expect(matching('%')).toEqual(['Fix 100% of the hinges'])
    })

    it('does not read what is nested under a task: its card is not shown for a subtask\'s words', () => {
        expect(matching('buy', { asBoard: true })).toEqual([])
    })

    it('leaves every task in when nothing but spaces is typed', () => {
        expect(matching('   ')).toHaveLength(5)
    })
})
