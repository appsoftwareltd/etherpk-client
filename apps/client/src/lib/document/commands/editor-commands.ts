/**
 * The first-party **editor Commands** the Command Menu surfaces (Dual Mode Editor.md →
 * *Command Menu*): date insertion (Today / Date Picker) and the ten table-editing actions.
 * Each is registered with the Command registry (id → handler) and reaches the live editor
 * through `getActiveEditorView()` — so the same Commands are invocable later from a
 * keybinding that holds no view. The matching menu-item descriptors are registered with the
 * Contribution registry (the `command-menu` kind); each descriptor's `command` is one of the
 * ids below. Handlers no-op when no editor is focused or the caret is not in a table.
 */

import { toggleFold } from '@codemirror/language'
import type { EditorView } from '@codemirror/view'

import { showNotice } from '$lib/activity/notices'

import {
    type CommandBarItem,
    type CommandMenuItem,
    type CommandRegistry,
    type ContributionRegistry,
    registerCommandBarItem,
    registerCommandMenuItem,
} from '../../surface'
import { getActiveEditorView } from '../active-editor'
import { getActiveGraphSettings } from '../active-graph-settings'
import { zoomEditorFont } from '../editor-font'
import { isSpellCheckEnabled, setSpellCheckEnabled, toggleSpellCheck } from '../spell-check-preference'
import { bulletContent, contentColumn, isBulletLine, lineIndent } from '../outliner'
import {
    indentBranch,
    moveBranchDown,
    moveBranchUp,
    outdentBranch,
    toggleTask,
} from '../view/outliner-keymap'
import type { MarkdownTable } from '../markdown-table'
import {
    addColumns,
    addRows,
    buildTable,
    cellPosition,
    formatTable,
    removeColumn,
    removeColumnsLeft,
    removeColumnsRight,
    removeRow,
    removeRowsAbove,
    removeRowsBelow,
} from '../markdown-table-edit'
import { formatISODate } from '../calendar/month-grid-core'
import { openDateCalendar } from '../view/augmentations/date-calendar'
import { acceptTableSize, openTableSizePicker } from '../view/augmentations/table-size-picker'
import { clampTableSize, type TableSize } from '../view/augmentations/table-size-picker-core'
import { openAssetPicker } from '../view/asset-picker'
import { bodyWritable } from '../view/body-writable'
import { redoCommand, undoCommand } from '../view/editor-history'
import { type TableCaret, tableAtCaret, tableInsertable } from '../view/table-context'
import { toggleBold, toggleHighlight, toggleItalic, wikilinkButtonSpec } from '../view/wrap-selection'

/** Insert `text` at the caret and place the cursor after it. */
function insertAtCursor(view: EditorView, text: string): void {
    const at = view.state.selection.main.head
    view.dispatch({
        changes: { from: at, insert: text },
        selection: { anchor: at + text.length },
        userEvent: 'input.complete',
    })
}

/** Where the caret goes after a table edit: a body row (0-based) or the header, and a column. */
interface CaretCell {
    bodyRow: number
    column: number
}

/**
 * Apply a pure table transform at the caret and write the re-serialised table back, then put
 * the caret at the start of a cell of the new table — the one `after` names, or the same cell
 * the caret was in. Explicit, because mapping the old selection through a whole-table
 * replacement lands wherever CodeMirror's mapping rules put it (the end of the table when the
 * placeholder was still selected after an insert), and the next edit reads the caret's row.
 */
function editTableAtCursor(
    view: EditorView,
    transform: (hit: TableCaret) => MarkdownTable | null,
    after: (hit: TableCaret) => CaretCell = (hit) => ({ bodyRow: hit.bodyRow, column: hit.column }),
): boolean {
    const hit = tableAtCaret(view.state)
    if (!hit) return false
    const next = transform(hit)
    if (!next) return false
    const text = buildTable(next, hit.indent, hit.headerIndent)
    const cell = after(hit)
    // The header keeps a caret that was on the header or separator; body rows clamp to what is left.
    const lineIndex = cell.bodyRow < 0 ? 0 : 2 + Math.min(cell.bodyRow, next.rows.length - 1)
    const column = Math.min(cell.column, next.header.length - 1)
    view.dispatch({
        changes: { from: hit.from, to: hit.to, insert: text },
        selection: { anchor: hit.from + cellPosition(text, lineIndex, column) },
        userEvent: 'input.complete',
    })
    return true
}

