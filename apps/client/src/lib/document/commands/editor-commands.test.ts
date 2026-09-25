import type { TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import { setActiveEditorView } from '../active-editor'
import { setActiveProtectionStatus } from '../protection/active-protection'
import { isProtectedDocumentFacet } from '../view/augmentations/protected-fence'
import { tableSizePicker, tableSizePickerState } from '../view/augmentations/table-size-picker'
import { type HeadlessEditor, editorFixture } from '../view/testing/editor-state-fixture'

import {
    createCommandRegistry,
    createContributionRegistry,
    listCommandBarItems,
    listCommandMenuItems,
} from '../../surface'
import { getNotices, resetNotices } from '$lib/activity/notices'

import { isSpellCheckEnabled, setSpellCheckEnabled } from '../spell-check-preference'
import { registerEditorCommands, slashInsertText } from './editor-commands'

/** A headless editor as the active view: the Commands only read `state` and call `dispatch`. */
function activate(ed: HeadlessEditor): () => void {
    const view = {
        get state() {
            return ed.state
        },
        dispatch: (spec: TransactionSpec) => ed.dispatch(ed.state.update(spec)),
    } as unknown as EditorView
    setActiveEditorView(view)
    return () => setActiveEditorView(null)
}

describe('slashInsertText (Command Bar slash button)', () => {
    it('inserts a bare "/" at the start of a line', () => {
        expect(slashInsertText('')).toBe('/')
    })

    it('inserts a bare "/" right after whitespace (already a word boundary)', () => {
        expect(slashInsertText(' ')).toBe('/')
        expect(slashInsertText('\t')).toBe('/')
    })

    it('prepends a space when the caret sits right after a word char', () => {
        // The common mobile case: finishing "Lunch" then tapping the slash button.
        expect(slashInsertText('h')).toBe(' /')
        expect(slashInsertText(')')).toBe(' /')
    })
})

describe('registerEditorCommands — asset.upload', () => {
    it('registers the command, a Command Menu item, and a Command Bar button', () => {
        const commands = createCommandRegistry()
        const contributions = createContributionRegistry()
        const teardown = registerEditorCommands(commands, contributions)

        expect(commands.has('asset.upload')).toBe(true)

        const menu = listCommandMenuItems(contributions, { inTable: false, tableInsertable: true, bodyWritable: true })
        const upload = menu.find((i) => i.id === 'asset.upload')
        expect(upload).toMatchObject({ command: 'asset.upload', group: 'Asset' })
        expect(upload?.keywords).toContain('image')

        const bar = listCommandBarItems(contributions)
        expect(bar.find((b) => b.id === 'asset.upload')?.command).toBe('asset.upload')

        teardown()
        expect(commands.has('asset.upload')).toBe(false)
    })
})

describe('registerEditorCommands — mobile wikilink shortcuts', () => {
    it('registers open and close bracket commands near the start of the Command Bar', () => {
        const commands = createCommandRegistry()
        const contributions = createContributionRegistry()
        const teardown = registerEditorCommands(commands, contributions)

        expect(commands.has('editor.insertWikilinkOpen')).toBe(true)
        expect(commands.has('editor.insertWikilinkClose')).toBe(true)
        // The task toggle sits right after the wikilink pair, then undo and redo: the strip
        // scrolls on a phone, and buried among the block ops these were off-screen exactly when
        // someone was on a task, or had just made a mistake.
        const fixed = listCommandBarItems(contributions).filter((b) => !b.contextualGroup)
        expect(fixed.slice(0, 7)).toMatchObject([
            { command: 'editor.openCommandMenu' },
            { command: 'editor.insertWikilinkOpen', label: 'Insert [[' },
            { command: 'editor.insertWikilinkClose', label: 'Insert ]]' },
            { command: 'editor.toggleTask', taskToggleOnly: true },
            { command: 'editor.undo', undoOnly: true, writableOnly: true },
            { command: 'editor.redo', redoOnly: true, writableOnly: true },
            { command: 'asset.upload' },
        ])

        teardown()
        expect(commands.has('editor.insertWikilinkOpen')).toBe(false)
        expect(commands.has('editor.insertWikilinkClose')).toBe(false)
    })

    /** Run one bracket Command over a fixture and return the result in fixture notation. */
    async function tap(fixture: string, id: string): Promise<string> {
        const commands = createCommandRegistry()
        const teardown = registerEditorCommands(commands, createContributionRegistry())
        const ed = editorFixture(fixture)
        const deactivate = activate(ed)
        try {
            await commands.execute(id)
            return ed.fixture()
        } finally {
            deactivate()
            teardown()
        }
    }

    it('over a selection either button makes the whole wikilink at once and keeps the word selected', async () => {
        // The wrap key's decision on a phone (ADR 0077): where two presses of `[` end, so the
        // completion opens on the word. The closing button wraps too, because a selection is fiddly
        // to make on a phone and replacing it with `]]` is never what was wanted.
        expect(await tap('- the «fox» jumped', 'editor.insertWikilinkOpen')).toBe('- the [[«fox»]] jumped')
        expect(await tap('- the «fox» jumped', 'editor.insertWikilinkClose')).toBe('- the [[«fox»]] jumped')
        expect(await tap('# How «Desktop CRM» fits', 'editor.insertWikilinkOpen')).toBe('# How [[«Desktop CRM»]] fits')
        // `]]` over the word `[[` has just enclosed finishes the link rather than stacking a layer.
        expect(await tap('- the [[«fox»]] jumped', 'editor.insertWikilinkClose')).toBe('- the [[fox]]| jumped')
    })

    it('with nothing selected the buttons type their brackets, as before', async () => {
        expect(await tap('- the fox|', 'editor.insertWikilinkOpen')).toBe('- the fox[[|')
        expect(await tap('- the [[fox|', 'editor.insertWikilinkClose')).toBe('- the [[fox]]|')
    })

    it('a selection the wrap rule refuses (across lines, in the frontmatter) is typed over, as before', async () => {
        expect(await tap('one «two\nthree» four', 'editor.insertWikilinkOpen')).toBe('one [[| four')
        expect(await tap('---\ntitle: «x»\n---\n', 'editor.insertWikilinkOpen')).toBe('---\ntitle: [[|\n---\n')
    })
})

describe('registerEditorCommands — table edits inside a bullet', () => {
    async function run(fixture: string, id: string, arg?: unknown): Promise<string> {
        const commands = createCommandRegistry()
        const teardown = registerEditorCommands(commands, createContributionRegistry())
        // `^` marks the caret: `|` is a table cell boundary here.
        const ed = editorFixture(fixture, { caret: '^' })
        const deactivate = activate(ed)
        try {
            await commands.execute(id, arg)
            return ed.text()
        } finally {
            deactivate()
            teardown()
        }
    }

    it("rewrites a bullet's table after its marker, with the rows at the content column", async () => {
        const out = await run('- | a | b |\n  | - | - |\n  | 1 | 2^ |', 'table.addRow')
        expect(out).toBe(['- | a   | b   |', '  | --- | --- |', '  | 1   | 2   |', '  |     |     |'].join('\n'))
    })

    it('keeps a task marker in place and still indents the rows to the content column', async () => {
        const out = await run('- [ ] | a | b |\n  | - | - |\n  | 1^ | 2 |', 'table.format')
        expect(out).toBe(['- [ ] | a   | b   |', '  | --- | --- |', '  | 1   | 2   |'].join('\n'))
    })

    it('leaves a plain table at its own indent', async () => {
        const out = await run('  | a | b |\n  | - | - |\n  | 1^ | 2 |', 'table.format')
        expect(out).toBe(['  | a   | b   |', '  | --- | --- |', '  | 1   | 2   |'].join('\n'))
    })

    /** Run a table edit and return the document with `^` at the caret. */
    async function runWithCaret(fixture: string, id: string): Promise<string> {
        const commands = createCommandRegistry()
        const teardown = registerEditorCommands(commands, createContributionRegistry())
        const ed = editorFixture(fixture, { caret: '^' })
        const deactivate = activate(ed)
        try {
            await commands.execute(id)
            return ed.fixture()
        } finally {
            deactivate()
            teardown()
        }
    }

    it('leaves the caret in the same cell after an edit, at the start of its content', async () => {
        // Add column after column 0: the caret stays in column 0 of its row.
        expect(await runWithCaret('| a | b |\n| - | - |\n| 1^ | 2 |', 'table.addColumn')).toBe(
            ['| a   |     | b   |', '| --- | --- | --- |', '| ^1   |     | 2   |'].join('\n'),
        )
        // Add row below the caret's row: the caret stays on its row.
        expect(await runWithCaret('| a | b |\n| - | - |\n| 1 | 2^ |', 'table.addRow')).toBe(
            ['| a   | b   |', '| --- | --- |', '| 1   | ^2   |', '|     |     |'].join('\n'),
        )
        // On the header (even with the placeholder selected) the caret stays on the header.
        expect(await runWithCaret('| «a» | b |\n| - | - |\n| 1 | 2 |', 'table.addColumn')).toBe(
            ['| ^a   |     | b   |', '| --- | --- | --- |', '| 1   |     | 2   |'].join('\n'),
        )
    })

    it('moves the caret to the nearest cell when its own is removed', async () => {
        expect(await runWithCaret('| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4^ |', 'table.removeRow')).toBe(
            ['| a   | b   |', '| --- | --- |', '| 1   | ^2   |'].join('\n'),
        )
        expect(await runWithCaret('| a | b |\n| - | - |\n| 1 | 2^ |', 'table.removeColumn')).toBe(
            ['| a   |', '| --- |', '| ^1   |'].join('\n'),
        )
        expect(await runWithCaret('| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4^ |', 'table.removeRowsAbove')).toBe(
            ['| a   | b   |', '| --- | --- |', '| 3   | ^4   |'].join('\n'),
        )
        expect(await runWithCaret('| a | b | c |\n| - | - | - |\n| 1 | 2 | 3^ |', 'table.removeColumnsLeft')).toBe(
            ['| c   |', '| --- |', '| ^3   |'].join('\n'),
        )
    })

    it('refuses to insert a table inside a table, where a header would read as more rows', async () => {
        const out = await run('| a | b |\n| - | - |\n| 1^ | 2 |', 'table.insert', { cols: 1, rows: 1 })
        expect(out).toBe('| a | b |\n| - | - |\n| 1 | 2 |')
    })
})

describe('registerEditorCommands — table.insert', () => {
    function activate(ed: HeadlessEditor): () => void {
        const view = {
            get state() {
                return ed.state
            },
            dispatch: (spec: TransactionSpec) => ed.dispatch(ed.state.update(spec)),
        } as unknown as EditorView
        setActiveEditorView(view)
        return () => setActiveEditorView(null)
    }

    async function insert(fixture: string, arg?: unknown): Promise<HeadlessEditor> {
        const commands = createCommandRegistry()
        const teardown = registerEditorCommands(commands, createContributionRegistry())
        const ed = editorFixture(fixture, { caret: '^', extensions: [tableSizePicker()] })
        const deactivate = activate(ed)
        try {
            await commands.execute('table.insert', arg)
            return ed
        } finally {
            deactivate()
            teardown()
        }
    }

    it('bare, opens the Table Size Picker at the caret and writes nothing yet', async () => {
        const ed = await insert('- ^')
        expect(tableSizePickerState(ed.state)).toEqual({ pos: 2, size: { cols: 3, rows: 2 } })
        expect(ed.text()).toBe('- ')
    })

    it("given a size, makes an empty bullet's content a table of that size (the mobile screenshot case)", async () => {
        const ed = await insert('- ^', { cols: 2, rows: 1 })
        expect(ed.text()).toBe(['- | Column 1 | Column 2 |', '  | -------- | -------- |', '  |          |          |'].join('\n'))
        expect(ed.state.sliceDoc(ed.state.selection.main.from, ed.state.selection.main.to)).toBe('Column 1')
    })

    it('appends below a non-empty bullet as a continuation, at the content column', async () => {
        const ed = await insert('- no^te', { cols: 1, rows: 1 })
        expect(ed.text()).toBe(['- note', '  | Column 1 |', '  | -------- |', '  |          |'].join('\n'))
    })

    it('refuses in fenced code and frontmatter', async () => {
        expect((await insert('```\ncode^\n```', { cols: 1, rows: 1 })).text()).toBe('```\ncode\n```')
        expect((await insert('---\ntitle: x^\n---\nbody', { cols: 1, rows: 1 })).text()).toBe('---\ntitle: x\n---\nbody')
    })

    it('registers a fixed Insert button and a contextual table group on the Command Bar', () => {
        const contributions = createContributionRegistry()
        const teardown = registerEditorCommands(createCommandRegistry(), contributions)
        const bar = listCommandBarItems(contributions)
        expect(bar.find((b) => b.id === 'table.insert')).toMatchObject({ tableInsertOnly: true, writableOnly: true, order: 6 })
        expect(bar.filter((b) => b.contextualGroup === 'table').map((b) => b.id)).toEqual([
            'table.addRow',
            'table.addColumn',
            'table.removeRow',
            'table.removeColumn',
        ])
        expect(bar.find((b) => b.id === 'table.removeRow')?.tableRowOnly).toBe(true)
        expect(bar.find((b) => b.id === 'table.removeColumn')?.tableMultiColumnOnly).toBe(true)
        // The group sorts directly after the slash button, so it is on screen without scrolling.
        expect(bar.slice(0, 5).map((b) => b.id)).toEqual([
            'editor.openCommandMenu',
            'table.addRow',
            'table.addColumn',
            'table.removeRow',
            'table.removeColumn',
        ])
        teardown()
    })

    it('the Command Menu offers Table only where a table can be inserted', () => {
        const contributions = createContributionRegistry()
        const teardown = registerEditorCommands(createCommandRegistry(), contributions)
        const ids = (tableInsertable: boolean) =>
            listCommandMenuItems(contributions, { inTable: !tableInsertable, tableInsertable, bodyWritable: true }).map((i) => i.id)
        expect(ids(true)).toContain('table.insert')
        expect(ids(false)).not.toContain('table.insert')
        teardown()
    })
})

describe('registerEditorCommands — a locked Protected Document', () => {
    /** The session accessor as the workspace sets it: readable or not. */
    function session(readable: boolean): () => void {
        setActiveProtectionStatus({ reasonAt: () => 'locked', isReadable: () => readable, requestUnlock() {}, lockNow() {} })
        return () => setActiveProtectionStatus(null)
    }

    async function run(id: string, readable: boolean, fixture = '---\ntitle: x^\n---\n'): Promise<string> {
        const commands = createCommandRegistry()
        const teardown = registerEditorCommands(commands, createContributionRegistry())
        const ed = editorFixture(fixture, {
            caret: '^',
            extensions: [isProtectedDocumentFacet.of(() => true)],
        })
        const restore = session(readable)
        const deactivate = activate(ed)
        try {
            await commands.execute(id)
            return ed.text()
        } finally {
            deactivate()
            restore()
            teardown()
        }
    }

    it('the editing Commands no-op while locked, even with the caret in the typeable frontmatter', async () => {
        for (const id of [
            'editor.insertWikilinkOpen',
            'editor.insertWikilinkClose',
            'date.today',
            'editor.insertCodeBlock',
            'table.insert',
            // Would make the frontmatter line a bullet.
            'editor.indent',
            'editor.toggleTask',
            'editor.undo',
            'editor.redo',
        ]) {
            expect(await run(id, false), id).toBe('---\ntitle: x\n---\n')
        }
    })

    it('the same Commands run once the document is readable again', async () => {
        expect(await run('editor.insertWikilinkOpen', true)).toBe('---\ntitle: x[[\n---\n')
    })

    it('the bracket buttons leave a selected word alone while locked, and wrap it once readable', async () => {
        const fixture = '---\ntitle: t\n---\n- the fox jumped'
        const selected = fixture.replace('fox', '«fox»')
        expect(await run('editor.insertWikilinkOpen', false, selected)).toBe(fixture)
        expect(await run('editor.insertWikilinkClose', false, selected)).toBe(fixture)
        expect(await run('editor.insertWikilinkOpen', true, selected)).toBe(fixture.replace('fox', '[[fox]]'))
    })

    it('every Command Bar button that writes to the body is writableOnly, the slash button included; fold and zoom are not', () => {
        const contributions = createContributionRegistry()
        const teardown = registerEditorCommands(createCommandRegistry(), contributions)
        const bar = listCommandBarItems(contributions)
        const gated = bar.filter((b) => b.writableOnly).map((b) => b.id)
        const open = bar.filter((b) => !b.writableOnly).map((b) => b.id)
        expect(gated).toEqual([
            'editor.openCommandMenu',
            'table.addRow',
            'table.addColumn',
            'table.removeRow',
            'table.removeColumn',
            'editor.insertWikilinkOpen',
            'editor.insertWikilinkClose',
            'editor.toggleTask',
            'editor.undo',
            'editor.redo',
            'asset.upload',
            'table.insert',
            'editor.outdent',
            'editor.indent',
            'editor.moveUp',
            'editor.moveDown',
        ])
        expect(open).toEqual(['editor.toggleFold', 'editor.zoomOut', 'editor.zoomIn'])
        teardown()
    })

    it('the Command Menu keeps only the rows that write to no document when the body is not writable', () => {
        const contributions = createContributionRegistry()
        const teardown = registerEditorCommands(createCommandRegistry(), contributions)
        const ids = (ctx: { inTable: boolean; tableInsertable: boolean; bodyWritable: boolean }) => listCommandMenuItems(contributions, ctx).map((i) => i.id)
        // Search reads; Reset workspace touches the Layout; spell check is a device preference.
        // None of them writes into the locked body.
        expect(ids({ inTable: true, tableInsertable: false, bodyWritable: false })).toEqual([
            'search.open',
            'workspace.reset',
            'editor.spellCheckOff',
        ])
        expect(ids({ inTable: false, tableInsertable: true, bodyWritable: true })).toContain('asset.upload')
        teardown()
    })
})

describe('registerEditorCommands — spell check', () => {
    const everywhere = { inTable: false, tableInsertable: true, bodyWritable: true }

    it('toggles the device preference and says so, since nothing on screen may change', async () => {
        const commands = createCommandRegistry()
        const teardown = registerEditorCommands(commands, createContributionRegistry())
        try {
            setSpellCheckEnabled(true)
            await commands.execute('editor.toggleSpellCheck')
            expect(isSpellCheckEnabled()).toBe(false)
            expect(getNotices().map((n) => n.text)).toEqual(['Spell check off for this device'])

            // A second toggle replaces the first notice rather than stacking under it.
            await commands.execute('editor.toggleSpellCheck')
            expect(isSpellCheckEnabled()).toBe(true)
            expect(getNotices().map((n) => n.text)).toEqual(['Spell check on for this device'])
        } finally {
            setSpellCheckEnabled(true)
            resetNotices()
            teardown()
        }
    })

    it('offers the Command Menu row that changes the current state, on a locked document too', async () => {
        const commands = createCommandRegistry()
        const contributions = createContributionRegistry()
        const teardown = registerEditorCommands(commands, contributions)
        const rows = (ctx = everywhere) =>
            listCommandMenuItems(contributions, ctx).filter((i) => i.id.startsWith('editor.spellCheck'))
        try {
            setSpellCheckEnabled(true)
            expect(rows().map((r) => r.title)).toEqual(['Spell check: turn off'])
            expect(rows({ ...everywhere, bodyWritable: false }).map((r) => r.id)).toEqual(['editor.spellCheckOff'])
            expect(rows()[0].keywords).toEqual(expect.arrayContaining(['spelling', 'spellcheck']))

            // The row does what its title says, even run from a menu opened before the state changed.
            const turnOff = rows()[0]
            await commands.execute(turnOff.command, turnOff.args)
            expect(isSpellCheckEnabled()).toBe(false)
            await commands.execute(turnOff.command, turnOff.args)
            expect(isSpellCheckEnabled()).toBe(false)

            expect(rows().map((r) => r.title)).toEqual(['Spell check: turn on'])
            await commands.execute(rows()[0].command, rows()[0].args)
            expect(isSpellCheckEnabled()).toBe(true)
        } finally {
            setSpellCheckEnabled(true)
            resetNotices()
            teardown()
        }
    })
})
