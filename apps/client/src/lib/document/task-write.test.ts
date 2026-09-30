import { describe, expect, it } from 'vitest'

import type { TaskStatus } from './index-db'
import { createInMemoryDocumentStore } from './in-memory-store'
import { isTaskLine, locateTask, restoreTaskLine, taskLineWith, writeTaskChanges } from './task-write'
import type { DocumentStore } from './types'
import { DocumentNotFoundError } from './types'

// The writer a [[Kanban Board]] move and the Headless Client's `set_task` share (ADR 0113), and
// the line finder the Tasks View's tick uses as well.

/** One task in each status, written the way EtherPK writes a tag run: priority, state, dates. */
const IN: Record<TaskStatus, string> = {
    open: '  - [ ] #P2 #D-2026-10-01 Send the quote',
    doing: '  - [ ] #P2 #D #D-2026-10-01 Send the quote',
    waiting: '  - [ ] #P2 #W #D-2026-10-01 Send the quote',
    done: '  - [x] #P2 #D-2026-10-01 Send the quote',
    cancelled: '  - [x] #P2 #C #D-2026-10-01 Send the quote',
}

const STATUSES = Object.keys(IN) as TaskStatus[]

describe('taskLineWith: a status', () => {
    for (const from of STATUSES) {
        for (const to of STATUSES) {
            it(`moves a ${from} task to ${to}, keeping its priority, dates and text`, () => {
                expect(taskLineWith(IN[from], { status: to })).toBe(IN[to])
            })
        }
    }

    it('settles a task carrying two states into the one asked for', () => {
        // Waiting outranks doing in the index, so this task shows as Waiting.
        expect(taskLineWith('- [ ] #W #D Chase Bob', { status: 'doing' })).toBe('- [ ] #D Chase Bob')
        expect(taskLineWith('- [ ] #W #D Chase Bob', { status: 'open' })).toBe('- [ ] Chase Bob')
    })

    it('clears a state the checkbox contradicts', () => {
        // A tick in the editor leaves `#W` behind; the board shows the task as Done.
        expect(taskLineWith('- [x] #W Chase Bob', { status: 'done' })).toBe('- [x] Chase Bob')
    })
})

describe('taskLineWith: a priority', () => {
    it('adds, replaces and removes the priority tag', () => {
        expect(taskLineWith('- [ ] Send the quote', { priority: 1 })).toBe('- [ ] #P1 Send the quote')
        expect(taskLineWith('- [ ] #P3 Send the quote', { priority: 1 })).toBe('- [ ] #P1 Send the quote')
        expect(taskLineWith('- [ ] #P3 #W Send the quote', { priority: null })).toBe('- [ ] #W Send the quote')
    })

    it('changes the status and the priority in one line, as a drop into another lane and section does', () => {
        expect(taskLineWith('- [ ] #P3 Send the quote', { status: 'doing', priority: 1 })).toBe('- [ ] #P1 #D Send the quote')
    })
})

describe('taskLineWith: the rest of the line', () => {
    it('leaves indentation, other dates and every hash after the text alone', () => {
        expect(taskLineWith('    - [ ] #S-2026-10-02 #D-2026-10-05 #C-2026-09-01 Text [[Link]] #P1 trailing', { status: 'doing' })).toBe(
            '    - [ ] #D #S-2026-10-02 #D-2026-10-05 #C-2026-09-01 Text [[Link]] #P1 trailing',
        )
    })

    it('writes a changed tag run in the order the # helper writes it', () => {
        expect(taskLineWith('- [ ] #D-2026-10-01 #P2 Send the quote', { status: 'waiting' })).toBe('- [ ] #P2 #W #D-2026-10-01 Send the quote')
    })

    it('returns the line untouched when the task is already as asked, whatever order its tags are in', () => {
        const line = '- [ ] #D-2026-10-01 #P2 #W Send the quote'
        expect(taskLineWith(line, { status: 'waiting', priority: 2 })).toBe(line)
    })

    it('keeps a task with tags and no text free of a trailing space', () => {
        expect(taskLineWith('- [ ] #P1', { status: 'doing' })).toBe('- [ ] #P1 #D')
    })

    it('is null for a line that is not a task', () => {
        expect(taskLineWith('- a bullet', { status: 'done' })).toBeNull()
        expect(taskLineWith('Prose', { priority: 1 })).toBeNull()
    })
})