/** Register the date + table Commands and their Command Menu descriptors. Returns a teardown. */
export function registerEditorCommands(
    commands: CommandRegistry,
    contributions: ContributionRegistry,
): () => void {
    const offs: (() => void)[] = []
    const command = (id: string, handler: (arg?: unknown) => void) => offs.push(commands.register(id, handler))
    const item = (descriptor: CommandMenuItem) => offs.push(registerCommandMenuItem(contributions, descriptor))
    const barItem = (descriptor: CommandBarItem) => offs.push(registerCommandBarItem(contributions, descriptor))

    /** A handler that needs the focused editor; no-ops when there is none. */
    const withView = (fn: (view: EditorView, arg?: unknown) => void) => (arg?: unknown) => {
        const view = getActiveEditorView()
        if (view) fn(view, arg)
    }
    /**
     * A handler that writes to the body; no-ops as well on a locked Protected Document, where
     * the fence guard would drop the edit anyway (`view/body-writable.ts`). Every surface that
     * offers one of these reads the same predicate, so a button is greyed or a row hidden
     * exactly when the Command would do nothing - and a keybinding that holds no view gets the
     * same answer.
     */
    const withWritableView = (fn: (view: EditorView, arg?: unknown) => void) =>
        withView((view, arg) => {
            if (bodyWritable(view.state)) fn(view, arg)
        })
    const tableEdit = (transform: (hit: TableCaret) => MarkdownTable | null, after?: (hit: TableCaret) => CaretCell) =>
        withWritableView((view) => void editTableAtCursor(view, transform, after))

    // ── Editor block-op Commands (the Command Bar's invokers) ─────────────────
    // Thin wrappers over the CM-native outliner commands, reachable from the mobile
    // Command Bar (and any future keybinding/palette). The keymap still calls the CM
    // commands directly — these wrappers are additive (Dual Mode Editor.md → Command Bar).
    command('editor.indent', withWritableView((view) => void indentBranch(view)))
    command('editor.outdent', withWritableView((view) => void outdentBranch(view)))
    command('editor.moveUp', withWritableView((view) => void moveBranchUp(view)))
    command('editor.moveDown', withWritableView((view) => void moveBranchDown(view)))
    command('editor.toggleTask', withWritableView((view) => void toggleTask(view)))
    command('editor.toggleFold', withView((view) => void toggleFold(view)))
    command('editor.openCommandMenu', withView((view) => openCommandMenu(view)))
    // The bracket buttons. Over a selection the wrap rule takes (one line, not only whitespace, not
    // the frontmatter) either makes the whole wikilink at once, the word left selected so the
    // completion opens on it: the wrap key's decision on a phone (wrap-selection.ts, ADR 0077).
    // Otherwise an ordinary typed-input transaction, which keeps every editor augmentation on the
    // same path as a hardware / soft keyboard, the completion opening after `[[` and closing after
    // `]]`.
    command('editor.insertWikilinkOpen', withWritableView((view) => view.dispatch(wikilinkButtonSpec(view.state, '[['))))
    command('editor.insertWikilinkClose', withWritableView((view) => view.dispatch(wikilinkButtonSpec(view.state, ']]'))))
    // Undo / redo run whichever history the editor holds (CodeMirror's own, or the collab
    // Y.UndoManager) through the same Commands its Mod-z / Mod-y bindings run (editor-history.ts).
    // Writable-gated like the other editing Commands: a locked Protected Document has an empty
    // history anyway (`clearHistory`), and undo is dispatched past every filter, so nothing may
    // reach for it there.
    // Format Toggles (wrap-selection.ts, ADR 0077): the same commands the keymap binds to Mod-b,
    // Mod-i and Mod-Shift-h, here so the Command Menu can list them. On a phone the selection path
    // is a wrap key on the soft keyboard: the menu's `/` has replaced the selection by the time a
    // row runs, and the Command Bar carries no Format buttons (a follow-up, not a decision).
    command('editor.bold', withWritableView((view) => void toggleBold(view)))
    command('editor.italic', withWritableView((view) => void toggleItalic(view)))
    command('editor.highlight', withWritableView((view) => void toggleHighlight(view)))
    command('editor.undo', withWritableView((view) => void undoCommand(view)))
    command('editor.redo', withWritableView((view) => void redoCommand(view)))
    // Editor zoom — global (applies to all editors), so no active-view needed.
    command('editor.zoomIn', () => zoomEditorFont(1))
    command('editor.zoomOut', () => zoomEditorFont(-1))
    // Spell Check, a device preference (spell-check-preference.ts): global like zoom, so no active
    // view. Bare (Alt+S) it toggles; a Command Menu row passes the state its title names, so the
    // row does what it says even if another tab changed the preference while the menu was open.
    command('editor.toggleSpellCheck', (arg) => {
        const wanted = spellCheckArg(arg)
        if (wanted === undefined) toggleSpellCheck()
        else setSpellCheckEnabled(wanted)
        // Said, not shown: on a page with no misspelling nothing on screen changes either way.
        showNotice({
            id: 'spell-check',
            tone: 'info',
            text: `Spell check ${isSpellCheckEnabled() ? 'on' : 'off'} for this device`,
        })
    })

    // ── Commands ────────────────────────────────────────────────────────────
    command('date.today', withWritableView((view) => insertAtCursor(view, `[[${formatISODate(new Date())}]]`)))
    command(
        'date.pick',
        withWritableView((view) => view.dispatch({ effects: openDateCalendar.of({ pos: view.state.selection.main.head }) })),
    )
    // Refused here AND in `startAssetUpload`: the dialog is one of three routes to an upload,
    // and the bytes must never move for a body that will not take the reference.
    command('asset.upload', withWritableView((view) => openAssetPicker(view)))
    command('editor.insertCodeBlock', withWritableView((view) => insertCodeBlock(view)))
    // Bare, it opens the Table Size Picker at the caret; handed a `{ cols, rows }` it inserts
    // that size straight away (the picker's own accept path, reachable by a keybinding or test).
    command('table.insert', withWritableView((view, arg) => insertTable(view, arg)))
    command('table.addColumn', tableEdit((h) => addColumns(h.table, Math.max(h.column, 0), 1)))
    command('table.addRow', tableEdit((h) => addRows(h.table, 1, h.bodyRow >= 0 ? h.bodyRow : undefined)))
    command('table.format', tableEdit((h) => formatTable(h.table)))
    command('table.removeRow', tableEdit((h) => removeRow(h.table, h.bodyRow)))
    command('table.removeColumn', tableEdit((h) => removeColumn(h.table, h.column)))
    // The caret's row becomes the first when everything above it goes; its column the first when
    // everything left of it goes. The other edits keep the caret in its own cell (clamped).
    command('table.removeRowsAbove', tableEdit((h) => removeRowsAbove(h.table, Math.max(h.bodyRow, 0)), (h) => ({ bodyRow: h.bodyRow < 0 ? h.bodyRow : 0, column: h.column })))
    command('table.removeRowsBelow', tableEdit((h) => removeRowsBelow(h.table, Math.max(h.bodyRow, 0))))
    command('table.removeColumnsRight', tableEdit((h) => removeColumnsRight(h.table, h.column)))
    command('table.removeColumnsLeft', tableEdit((h) => removeColumnsLeft(h.table, h.column), (h) => ({ bodyRow: h.bodyRow, column: 0 })))

    // ── Command Bar buttons (mobile, fixed bottom) ────────────────────────────
    // Slash opens the Command Menu; the block-ops are the high-frequency outliner actions
    // that are awkward without a hardware keyboard — disabled (greyed) in prose, where they
    // do nothing meaningful. Every button that writes to the body is `writableOnly`: greyed on
    // a locked Protected Document, where its Command refuses on the same predicate. The slash
    // button is one of them - it types a `/` to open the menu, and on a locked document the
    // menu would offer only Search, which the sidebar already does. Zoom buttons float to the
    // right (align:'end', always enabled); the fold button stays live, a fold being view state.
    barItem({ id: 'editor.openCommandMenu', icon: 'slash', label: 'Commands', order: 0, command: 'editor.openCommandMenu', writableOnly: true })
    // The table group is a Contextual Group (CONTEXT.md → Command Bar): present only while the
    // caret is in a table, absent otherwise, and placed right after the slash button so it is on
    // screen without scrolling. Its remove buttons grey where their Command would refuse - the
    // header and separator rows, a single column. The six rarer table edits stay Menu-only.
    barItem({ id: 'table.addRow', icon: 'table-add-row', label: 'Add row', order: 0, command: 'table.addRow', contextualGroup: 'table', writableOnly: true })
    barItem({ id: 'table.addColumn', icon: 'table-add-column', label: 'Add column', order: 0, command: 'table.addColumn', contextualGroup: 'table', writableOnly: true })
    barItem({ id: 'table.removeRow', icon: 'table-remove-row', label: 'Remove row', order: 0, command: 'table.removeRow', contextualGroup: 'table', tableRowOnly: true, writableOnly: true })
    barItem({ id: 'table.removeColumn', icon: 'table-remove-column', label: 'Remove column', order: 0, command: 'table.removeColumn', contextualGroup: 'table', tableMultiColumnOnly: true, writableOnly: true })
    barItem({
        id: 'editor.insertWikilinkOpen',
        icon: 'wikilink-open',
        label: 'Insert [[',
        order: 1,
        command: 'editor.insertWikilinkOpen',
        writableOnly: true,
    })
    barItem({
        id: 'editor.insertWikilinkClose',
        icon: 'wikilink-close',
        label: 'Insert ]]',
        order: 2,
        command: 'editor.insertWikilinkClose',
        writableOnly: true,
    })
    barItem({ id: 'asset.upload', icon: 'image', label: 'Upload', order: 5, command: 'asset.upload', writableOnly: true })
    // Insert is never dead the way the edits are, so it is a fixed button: greyed only where no
    // table can go (code, frontmatter, inside a table), where its Command refuses.
    barItem({ id: 'table.insert', icon: 'table', label: 'Insert table', order: 6, command: 'table.insert', tableInsertOnly: true, writableOnly: true })
    barItem({ id: 'editor.outdent', icon: 'outdent', label: 'Outdent', order: 10, command: 'editor.outdent', outlinerOnly: true, writableOnly: true })
    // Indent is live on prose too: there it makes the line a block (the mobile way into block mode).
    barItem({ id: 'editor.indent', icon: 'indent', label: 'Indent', order: 20, command: 'editor.indent', convertibleOnly: true, writableOnly: true })
    barItem({ id: 'editor.moveUp', icon: 'move-up', label: 'Move up', order: 30, command: 'editor.moveUp', outlinerOnly: true, writableOnly: true })
    barItem({ id: 'editor.moveDown', icon: 'move-down', label: 'Move down', order: 40, command: 'editor.moveDown', outlinerOnly: true, writableOnly: true })
    // Order 3, beside the `/` and `[[ ]]` triggers, not 50 among the block ops: on a phone the
    // strip scrolls, and at 50 the one button people reach for on a task was off-screen.
    // `taskToggleOnly`, not `outlinerOnly`: on prose the toggle MAKES the line a task, so the
    // button is live there too; it is disabled only where the command refuses (heading, code,
    // frontmatter) — the two read the same predicate.
    barItem({ id: 'editor.toggleTask', icon: 'task', label: 'Toggle task', order: 3, command: 'editor.toggleTask', taskToggleOnly: true, writableOnly: true })
    // Order 4, still in the strip's first screenful: undo is the button reached for in a hurry, and a
    // soft keyboard has no Mod-z. Greyed on an empty stack (`undoOnly` / `redoOnly` ←
    // `editorContext.canUndo` / `canRedo`), so the pair also shows whether there is anything to undo.
    barItem({ id: 'editor.undo', icon: 'undo', label: 'Undo', order: 4, command: 'editor.undo', undoOnly: true, writableOnly: true })
    barItem({ id: 'editor.redo', icon: 'redo', label: 'Redo', order: 4, command: 'editor.redo', redoOnly: true, writableOnly: true })
    barItem({ id: 'editor.toggleFold', icon: 'fold', label: 'Fold', order: 60, command: 'editor.toggleFold', outlinerOnly: true })
    barItem({ id: 'editor.zoomOut', icon: 'zoom-out', label: 'Decrease font size', order: 100, align: 'end', command: 'editor.zoomOut' })
    barItem({ id: 'editor.zoomIn', icon: 'zoom-in', label: 'Increase font size', order: 110, align: 'end', command: 'editor.zoomIn' })

    // ── Command Menu descriptors ──────────────────────────────────────────────
    // Every row that writes to the body is hidden on a locked Protected Document (the menu's
    // vocabulary is hide, not grey); Search stays, which is why the menu itself stays reachable.
    const writable = (ctx: { bodyWritable: boolean }) => ctx.bodyWritable
    const inTable = (ctx: { inTable: boolean; bodyWritable: boolean }) => ctx.inTable && ctx.bodyWritable
    const insertable = (ctx: { tableInsertable: boolean; bodyWritable: boolean }) => ctx.tableInsertable && ctx.bodyWritable
    item({ id: 'search.open', title: 'Search', detail: 'Search names and text across this graph', icon: 'search', group: 'Navigate', keywords: ['find', 'text', 'full', 'grep'], command: 'search.open' })
    // Opens a confirmation, never resets on its own; not gated on `bodyWritable`, because it
    // touches the Layout and nothing in any document.
    item({ id: 'workspace.reset', title: 'Reset workspace', detail: 'Close every tab and restore the sidebars', icon: 'reset', group: 'Workspace', keywords: ['layout', 'panes', 'tabs', 'sidebars', 'default'], command: 'workspace.reset' })
    // One row at a time, naming the change it makes. Not gated on `bodyWritable`: the preference
    // writes to no document, so it stays on a locked Protected Document (where it has no effect).
    item({ id: 'editor.spellCheckOff', title: 'Spell check: turn off', detail: 'Stop underlining misspellings on this device', icon: 'spell-check', group: 'Editor', keywords: ['spelling', 'spellcheck', 'dictionary'], when: () => isSpellCheckEnabled(), command: 'editor.toggleSpellCheck', args: { enabled: false } })
    item({ id: 'editor.spellCheckOn', title: 'Spell check: turn on', detail: 'Underline misspellings on this device', icon: 'spell-check', group: 'Editor', keywords: ['spelling', 'spellcheck', 'dictionary'], when: () => !isSpellCheckEnabled(), command: 'editor.toggleSpellCheck', args: { enabled: true } })
    item({ id: 'asset.upload', title: 'Upload asset', detail: 'Insert an image or file', icon: 'image', group: 'Asset', keywords: ['image', 'file', 'attach', 'upload', 'photo'], when: writable, command: 'asset.upload' })
    item({ id: 'date.today', title: 'Today', detail: 'Insert today as a wikilink', icon: 'today', group: 'Date', keywords: ['now'], when: writable, command: 'date.today' })
    item({ id: 'date.pick', title: 'Date Picker', detail: 'Pick a date to insert', icon: 'calendar', group: 'Date', keywords: ['date', 'calendar'], when: writable, command: 'date.pick' })
    // The menu's `/` has replaced any selection by the time a row runs, so from here a toggle
    // opens an empty pair with the caret inside; the wrap keys and chords are the selection path.
    item({ id: 'editor.bold', title: 'Bold', detail: 'Wrap in **, or open an empty pair', icon: 'bold', group: 'Format', keywords: ['strong', 'format'], when: writable, command: 'editor.bold' })
    item({ id: 'editor.italic', title: 'Italic', detail: 'Wrap in *, or open an empty pair', icon: 'italic', group: 'Format', keywords: ['emphasis', 'format'], when: writable, command: 'editor.italic' })
    item({ id: 'editor.highlight', title: 'Highlight', detail: 'Wrap in ==, or open an empty pair', icon: 'highlight', group: 'Format', keywords: ['mark', 'marker', 'format'], when: writable, command: 'editor.highlight' })
    item({ id: 'editor.insertCodeBlock', title: 'Code block', detail: 'Insert a fenced code block', icon: 'code', group: 'Insert', keywords: ['code', 'fence', 'snippet', 'pre'], when: writable, command: 'editor.insertCodeBlock' })
    item({ id: 'table.insert', title: 'Table', detail: 'Insert a table (choose its size)', icon: 'table', group: 'Table', keywords: ['grid'], when: insertable, command: 'table.insert' })
    item({ id: 'table.addColumn', title: 'Table: Add column', detail: 'Add a column after this one', icon: 'table-add-column', group: 'Table', when: inTable, command: 'table.addColumn' })
    item({ id: 'table.addRow', title: 'Table: Add row', detail: 'Add a row below', icon: 'table-add-row', group: 'Table', when: inTable, command: 'table.addRow' })
    item({ id: 'table.format', title: 'Table: Format', detail: 'Normalise column widths', icon: 'table-format', group: 'Table', when: inTable, command: 'table.format' })
    item({ id: 'table.removeRow', title: 'Table: Remove row', detail: 'Remove the current row', icon: 'table-remove-row', group: 'Table', when: inTable, command: 'table.removeRow' })
    item({ id: 'table.removeColumn', title: 'Table: Remove column', detail: 'Remove the current column', icon: 'table-remove-column', group: 'Table', when: inTable, command: 'table.removeColumn' })
    item({ id: 'table.removeRowsAbove', title: 'Table: Remove rows above', detail: 'Remove rows above', icon: 'table-remove', group: 'Table', when: inTable, command: 'table.removeRowsAbove' })
    item({ id: 'table.removeRowsBelow', title: 'Table: Remove rows below', detail: 'Remove rows below', icon: 'table-remove', group: 'Table', when: inTable, command: 'table.removeRowsBelow' })
    item({ id: 'table.removeColumnsRight', title: 'Table: Remove columns right', detail: 'Remove columns to the right', icon: 'table-remove', group: 'Table', when: inTable, command: 'table.removeColumnsRight' })
    item({ id: 'table.removeColumnsLeft', title: 'Table: Remove columns left', detail: 'Remove columns to the left', icon: 'table-remove', group: 'Table', when: inTable, command: 'table.removeColumnsLeft' })

    return () => offs.forEach((off) => off())
}

