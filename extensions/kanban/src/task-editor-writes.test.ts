import { describe, expect, it } from 'vitest'

import { createInMemoryDocumentStore } from '#lib/document/in-memory-store.js'
import { taskLineWith } from '#lib/document/task-write.js'

import { addComment, addDescriptionLine, deleteTask, readEditedTask, restoreTask, saveTaskLine } from './task-editor-writes'

// What the Task Editor writes (ADR 0170): every write starts from the task as the editor read it, and
// a task line that reads otherwise now is never written over.

const SHED = ['- [[Garden]]', '  - [ ] #P1 Build the shed #wood', '    - measure', '- Kitchen'].join('\n')
const task = { concept: 'Garden', line: 1, expected: '  - [ ] #P1 Build the shed #wood' }

describe('reading the task the editor opens on', () => {
    it('reads its fields, finding it by its words when lines were added above it', async () => {
        const store = createInMemoryDocumentStore({ Garden: `---\ntitle: Garden\n---\n- weed\n${SHED}` })
        const read = await readEditedTask(store, { document: 'Garden', line: 1, text: '#P1 Build the shed #wood' })
        expect(read).toMatchObject({
            ok: true,
            task: { concept: 'Garden', line: 2, expected: '  - [ ] #P1 Build the shed #wood' },
            fields: { title: 'Build the shed', status: 'open', priority: 1, freeTags: ['wood'], hasDescription: true, hasComments: false, hasAdditionalContext: false },
        })
    })

    it('says so when the task is not there any more', async () => {
        const store = createInMemoryDocumentStore({ Garden: '- Kitchen' })
        expect(await readEditedTask(store, { document: 'Garden', line: 1, text: 'Build the shed' })).toEqual({ ok: false, reason: 'stale' })
    })
})

describe('saving a field', () => {
    it('rewrites the task line while it reads as it was read', async () => {
        const store = createInMemoryDocumentStore({ Garden: SHED })
        const saved = await saveTaskLine(store, task, (line) => taskLineWith(line, { status: 'waiting' }))
        expect(saved).toMatchObject({ ok: true, task: { concept: 'Garden', line: 1, expected: '  - [ ] #P1 #W Build the shed #wood' } })
        expect(store.open('Garden').getText()).toContain('  - [ ] #P1 #W Build the shed #wood')
    })

    it('writes a due and a scheduled date into the tag run, in its order, and takes them out again', async () => {
        const store = createInMemoryDocumentStore({ Garden: SHED })
        const due = await saveTaskLine(store, task, (line) => taskLineWith(line, { due: '2026-11-09' }))
        if (!due.ok) throw new Error('not saved')
        const scheduled = await saveTaskLine(store, due.task, (line) => taskLineWith(line, { scheduled: '2026-11-05' }))
        if (!scheduled.ok) throw new Error('not saved')
        expect(store.open('Garden').getText()).toContain('  - [ ] #P1 #S-2026-11-05 #D-2026-11-09 Build the shed #wood')
        const read = await readEditedTask(store, { document: 'Garden', line: 1, text: '#P1 #S-2026-11-05 #D-2026-11-09 Build the shed #wood' })
        expect(read).toMatchObject({ ok: true, fields: { due: '2026-11-09', scheduled: '2026-11-05' } })
        const cleared = await saveTaskLine(store, scheduled.task, (line) => taskLineWith(line, { due: null }))
        expect(cleared).toMatchObject({ ok: true, task: { expected: '  - [ ] #P1 #S-2026-11-05 Build the shed #wood' } })
    })

    it('refuses, writing nothing, when the line was changed since', async () => {
        const store = createInMemoryDocumentStore({ Garden: SHED.replace('#P1', '#P2') })
        expect(await saveTaskLine(store, task, (line) => taskLineWith(line, { status: 'waiting' }))).toEqual({ ok: false, reason: 'stale' })
        expect(store.open('Garden').getText()).toBe(SHED.replace('#P1', '#P2'))
    })
})

describe('comments and the description', () => {
    it('adds a Task Comment, starting the Comments bullet', async () => {
        const store = createInMemoryDocumentStore({ Garden: SHED })
        expect(await addComment(store, task, 'ordered the timber')).toEqual({ ok: true })
        expect(store.open('Garden').getText()).toBe(['- [[Garden]]', '  - [ ] #P1 Build the shed #wood', '    - measure', '    - Comments', '      - ordered the timber', '- Kitchen'].join('\n'))
    })

    it('adds a Task Comment at the end of the Comments block, above the additional context after it', async () => {
        const text = ['- [ ] Build the shed', '  - measure', '  - Comments', '    - level', '  - paint it', '- Kitchen'].join('\n')
        const store = createInMemoryDocumentStore({ Garden: text })
        const read = await readEditedTask(store, { document: 'Garden', line: 0, text: 'Build the shed' })
        expect(read).toMatchObject({ ok: true, fields: { hasDescription: true, hasComments: true, hasAdditionalContext: true } })
        expect(await addComment(store, { concept: 'Garden', line: 0, expected: '- [ ] Build the shed' }, 'ordered the timber')).toEqual({ ok: true })
        expect(store.open('Garden').getText()).toBe(text.replace('    - level\n', '    - level\n    - ordered the timber\n'))
    })

    it('adds an empty description bullet under the task, above its comments', async () => {
        const store = createInMemoryDocumentStore({ Garden: '- [ ] Build the shed\n  - Comments\n    - level' })
        expect(await addDescriptionLine(store, { concept: 'Garden', line: 0, expected: '- [ ] Build the shed' })).toEqual({ ok: true })
        expect(store.open('Garden').getText()).toBe('- [ ] Build the shed\n  - \n  - Comments\n    - level')
    })
})

describe('deleting a task', () => {
    it('takes the task and its nested lines out, and an undo puts them back', async () => {
        const store = createInMemoryDocumentStore({ Garden: SHED })
        const deleted = await deleteTask(store, task)
        expect(deleted.ok).toBe(true)
        expect(store.open('Garden').getText()).toBe('- [[Garden]]\n- Kitchen')
        if (!deleted.ok) return
        expect(await restoreTask(store, deleted.removed)).toEqual({ ok: true })
        expect(store.open('Garden').getText()).toBe(SHED)
    })

    it('puts it back where it was after lines were added above', async () => {
        const store = createInMemoryDocumentStore({ Garden: SHED })
        const deleted = await deleteTask(store, task)
        if (!deleted.ok) throw new Error('not deleted')
        const doc = store.open('Garden')
        doc.applyChange({ from: 0, to: 0, insert: '- weed\n' }, 'external')
        expect(await restoreTask(store, deleted.removed)).toEqual({ ok: true })
        expect(doc.getText()).toBe(`- weed\n${SHED}`)
    })

    it('refuses an undo when the text around the task changed since', async () => {
        const store = createInMemoryDocumentStore({ Garden: SHED })
        const deleted = await deleteTask(store, task)
        if (!deleted.ok) throw new Error('not deleted')
        const doc = store.open('Garden')
        doc.applyChange({ from: 0, to: doc.getText().length, insert: '- Kitchen' }, 'external')
        expect(await restoreTask(store, deleted.removed)).toEqual({ ok: false, reason: 'stale' })
        expect(doc.getText()).toBe('- Kitchen')
    })
})
