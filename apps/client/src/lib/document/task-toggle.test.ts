import { describe, expect, it } from 'vitest'

import { createInMemoryDocumentStore } from './in-memory-store'
import { toggleIndexedTask } from './task-toggle'
import type { DocumentStore, EditorDocument, TextChange } from './types'

/** A store over one in-memory document, applying range replacements for real. */
function storeOf(text: string): { store: DocumentStore; text: () => string } {
    let current = text
    const doc: EditorDocument = {
        id: 'Doc',
        getText: () => current,
        applyChange({ from, to, insert }: TextChange) {
            current = current.slice(0, from) + insert + current.slice(to)
        },
        subscribe: () => () => {},
    }
    return { store: { open: () => doc }, text: () => current }
}

const task = (line: number, text: string) => ({ concept: 'Doc', line, text })

describe('toggling an indexed task', () => {
    it('flips only the checkbox character, leaving the rest of the line byte for byte', async () => {
        const { store, text } = storeOf('# Notes\n  - [ ] #P1 Fix   the   redirect\n- other')
        const result = await toggleIndexedTask(store, task(1, '#P1 Fix   the   redirect'), true)

        expect(result).toEqual({ ok: true, done: true })
        expect(text()).toBe('# Notes\n  - [x] #P1 Fix   the   redirect\n- other')
    })

    it('unticks as well', async () => {
        const { store, text } = storeOf('- [x] done')
        await toggleIndexedTask(store, task(0, 'done'), false)
        expect(text()).toBe('- [ ] done')
    })

    it('refuses when the line has become a different task', async () => {
        // A line inserted above shifts every line number down: line 1 is still a valid task,
        // just not this one. Only the text comparison catches it.
        const { store, text } = storeOf('inserted\n- [ ] a different task\n- [ ] the real one')
        const before = text()

        expect(await toggleIndexedTask(store, task(1, 'the real one'), true)).toEqual({
            ok: false,
            reason: 'stale',
        })
        expect(text()).toBe(before)
    })

    it('refuses when the line is no longer a task at all', async () => {
        const { store, text } = storeOf('- just a bullet now')
        expect(await toggleIndexedTask(store, task(0, 'just a bullet now'), true)).toEqual({
            ok: false,
            reason: 'stale',
        })
        expect(text()).toBe('- just a bullet now')
    })

    it('refuses when the line no longer exists', async () => {
        const { store } = storeOf('- [ ] only one line')
        expect(await toggleIndexedTask(store, task(7, 'gone'), true)).toEqual({
            ok: false,
            reason: 'stale',
        })
    })

    it('is idempotent: a task already in the requested state is a success, not an error', async () => {
        const { store, text } = storeOf('- [x] already done')
        expect(await toggleIndexedTask(store, task(0, 'already done'), true)).toEqual({
            ok: true,
            done: true,
        })
        expect(text()).toBe('- [x] already done')
    })

    it('waits for a store that loads asynchronously before reading', async () => {
        const { store, text } = storeOf('- [ ] server backed')
        let readied = false
        const asyncStore: DocumentStore = {
            ...store,
            whenReady: async () => {
                readied = true
            },
        }
        await toggleIndexedTask(asyncStore, task(0, 'server backed'), true)
        expect(readied).toBe(true)
        expect(text()).toBe('- [x] server backed')
    })
})

describe('toggleIndexedTask on a page with frontmatter', () => {
    // The index derives over the body with frontmatter stripped, so its line numbers are
    // body-relative. The store hands back the whole file. A page - which carries frontmatter,
    // unlike a journal - was therefore refused as "stale" on every tick, because line 0 of the
    // file is `---`, not the task. Live: a #P1 task on a page called Kanban, ticked from the
    // Tasks view, wrote nothing.
    const text = '---\ntitle: Kanban\n---\n- [ ] #P1 TEst task\n- [ ] second'

    it('finds the task at its body-relative line and ticks it in the file', async () => {
        const store = createInMemoryDocumentStore({ Kanban: text })

        const result = await toggleIndexedTask(store, { concept: 'Kanban', line: 0, text: '#P1 TEst task' }, true)

        expect(result).toEqual({ ok: true, done: true })
        expect(store.open('Kanban').getText()).toBe('---\ntitle: Kanban\n---\n- [x] #P1 TEst task\n- [ ] second')
    })

    it('still refuses a line that is genuinely not that task any more', async () => {
        const store = createInMemoryDocumentStore({ Kanban: text })

        const result = await toggleIndexedTask(store, { concept: 'Kanban', line: 1, text: '#P1 TEst task' }, true)

        expect(result).toEqual({ ok: false, reason: 'stale' })
    })
})