/**
 * The text the slash button inserts, given the single character before the caret (empty at
 * line start). A literal `/` lets the existing word-boundary trigger (slash-complete.ts) pick
 * it up — but that trigger only fires when the `/` starts a token, so when the caret sits
 * right after a non-whitespace char (the common mobile case — finishing a word then tapping
 * `/`) we prepend a space, guaranteeing the menu opens. On accept the `/query` is deleted,
 * leaving a natural space. Pure, so the boundary rule is unit-tested without CodeMirror.
 */
export function slashInsertText(before: string): string {
    const needsSpace = before !== '' && !/\s/.test(before)
    return needsSpace ? ' /' : '/'
}

/** Open the Command Menu from the bar's slash button (see {@link slashInsertText}). */
function openCommandMenu(view: EditorView): void {
    const head = view.state.selection.main.head
    const line = view.state.doc.lineAt(head)
    const before = head > line.from ? view.state.sliceDoc(head - 1, head) : ''
    insertAtCursor(view, slashInsertText(before))
}

/**
 * Insert a fenced code block at the caret (ADR 0018), clamped to the content column inside a
 * bullet, with the default info-string and the caret on the empty middle line.
 */
function insertCodeBlock(view: EditorView): void {
    const { state } = view
    const head = state.selection.main.head
    const line = state.doc.lineAt(head)
    const inBullet = isBulletLine(line.text)
    const fenceIndent = inBullet ? contentColumn(line.text) : lineIndent(line.text)
    const indent = ' '.repeat(fenceIndent)
    const lang = getActiveGraphSettings().defaultCodeLanguage ?? '' // bare fence unless the graph sets one
    const fence = '```'
    const block = `${fence}${lang}\n${indent}\n${indent}${fence}`

    if (inBullet && bulletContent(line.text).trim() === '') {
        // Empty bullet: the opener becomes the bullet's content (`- ```lang`), body below.
        const at = line.to
        view.dispatch({
            changes: { from: at, insert: block },
            selection: { anchor: at + `${fence}${lang}\n${indent}`.length },
            userEvent: 'input.complete',
        })
        return
    }
    const onEmptyLine = line.text.trim() === ''
    const text = onEmptyLine ? `${indent}${block}` : `\n${indent}${block}`
    const at = onEmptyLine ? line.from : head
    const lead = onEmptyLine ? 0 : 1 // the leading '\n' when not on an empty line
    const anchor = at + lead + `${indent}${fence}${lang}\n${indent}`.length
    view.dispatch({ changes: { from: at, insert: text }, selection: { anchor }, userEvent: 'input.complete' })
}