describe('locateTask', () => {
    it('keeps the indexed line when it still holds the task, whatever its tags now say', () => {
        const lines = ['- [ ] #W Send the quote', '- [ ] Other']
        expect(locateTask(lines, 0, '#P1 Send the quote')).toBe(0)
    })

    it('finds the task where it moved when its text is unique', () => {
        const lines = ['A line typed above', '- [ ] Other', '- [ ] #P1 Send the quote']
        expect(locateTask(lines, 1, '#P1 Send the quote')).toBe(2)
    })

    it('refuses when the text is on more than one task, since it cannot know which was meant', () => {
        const lines = ['A line typed above', '- [ ] Send the quote', '- [x] Send the quote']
        expect(locateTask(lines, 0, 'Send the quote')).toBeNull()
    })

    it('refuses when no task has the text any more', () => {
        expect(locateTask(['- [ ] Something else'], 0, 'Send the quote')).toBeNull()
        expect(locateTask(['- a bullet, no checkbox'], 0, 'a bullet, no checkbox')).toBeNull()
    })

    it('never takes a line inside a code fence, which is not a task', () => {
        const lines = ['- [ ] Moved away and renamed', '```md', '- [ ] Send the quote', '```']
        expect(locateTask(lines, 0, 'Send the quote')).toBeNull()
    })

    it('searches only from `from`, so frontmatter is never taken for the body', () => {
        const lines = ['---', 'title: x', '---', '- [ ] Send the quote']
        expect(locateTask(lines, 99, 'Send the quote', 3)).toBe(3)
        expect(locateTask(['- [ ] Send the quote', '---'], 99, 'Send the quote', 1)).toBeNull()
    })
})

describe('isTaskLine', () => {
    it('says whether a body line holds a task as the index reads one: never in fenced code, never past the end', () => {
        const text = ['---', 'title: A', '---', '- [ ] Send the quote', '```', '- [ ] not a task', '```', '- plain'].join('\n')
        expect(isTaskLine(text, 0)).toBe(true)
        expect(isTaskLine(text, 2)).toBe(false)
        expect(isTaskLine(text, 4)).toBe(false)
        expect(isTaskLine(text, 9)).toBe(false)
        expect(isTaskLine('- [ ] Only a body', 0)).toBe(true)
    })
})

