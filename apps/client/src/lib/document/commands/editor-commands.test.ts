import { foldedRanges } from '@codemirror/language'
import type { Extension, Transaction, TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import { setActiveEditorView } from '../active-editor'
import { setActiveGraphSettings } from '../active-graph-settings'
import { DEFAULT_FONT_SIZE, getEditorFontSize, setEditorFontSize } from '../editor-font'
import { closeAssetPicker, getAssetPickerState } from '../view/asset-picker'
import { openDateCalendar } from '../view/augmentations/date-calendar'
import { rankCommandMenu } from '../view/augmentations/slash-complete-core'
import { setActiveProtectionStatus } from '../protection/active-protection'
import { isProtectedDocumentFacet } from '../view/augmentations/protected-fence'
import { tableSizePicker, tableSizePickerState } from '../view/augmentations/table-size-picker'
import { type HeadlessEditor, editorFixture } from '../view/testing/editor-state-fixture'

import {
    commandMenuItemsInOrder,
    createCommandRegistry,
    createContributionRegistry,
    listCommandBarItems,
    listCommandMenuItems,
} from '../../surface'
import { getNotices, resetNotices } from '$lib/activity/notices'
import { clientIconNames } from '../../surface/icons'

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
        // The bullet toggle comes first after the slash, then the wikilink pair, the task toggle, and
        // undo and redo: the strip scrolls on a phone, and buried among the block ops these were
        // off-screen exactly when someone was on a task, or had just made a mistake.
        const fixed = listCommandBarItems(contributions).filter((b) => !b.contextualGroup)
        expect(fixed.slice(0, 8)).toMatchObject([
            { command: 'editor.openCommandMenu' },
            { command: 'editor.toggleBullet', icon: 'bullet', label: 'Bullet', bulletToggleOnly: true, pressed: 'bullet' },
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
        expect(await tap('# How «Garden Shed» fits', 'editor.insertWikilinkOpen')).toBe('# How [[«Garden Shed»]] fits')
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
        expect(bar.find((b) => b.id === 'table.insert')).toMatchObject({ tableInsertOnly: true, writableOnly: true, order: 7 })
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
            'editor.toggleBullet',
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

    it('the bullet toggle leaves a body line alone while locked, and makes it a bullet once readable', async () => {
        // On a body line, so it is the lock and not the frontmatter that refuses.
        expect(await run('editor.toggleBullet', false, '---\ntitle: x\n---\nbody^')).toBe('---\ntitle: x\n---\nbody')
        expect(await run('editor.toggleBullet', true, '---\ntitle: x\n---\nbody^')).toBe('---\ntitle: x\n---\n- body')
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
            'editor.toggleBullet',
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
        // Search reads; Find and replace reads the frontmatter and says why it cannot replace;
        // Reset workspace touches the Layout; spell check is a device preference. None of them
        // writes into the locked body.
        expect(ids({ inTable: true, tableInsertable: false, bodyWritable: false })).toEqual([
            'search.open',
            'document.findReplace',
            'editor.spellCheckOff',
            'workspace.reset',
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

/**
 * A headless editor as the active view, recording every transaction it dispatches. `lineBlockAt`
 * is the one layout read `toggleFold` makes; without line wrapping a block is its line.
 */
function activateRecording(ed: HeadlessEditor): { transactions: Transaction[]; deactivate: () => void } {
    const transactions: Transaction[] = []
    const view = {
        get state() {
            return ed.state
        },
        dispatch: (...specs: TransactionSpec[]) => {
            const tr = ed.state.update(...specs)
            transactions.push(tr)
            ed.dispatch(tr)
        },
        lineBlockAt: (pos: number) => ed.state.doc.lineAt(pos),
    } as unknown as EditorView
    setActiveEditorView(view)
    return { transactions, deactivate: () => setActiveEditorView(null) }
}

/** Run one Command over a fixture with `|` at the caret; returns the editor and what it dispatched. */
async function runCommand(fixture: string, id: string, arg?: unknown, extensions: Extension[] = []) {
    const commands = createCommandRegistry()
    const teardown = registerEditorCommands(commands, createContributionRegistry())
    const ed = editorFixture(fixture, { extensions })
    const { transactions, deactivate } = activateRecording(ed)
    try {
        await commands.execute(id, arg)
        return { ed, transactions }
    } finally {
        deactivate()
        teardown()
    }
}

describe('registerEditorCommands — the block, format and history Commands', () => {
    it('indent and outdent move a bullet a level in and out', async () => {
        expect((await runCommand('- Garden\n- water the beans|', 'editor.indent')).ed.fixture()).toBe('- Garden\n  - water the beans|')
        expect((await runCommand('- Garden\n  - water the beans|', 'editor.outdent')).ed.fixture()).toBe('- Garden\n- water the beans|')
    })

    it('move up and move down swap a bullet with its neighbour', async () => {
        expect((await runCommand('- Garden\n- Kitchen|', 'editor.moveUp')).ed.text()).toBe('- Kitchen\n- Garden')
        expect((await runCommand('- Garden|\n- Kitchen', 'editor.moveDown')).ed.text()).toBe('- Kitchen\n- Garden')
    })

    it('the task toggle makes a bullet a task', async () => {
        expect((await runCommand('- water the beans|', 'editor.toggleTask')).ed.text()).toBe('- [ ] water the beans')
    })

    it('the fold toggle folds a bullet’s children, and needs no writable body', async () => {
        const { ed } = await runCommand('- Garden|\n  - water the beans', 'editor.toggleFold')
        expect(foldedRanges(ed.state).size).toBe(1)
        expect(ed.text()).toBe('- Garden\n  - water the beans')
    })

    it('bold, italic and highlight open an empty pair at the caret', async () => {
        expect((await runCommand('- Garden |', 'editor.bold')).ed.fixture()).toBe('- Garden **|**')
        expect((await runCommand('- Garden |', 'editor.italic')).ed.fixture()).toBe('- Garden *|*')
        expect((await runCommand('- Garden |', 'editor.highlight')).ed.fixture()).toBe('- Garden ==|==')
    })

    it('undo takes back the last edit and redo puts it back', async () => {
        const commands = createCommandRegistry()
        const teardown = registerEditorCommands(commands, createContributionRegistry())
        const ed = editorFixture('- Garden|')
        const { deactivate } = activateRecording(ed)
        try {
            ed.type('s')
            expect(ed.text()).toBe('- Gardens')
            await commands.execute('editor.undo')
            expect(ed.text()).toBe('- Garden')
            await commands.execute('editor.redo')
            expect(ed.text()).toBe('- Gardens')
        } finally {
            deactivate()
            teardown()
        }
    })

    it('zoom in and zoom out step the editor font size by one pixel each way', async () => {
        const commands = createCommandRegistry()
        const teardown = registerEditorCommands(commands, createContributionRegistry())
        try {
            setEditorFontSize(DEFAULT_FONT_SIZE)
            await commands.execute('editor.zoomIn')
            expect(getEditorFontSize()).toBe(DEFAULT_FONT_SIZE + 1)
            await commands.execute('editor.zoomOut')
            await commands.execute('editor.zoomOut')
            expect(getEditorFontSize()).toBe(DEFAULT_FONT_SIZE - 1)
        } finally {
            setEditorFontSize(DEFAULT_FONT_SIZE)
            teardown()
        }
    })

    it('with no editor focused, the editor Commands do nothing and do not throw', async () => {
        const commands = createCommandRegistry()
        const teardown = registerEditorCommands(commands, createContributionRegistry())
        setActiveEditorView(null)
        try {
            for (const id of ['editor.indent', 'editor.toggleFold', 'editor.openCommandMenu', 'date.today', 'table.addRow', 'table.insert']) {
                await expect(commands.execute(id), id).resolves.toBeUndefined()
            }
        } finally {
            teardown()
        }
    })
})

describe('registerEditorCommands — the slash button', () => {
    it('types a bare slash at the start of a line', async () => {
        expect((await runCommand('- Garden\n|', 'editor.openCommandMenu')).ed.fixture()).toBe('- Garden\n/|')
        expect((await runCommand('|', 'editor.openCommandMenu')).ed.fixture()).toBe('/|')
    })

    it('types a space before the slash right after a word', async () => {
        expect((await runCommand('- Garden|', 'editor.openCommandMenu')).ed.fixture()).toBe('- Garden /|')
    })

    it('types a bare slash after a space', async () => {
        expect((await runCommand('- Garden |', 'editor.openCommandMenu')).ed.fixture()).toBe('- Garden /|')
    })

    it('reads the character before the caret, not after it', async () => {
        expect((await runCommand('- Garden |shed', 'editor.openCommandMenu')).ed.fixture()).toBe('- Garden /|shed')
    })
})

describe('registerEditorCommands — dates and assets', () => {
    it('Today inserts today’s date as a wikilink with the caret after it', async () => {
        const { ed } = await runCommand('- Garden |', 'date.today')
        expect(ed.fixture()).toMatch(/^- Garden \[\[\d{4}-\d{2}-\d{2}\]\]\|$/)
    })

    it('Date Picker opens the calendar at the caret and writes nothing', async () => {
        const { ed, transactions } = await runCommand('- Garden |shed', 'date.pick')
        const effects = transactions.flatMap((tr) => tr.effects).filter((e) => e.is(openDateCalendar))
        expect(effects.map((e) => e.value)).toEqual([{ pos: 9 }])
        expect(ed.text()).toBe('- Garden shed')
    })

    it('Upload asset opens the asset dialog pinned to the caret', async () => {
        try {
            const { ed } = await runCommand('- Garden |shed', 'asset.upload')
            expect(getAssetPickerState()).toMatchObject({ open: true, pos: 9 })
            expect(ed.text()).toBe('- Garden shed')
        } finally {
            closeAssetPicker()
        }
    })
})

describe('registerEditorCommands — code block', () => {
    async function codeBlock(fixture: string, defaultCodeLanguage?: string): Promise<string> {
        setActiveGraphSettings(defaultCodeLanguage ? { defaultCodeLanguage } : {})
        try {
            return (await runCommand(fixture, 'editor.insertCodeBlock')).ed.fixture()
        } finally {
            setActiveGraphSettings({})
        }
    }

    it('makes an empty bullet’s content the opening fence, the body at the content column', async () => {
        expect(await codeBlock('- |')).toBe('- ```\n  |\n  ```')
    })

    it('treats a bullet with only spaces after its marker as empty', async () => {
        expect(await codeBlock('-   |')).toBe('-   ```\n  |\n  ```')
    })

    it('opens the block on a new line below a bullet with content, at the content column', async () => {
        expect(await codeBlock('- Garden|')).toBe('- Garden\n  ```\n  |\n  ```')
    })

    it('fills an empty prose line with the block', async () => {
        expect(await codeBlock('Garden\n|')).toBe('Garden\n```\n|\n```')
    })

    it('replaces a prose line of only spaces with the block at that indent, leaving no spaces behind', async () => {
        expect(await codeBlock('Garden\n  |')).toBe('Garden\n  ```\n  |\n  ```')
        expect(await codeBlock('Garden\n |  ')).toBe('Garden\n   ```\n   |\n   ```')
    })

    it('writes the graph’s default language after the opening fence', async () => {
        expect(await codeBlock('- |', 'python')).toBe('- ```python\n  |\n  ```')
        expect(await codeBlock('Garden|', 'python')).toBe('Garden\n```python\n|\n```')
    })
})

describe('registerEditorCommands — table edits and the caret', () => {
    async function table(fixture: string, id: string): Promise<string> {
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

    const rows = (...lines: string[]) => lines.join('\n')

    it('outside a table the table edits leave the document alone', async () => {
        expect(await table('- Garden^', 'table.addRow')).toBe('- Garden^')
    })

    it('an edit the table refuses leaves the table as it was', async () => {
        // Remove row on the header: there is no body row to remove.
        expect(await table('| a^ | b |\n| - | - |\n| 1 | 2 |', 'table.removeRow')).toBe('| a^ | b |\n| - | - |\n| 1 | 2 |')
    })

    it('add column puts the new column after the caret’s own', async () => {
        expect(await table('| a | b |\n| - | - |\n| 1 | 2^ |', 'table.addColumn')).toBe(
            rows('| a   | b   |     |', '| --- | --- | --- |', '| 1   | ^2   |     |'),
        )
    })

    it('add row on the header appends the row at the bottom, the caret staying on the header', async () => {
        expect(await table('| a^ | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |', 'table.addRow')).toBe(
            rows('| ^a   | b   |', '| --- | --- |', '| 1   | 2   |', '| 3   | 4   |', '|     |     |'),
        )
    })

    it('add row on the separator returns the caret to the header', async () => {
        expect(await table('| a | b |\n| - | -^ |\n| 1 | 2 |', 'table.addRow')).toBe(
            rows('| a   | ^b   |', '| --- | --- |', '| 1   | 2   |', '|     |     |'),
        )
    })

    it('add row on a body row inserts the new row directly below it', async () => {
        expect(await table('| a | b |\n| - | - |\n| 1^ | 2 |\n| 3 | 4 |', 'table.addRow')).toBe(
            rows('| a   | b   |', '| --- | --- |', '| ^1   | 2   |', '|     |     |', '| 3   | 4   |'),
        )
        expect(await table('| a | b |\n| - | - |\n| 1 | 2 |\n| 3^ | 4 |\n| 5 | 6 |', 'table.addRow')).toBe(
            rows('| a   | b   |', '| --- | --- |', '| 1   | 2   |', '| ^3   | 4   |', '|     |     |', '| 5   | 6   |'),
        )
    })

    it('remove rows above puts the caret on what is now the first row', async () => {
        expect(await table('| a | b |\n| - | - |\n| 1 | 2 |\n| 3^ | 4 |\n| 5 | 6 |', 'table.removeRowsAbove')).toBe(
            rows('| a   | b   |', '| --- | --- |', '| ^3   | 4   |', '| 5   | 6   |'),
        )
    })

    it('remove rows above on the header keeps every row and the caret on the header', async () => {
        expect(await table('| a | b^ |\n| - | - |\n| 1 | 2 |', 'table.removeRowsAbove')).toBe(
            rows('| a   | ^b   |', '| --- | --- |', '| 1   | 2   |'),
        )
    })

    it('remove rows below keeps the caret’s row and everything above it', async () => {
        expect(await table('| a | b |\n| - | - |\n| 1 | 2 |\n| 3^ | 4 |\n| 5 | 6 |', 'table.removeRowsBelow')).toBe(
            rows('| a   | b   |', '| --- | --- |', '| 1   | 2   |', '| ^3   | 4   |'),
        )
    })

    it('remove columns right keeps the caret’s column and everything left of it', async () => {
        expect(await table('| a | b | c |\n| - | - | - |\n| 1 | 2^ | 3 |', 'table.removeColumnsRight')).toBe(
            rows('| a   | b   |', '| --- | --- |', '| 1   | ^2   |'),
        )
    })
})

describe('registerEditorCommands — command arguments', () => {
    it('a null argument toggles spell check, as a bare call does', async () => {
        const commands = createCommandRegistry()
        const teardown = registerEditorCommands(commands, createContributionRegistry())
        try {
            setSpellCheckEnabled(true)
            await commands.execute('editor.toggleSpellCheck', null)
            expect(isSpellCheckEnabled()).toBe(false)
            // Not a boolean: a toggle too, never a truthy "on".
            await commands.execute('editor.toggleSpellCheck', { enabled: 'yes' })
            expect(isSpellCheckEnabled()).toBe(true)
            await commands.execute('editor.toggleSpellCheck', { enabled: 'yes' })
            expect(isSpellCheckEnabled()).toBe(false)
        } finally {
            setSpellCheckEnabled(true)
            resetNotices()
            teardown()
        }
    })

    it('the turn-on row keeps spell check on when it is on already', async () => {
        const commands = createCommandRegistry()
        const contributions = createContributionRegistry()
        const teardown = registerEditorCommands(commands, contributions)
        try {
            setSpellCheckEnabled(false)
            const turnOn = listCommandMenuItems(contributions, { inTable: false, tableInsertable: true, bodyWritable: true }).find(
                (i) => i.id === 'editor.spellCheckOn',
            )!
            setSpellCheckEnabled(true)
            await commands.execute(turnOn.command, turnOn.args)
            expect(isSpellCheckEnabled()).toBe(true)
        } finally {
            setSpellCheckEnabled(true)
            resetNotices()
            teardown()
        }
    })

    it('table insert opens the size picker for a null or partial size', async () => {
        for (const arg of [null, { cols: 2 }, { rows: 2 }, { cols: '2', rows: 2 }]) {
            const { ed } = await runCommand('- |', 'table.insert', arg, [tableSizePicker()])
            expect(tableSizePickerState(ed.state), JSON.stringify(arg)).toEqual({ pos: 2, size: { cols: 3, rows: 2 } })
            expect(ed.text()).toBe('- ')
        }
    })
})

describe('registerEditorCommands — what the Command Bar and Command Menu offer', () => {
    /** Commands registered elsewhere that this module's rows run. */
    const external = ['search.open', 'document.findReplace', 'workspace.reset']

    it('every button and row names an icon the Client draws and a Command that exists', () => {
        const commands = createCommandRegistry()
        const contributions = createContributionRegistry()
        const teardown = registerEditorCommands(commands, contributions)
        const icons = new Set(clientIconNames())
        const bar = listCommandBarItems(contributions)
        const menu = commandMenuItemsInOrder(contributions)
        for (const entry of [...bar, ...menu]) {
            expect(icons.has(entry.icon ?? ''), `${entry.id} icon`).toBe(true)
            expect(commands.has(entry.command) || external.includes(entry.command), `${entry.id} command`).toBe(true)
        }
        teardown()
    })

    it('every button has a label, and every row a detail and a group', () => {
        const contributions = createContributionRegistry()
        const teardown = registerEditorCommands(createCommandRegistry(), contributions)
        for (const button of listCommandBarItems(contributions)) expect(button.label, button.id).not.toBe('')
        for (const row of commandMenuItemsInOrder(contributions)) {
            expect(row.detail, row.id).toBeTruthy()
            expect(row.group, row.id).toBeTruthy()
        }
        teardown()
    })

    it('the block buttons grey off the outline, and indent only where a line cannot convert', () => {
        const contributions = createContributionRegistry()
        const teardown = registerEditorCommands(createCommandRegistry(), contributions)
        const bar = new Map(listCommandBarItems(contributions).map((b) => [b.id, b]))
        for (const id of ['editor.outdent', 'editor.moveUp', 'editor.moveDown', 'editor.toggleFold']) {
            expect(bar.get(id)?.outlinerOnly, id).toBe(true)
        }
        expect(bar.get('editor.indent')).toMatchObject({ convertibleOnly: true })
        expect(bar.get('editor.indent')?.outlinerOnly).toBeUndefined()
        teardown()
    })

    it('in a table the Command Menu offers every table edit, and outside one none of them', () => {
        const contributions = createContributionRegistry()
        const teardown = registerEditorCommands(createCommandRegistry(), contributions)
        const tableRows = (inTable: boolean) =>
            listCommandMenuItems(contributions, { inTable, tableInsertable: !inTable, bodyWritable: true })
                .map((i) => i.id)
                .filter((id) => id.startsWith('table.') && id !== 'table.insert')
        expect(tableRows(true)).toEqual([
            'table.addColumn',
            'table.addRow',
            'table.format',
            'table.removeRow',
            'table.removeColumn',
            'table.removeRowsAbove',
            'table.removeRowsBelow',
            'table.removeColumnsRight',
            'table.removeColumnsLeft',
        ])
        expect(tableRows(false)).toEqual([])
        teardown()
    })

    it('a row is found by the other words a person might type for it', () => {
        const contributions = createContributionRegistry()
        const teardown = registerEditorCommands(createCommandRegistry(), contributions)
        const all = listCommandMenuItems(contributions, { inTable: false, tableInsertable: true, bodyWritable: true })
        const found = (query: string) => rankCommandMenu(all, query).map((i) => i.id)
        const synonyms: [string, string][] = [
            ['grep', 'search.open'],
            ['match', 'document.findReplace'],
            ['panes', 'workspace.reset'],
            ['dictionary', 'editor.spellCheckOff'],
            ['photo', 'asset.upload'],
            ['now', 'date.today'],
            ['calendar', 'date.pick'],
            ['strong', 'editor.bold'],
            ['emphasis', 'editor.italic'],
            ['marker', 'editor.highlight'],
            ['snippet', 'editor.insertCodeBlock'],
            ['grid', 'table.insert'],
        ]
        for (const [query, id] of synonyms) expect(found(query), query).toContain(id)
        teardown()
    })
})