/**
 * The insert-table Command. Refuses where no table can go (`tableInsertable`: fenced code,
 * frontmatter, inside a table). Bare, it opens the Table Size Picker at the caret; given a size
 * it inserts at once, where the caret's line puts it (`table-insert.ts`).
 */
function insertTable(view: EditorView, arg?: unknown): void {
    if (!tableInsertable(view.state)) return
    const size = tableSizeArg(arg)
    if (size) {
        acceptTableSize(view, size)
        return
    }
    view.dispatch({ effects: openTableSizePicker.of({ pos: view.state.selection.main.head }) })
}

/** The `{ enabled }` a Command Menu row passes; undefined (a toggle) for anything else. */
function spellCheckArg(arg: unknown): boolean | undefined {
    if (typeof arg !== 'object' || arg === null) return undefined
    const { enabled } = arg as { enabled?: unknown }
    return typeof enabled === 'boolean' ? enabled : undefined
}

/** A `{ cols, rows }` argument, clamped to the picker's grid; undefined for anything else. */
function tableSizeArg(arg: unknown): TableSize | undefined {
    if (typeof arg !== 'object' || arg === null) return undefined
    const { cols, rows } = arg as Partial<TableSize>
    if (typeof cols !== 'number' || typeof rows !== 'number') return undefined
    return clampTableSize({ cols, rows })
}
