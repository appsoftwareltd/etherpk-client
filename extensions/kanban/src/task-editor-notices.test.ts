import type { NoticeOptions } from '@appsoftwareltd/etherpk-extension-api'
import { describe, expect, it } from 'vitest'

import { createInMemoryDocumentStore } from '#lib/document/in-memory-store.js'
import { rewriteTaskLine, taskLineWith } from '#lib/document/task-write.js'

import { taskEditorNotices } from './task-editor-notices'
import { deleteTask } from './task-editor-writes'

// The Task Editor opened outside a board (ADR 0170) has no board line to say what Archive and Delete
// did, so it says so in the Client's notices, with Undo on the notice.

const SHED = ['- [ ] #P1 Build the shed', '  - measure the floor', '- [ ] Water the beans'].join('\n')

function setUp(text = SHED) {
    const store = createInMemoryDocumentStore({ Garden: text })
    const said: Array<{ text: string; options?: NoticeOptions }> = []
    const notices = taskEditorNotices({ notify: (text, options) => void said.push({ text, options }), store: () => store })
    return { store, said, notices, undo: () => said.at(-1)!.options!.action!.run() }
}

describe('a task archived from the Task Editor outside a board', () => {
    it('is said with Undo, which puts its line back', async () => {
        const { store, said, notices, undo } = setUp()
        const outcome = await rewriteTaskLine(store, { concept: 'Garden', line: 0, expected: '- [ ] #P1 Build the shed' }, (line) => taskLineWith(line, { status: 'archived' }))
        if (!outcome.ok) throw new Error('not archived')
        notices.archived({ document: 'Garden', label: 'Build the shed', status: 'open', priority: 1, outcome })
        expect(said[0]).toMatchObject({ text: 'Archived "Build the shed". The Tasks view still lists it.', options: { action: { label: 'Undo' } } })
        await undo()
        expect(store.open('Garden').getText()).toBe(SHED)
        expect(said.at(-1)).toEqual({ text: 'Undone: "Build the shed" is as it was.', options: undefined })
    })

    it('says why an undo did nothing when the line changed since, and runs once', async () => {
        const { store, said, notices } = setUp()
        const outcome = await rewriteTaskLine(store, { concept: 'Garden', line: 0, expected: '- [ ] #P1 Build the shed' }, (line) => taskLineWith(line, { status: 'archived' }))
        if (!outcome.ok) throw new Error('not archived')
        notices.archived({ document: 'Garden', label: 'Build the shed', status: 'open', priority: 1, outcome })
        const run = said[0].options!.action!.run
        const doc = store.open('Garden')
        doc.applyChange({ from: 0, to: doc.getText().indexOf('\n'), insert: '- [x] #A Build the big shed' }, 'external')
        await run()
        expect(said.at(-1)!.text).toBe('Could not undo: "Build the shed" has changed since it was archived.')
        await run()
        expect(said).toHaveLength(2)
    })
})

describe('a task deleted from the Task Editor outside a board', () => {
    it('is said with Undo, which puts it back with everything nested under it', async () => {
        const { store, said, notices, undo } = setUp()
        const deleted = await deleteTask(store, { concept: 'Garden', line: 0, expected: '- [ ] #P1 Build the shed' })
        if (!deleted.ok) throw new Error('not deleted')
        notices.deleted(deleted.removed, 'Build the shed')
        expect(said[0]).toMatchObject({ text: 'Deleted "Build the shed" and everything nested under it.', options: { action: { label: 'Undo' } } })
        await undo()
        expect(store.open('Garden').getText()).toBe(SHED)
        expect(said.at(-1)!.text).toBe('Undone: "Build the shed" is back where it was.')
    })

    it('says why an undo did nothing when the lines around it changed since', async () => {
        const { store, said, notices, undo } = setUp()
        const deleted = await deleteTask(store, { concept: 'Garden', line: 0, expected: '- [ ] #P1 Build the shed' })
        if (!deleted.ok) throw new Error('not deleted')
        notices.deleted(deleted.removed, 'Build the shed')
        const doc = store.open('Garden')
        doc.applyChange({ from: 0, to: doc.getText().length, insert: '- Kitchen' }, 'external')
        await undo()
        expect(said.at(-1)!.text).toBe("Could not undo: the lines around \"Build the shed\" changed since it was deleted. Its text is still in the document's history.")
        expect(doc.getText()).toBe('- Kitchen')
    })
})