describe('writeTaskChanges', () => {
    const task = (line: number, text: string) => ({ concept: 'Acme', line, text })

    it('writes the change into the document as the smallest edit, and says where the task is', async () => {
        const store = createInMemoryDocumentStore({ Acme: '# Acme\n- [ ] #P2 Send the quote\n- [ ] Other' })
        const edits: { from: number; to: number; insert: string }[] = []
        const inner = store.open('Acme')
        const spy: DocumentStore = {
            ...store,
            open: () => ({ ...inner, applyChange: (change, origin) => (edits.push(change), inner.applyChange(change, origin)) }),
        }

        const outcome = await writeTaskChanges(spy, task(1, '#P2 Send the quote'), { status: 'doing' })

        expect(outcome).toEqual({
            ok: true,
            line: 1,
            text: '#P2 #D Send the quote',
            changed: true,
            // The whole line either side of the write, which is what an undo puts back.
            before: '- [ ] #P2 Send the quote',
            after: '- [ ] #P2 #D Send the quote',
        })
        expect(store.open('Acme').getText()).toBe('# Acme\n- [ ] #P2 #D Send the quote\n- [ ] Other')
        // One edit, covering only what changed: the new tag and its space, after `- [ ] #P2 `.
        expect(edits).toEqual([{ from: 17, to: 17, insert: '#D ' }])
    })

    it('counts lines from the body, as the index does, on a page with frontmatter', async () => {
        const store = createInMemoryDocumentStore({ Acme: '---\ntitle: Acme\n---\n- [ ] Send the quote' })
        const outcome = await writeTaskChanges(store, task(0, 'Send the quote'), { status: 'done' })
        expect(outcome).toMatchObject({ ok: true, line: 0 })
        expect(store.open('Acme').getText()).toBe('---\ntitle: Acme\n---\n- [x] Send the quote')
    })

    it('writes to the task where it moved, and reports its new line', async () => {
        const store = createInMemoryDocumentStore({ Acme: 'Typed above\n- [ ] Other\n- [ ] Send the quote' })
        const outcome = await writeTaskChanges(store, task(1, 'Send the quote'), { priority: 1 })
        expect(outcome).toMatchObject({ ok: true, line: 2 })
        expect(store.open('Acme').getText()).toBe('Typed above\n- [ ] Other\n- [ ] #P1 Send the quote')
    })

    it('writes nothing and says so when it cannot tell which task was meant', async () => {
        const text = '- [ ] Send the quote\n- [ ] Send the quote'
        const store = createInMemoryDocumentStore({ Acme: text })
        expect(await writeTaskChanges(store, task(5, 'Send the quote'), { status: 'done' })).toEqual({ ok: false, reason: 'stale' })
        expect(store.open('Acme').getText()).toBe(text)
    })

    it('succeeds without writing when the task is already as asked', async () => {
        const store = createInMemoryDocumentStore({ Acme: '- [x] Send the quote' })
        expect(await writeTaskChanges(store, task(0, 'Send the quote'), { status: 'done' })).toEqual({
            ok: true,
            line: 0,
            text: 'Send the quote',
            changed: false,
            before: '- [x] Send the quote',
            after: '- [x] Send the quote',
        })
    })

    it('reports a document renamed or deleted since the index read it, rather than throwing', async () => {
        const store: DocumentStore = {
            open: () => {
                throw new DocumentNotFoundError('Acme')
            },
        }
        expect(await writeTaskChanges(store, task(0, 'Send the quote'), { status: 'done' })).toEqual({ ok: false, reason: 'missing' })
    })
})

describe('restoreTaskLine: putting back the line a move replaced', () => {
    const task = (line: number, text: string) => ({ concept: 'Acme', line, text })

    it('puts back the exact earlier line, tag order and all, while the line still reads what the move wrote', async () => {
        const store = createInMemoryDocumentStore({ Acme: '# Acme\n- [ ] #P2 #W #D-2026-10-01 Send the quote' })
        const outcome = await restoreTaskLine(
            store,
            task(1, '#P2 #W #D-2026-10-01 Send the quote'),
            '- [ ] #P2 #W #D-2026-10-01 Send the quote',
            '- [ ] #D-2026-10-01 #P2 Send the quote',
        )
        expect(outcome).toMatchObject({ ok: true, line: 1, text: '#D-2026-10-01 #P2 Send the quote', changed: true })
        expect(store.open('Acme').getText()).toBe('# Acme\n- [ ] #D-2026-10-01 #P2 Send the quote')
    })

    it('follows the task when lines have been added above it', async () => {
        const store = createInMemoryDocumentStore({ Acme: 'Typed above\n- [ ] #D Send the quote' })
        const outcome = await restoreTaskLine(store, task(0, '#D Send the quote'), '- [ ] #D Send the quote', '- [ ] Send the quote')
        expect(outcome).toMatchObject({ ok: true, line: 1 })
        expect(store.open('Acme').getText()).toBe('Typed above\n- [ ] Send the quote')
    })

    it('writes nothing when the line has changed since the move', async () => {
        const text = '- [ ] #D #P1 Send the quote'
        const store = createInMemoryDocumentStore({ Acme: text })
        const outcome = await restoreTaskLine(store, task(0, '#D Send the quote'), '- [ ] #D Send the quote', '- [ ] Send the quote')
        expect(outcome).toEqual({ ok: false, reason: 'stale' })
        expect(store.open('Acme').getText()).toBe(text)
    })
})
