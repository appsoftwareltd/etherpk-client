import { Transaction, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getNotices, resetNotices } from '$lib/activity/notices'
import { createCommandRegistry, createContributionRegistry, listCommandMenuItems } from '$lib/surface'

import { setActiveEditorView } from '../active-editor'
import type { TemplateEntry } from '../index-db'
import type { ConceptPickerRequest } from '../view/augmentations/concept-picker'
import { editorDocument } from '../view/editor-document'
import { type HeadlessEditor, editorFixture } from '../view/testing/editor-state-fixture'
import { registerTemplateCommands, TEMPLATE_INSERT, TEMPLATE_PICK, type TemplateCommandDeps } from './template-commands'

// `/Template` (ADR 0144): one Command Menu row opens a picker of the graph's Templates, and a pick
// copies the Template's body into the editor with its variables filled in.

const NOW = new Date(2026, 9, 14, 9, 30)

function activate(ed: HeadlessEditor): EditorView {
    const view = {
        get state() {
            return ed.state
        },
        dispatch: (spec: Transaction | TransactionSpec) => ed.dispatch(spec instanceof Transaction ? spec : ed.state.update(spec)),
        dom: { isConnected: true },
    } as unknown as EditorView
    setActiveEditorView(view)
    return view
}

function setup(overrides: Partial<TemplateCommandDeps> = {}) {
    const commands = createCommandRegistry()
    const contributions = createContributionRegistry()
    const picked: ConceptPickerRequest[] = []
    const deps: TemplateCommandDeps = {
        templates: async () => [],
        readTemplate: async () => null,
        journalTemplate: () => null,
        showPicker: (_view, request) => void picked.push(request),
        now: () => NOW,
        ...overrides,
    }
    registerTemplateCommands(commands, contributions, deps)
    const rows = (bodyWritable: boolean) => listCommandMenuItems(contributions, { inTable: false, tableInsertable: true, bodyWritable }).map((item) => item.title)
    return { commands, picked, rows }
}

const entries: TemplateEntry[] = [
    { concept: 'Daily Plan', firstLine: 'Morning' },
    { concept: 'Weekly Review', firstLine: '[[{{date}}]] review' },
]

beforeEach(() => resetNotices())
afterEach(() => setActiveEditorView(null))

describe('the Template row', () => {
    it('is offered where the body can be written, and hidden where it cannot', () => {
        const { rows } = setup()
        expect(rows(true)).toContain('Template')
        expect(rows(false)).not.toContain('Template')
    })
})

describe(TEMPLATE_PICK, () => {
    it('opens a picker of the graph’s Templates at the caret, the Journal Template labelled', async () => {
        const editor = editorFixture('- Garden\n- |')
        activate(editor)
        const { commands, picked } = setup({ templates: async () => entries, journalTemplate: () => 'daily plan' })

        await commands.execute(TEMPLATE_PICK)

        expect(picked).toHaveLength(1)
        expect(picked[0]).toMatchObject({
            pos: editor.head(),
            command: TEMPLATE_INSERT,
            rows: [
                { concept: 'Daily Plan', detail: 'Journal Template' },
                { concept: 'Weekly Review', detail: '[[{{date}}]] review' },
            ],
        })
    })

    it('says how to make a Template when the graph has none', async () => {
        activate(editorFixture('- |'))
        const { commands, picked } = setup()

        await commands.execute(TEMPLATE_PICK)

        expect(picked).toEqual([])
        const notice = getNotices().find((n) => n.id === 'templates')
        expect(notice?.text).toBe('This graph has no Templates yet. A page becomes a Template when its frontmatter says template: true.')
        expect(notice?.actions?.map((a) => a.label)).toEqual(['Read about Templates'])
    })

    it('does nothing when no editor is focused', async () => {
        const { commands, picked } = setup({ templates: async () => entries })
        await commands.execute(TEMPLATE_PICK)
        expect(picked).toEqual([])
    })
})

describe(TEMPLATE_INSERT, () => {
    it('copies the Template’s body in, with the variables filled in for the document it lands in', async () => {
        const editor = editorFixture('- Garden\n- |', { extensions: [editorDocument.of({ concept: 'Kitchen' })] })
        activate(editor)
        const readTemplate = vi.fn(async () => '- Review of [[{{title}}]] on [[{{date}}]]\n  - {{cursor}}')
        const { commands } = setup({ readTemplate })

        await commands.execute(TEMPLATE_INSERT, { concept: 'Weekly Review' })

        expect(readTemplate).toHaveBeenCalledWith('Weekly Review')
        expect(editor.fixture()).toBe('- Garden\n- Review of [[Kitchen]] on [[2026-10-14]]\n  - |')
    })

    it('reads the date from the journal entry it lands in', async () => {
        const editor = editorFixture('- |', { extensions: [editorDocument.of({ concept: '2026-10-19' })] })
        activate(editor)
        const { commands } = setup({ readTemplate: async () => '- [[{{yesterday}}]]' })

        await commands.execute(TEMPLATE_INSERT, { concept: 'Weekly Review' })

        expect(editor.text()).toBe('- [[2026-10-18]]')
    })

    it('says so, and changes nothing, when the page is no longer a Template', async () => {
        const editor = editorFixture('- |')
        activate(editor)
        const { commands } = setup({ readTemplate: async () => null })

        await commands.execute(TEMPLATE_INSERT, { concept: 'Weekly Review' })

        expect(editor.fixture()).toBe('- |')
        expect(getNotices().find((n) => n.id === 'templates')).toMatchObject({
            tone: 'error',
            text: '"Weekly Review" could not be inserted, because it is no longer a Template or could not be read.',
        })
    })

    it('copies the variables as written into a page that is itself a Template, so Templates compose', async () => {
        const editor = editorFixture('---\ntemplate: true\n---\n- |', { extensions: [editorDocument.of({ concept: 'Weekly Review' })] })
        activate(editor)
        const { commands } = setup({ readTemplate: async () => '- Plan for [[{{date}}]]\n  - {{cursor}}' })

        await commands.execute(TEMPLATE_INSERT, { concept: 'Daily Plan' })

        expect(editor.text()).toBe('---\ntemplate: true\n---\n- Plan for [[{{date}}]]\n  - {{cursor}}')
    })

    it('says so, and changes nothing, when the caret is in the frontmatter or a code block by the time the Template is read', async () => {
        for (const before of ['---\ntitle: Kitchen|\n---\n- body', '- note\n  ```\n  x|\n  ```']) {
            resetNotices()
            const editor = editorFixture(before)
            activate(editor)
            const { commands } = setup({ readTemplate: async () => '- Review' })

            await commands.execute(TEMPLATE_INSERT, { concept: 'Weekly Review' })

            expect(editor.fixture()).toBe(before)
            expect(getNotices().find((n) => n.id === 'templates')?.text).toBe('"Weekly Review" was not inserted, because the cursor is in the frontmatter or a code block. Move it out and try again.')
        }
    })

    it('leaves an editor alone that closed while the Template was read', async () => {
        const editor = editorFixture('- |')
        const view = activate(editor)
        const { commands } = setup({
            readTemplate: async () => {
                ;(view.dom as { isConnected: boolean }).isConnected = false
                return '- Review'
            },
        })

        await commands.execute(TEMPLATE_INSERT, { concept: 'Weekly Review' })

        expect(editor.text()).toBe('- ')
    })
})
