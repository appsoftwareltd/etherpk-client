import { undo } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { createInMemoryDocumentStore } from '$lib/document/in-memory-store'
import { type HeadlessEditor, editorFixture } from '$lib/document/view/testing/editor-state-fixture'
import { createFilesystemDocumentStore } from '$lib/storage/fs/filesystem-store'
import { createMemoryDirectoryAdapter } from '$lib/storage/fs/memory-adapter'

import { addFrontmatterThroughEditor, addFrontmatterThroughStore, readForAddFrontmatter } from './add-frontmatter-service'

describe('addFrontmatterThroughStore', () => {
    it('writes only the block, carrying the registry’s aliases, and says where the caret goes', async () => {
        const store = Object.assign(createInMemoryDocumentStore({ Kanban: '- body [[X]]\n' }), {
            listDocuments: () => [{ key: 'kanban', aliases: ['Board'] }],
        })
        const added = await addFrontmatterThroughStore(store, 'Kanban', ['title', 'aliases', 'public'])
        expect(store.open('Kanban').getText()).toBe('---\ntitle: Kanban\naliases:\n  - Board\npublic: false\n---\n- body [[X]]\n')
        expect(added.line).toBe(1)
    })

    it('creates the page first when the document does not exist yet (a Draft)', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: () => 0 })
        await adapter.ensureSkeleton()
        const store = createFilesystemDocumentStore(adapter)
        await store.scan()
        await addFrontmatterThroughStore(store, 'Kanban', ['title', 'public', 'slug'])
        await store.flushDocument?.('Kanban')
        expect((await adapter.read('pages', 'Kanban.md')).text).toBe('---\ntitle: Kanban\npublic: false\nslug:\n---\n')
    })

    it('changes nothing when every key is there already', async () => {
        const text = '---\npublic: true\n---\n- body\n'
        const store = createInMemoryDocumentStore({ Kanban: text })
        const added = await addFrontmatterThroughStore(store, 'Kanban', ['public'])
        expect(added.caret).toBeNull()
        expect(store.open('Kanban').getText()).toBe(text)
    })
})

describe('readForAddFrontmatter', () => {
    it('reads the document’s text, or empty text for one that does not exist yet', async () => {
        const store = createInMemoryDocumentStore({ Kanban: '---\npublic: true\n---\n' })
        expect(await readForAddFrontmatter(store, 'Kanban')).toBe('---\npublic: true\n---\n')
        const adapter = createMemoryDirectoryAdapter({ now: () => 0 })
        await adapter.ensureSkeleton()
        const fs = createFilesystemDocumentStore(adapter)
        await fs.scan()
        expect(await readForAddFrontmatter(fs, 'Nothing Yet')).toBe('')
    })
})

describe('addFrontmatterThroughEditor', () => {
    it('is one transaction replacing only the block, with the caret on the first value added', () => {
        let state = EditorState.create({ doc: '---\nstatus: draft\n---\n- body\n' })
        const view = { get state() { return state }, dispatch: (spec: Parameters<EditorState['update']>[0]) => void (state = state.update(spec).state) }
        const added = addFrontmatterThroughEditor(view, 'Kanban', ['public', 'slug'], [])
        expect(state.doc.toString()).toBe('---\nstatus: draft\npublic: false\nslug:\n---\n- body\n')
        expect(state.selection.main.head).toBe(added.caret)
        expect(state.doc.toString().slice(0, state.selection.main.head)).toBe('---\nstatus: draft\npublic: false')
    })
})

describe('addFrontmatterThroughEditor, through the real editor stack', () => {
    function viewOf(editor: HeadlessEditor) {
        return { get state() { return editor.state }, dispatch: (spec: Parameters<EditorState['update']>[0]) => editor.dispatch(editor.state.update(spec)) }
    }

    it('passes the frontmatter guard for a new block and an added key, and one undo takes it back', () => {
        for (const before of ['- body|\n', '---\nstatus: draft\n---\n- body|\n']) {
            const editor = editorFixture(before)
            const original = editor.text()
            const added = addFrontmatterThroughEditor(viewOf(editor), 'Kanban', ['title', 'public'], [])
            expect(editor.text()).toBe(added.text)
            expect(editor.head()).toBe(added.caret)
            undo({ state: editor.state, dispatch: editor.dispatch })
            expect(editor.text()).toBe(original)
        }
    })

    it('is an undo step of its own: a value typed straight after it undoes first', () => {
        const editor = editorFixture('---\nstatus: draft\n---\n- body|\n')
        const original = editor.text()
        const added = addFrontmatterThroughEditor(viewOf(editor), 'Kanban', ['slug'], [])
        editor.type(' a-page')
        expect(editor.text()).toContain('slug: a-page\n')
        undo({ state: editor.state, dispatch: editor.dispatch })
        expect(editor.text()).toBe(added.text)
        undo({ state: editor.state, dispatch: editor.dispatch })
        expect(editor.text()).toBe(original)
    })
})
