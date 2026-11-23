/**
 * The first-party **editor Commands** the Command Menu surfaces (Dual Mode Editor.md →
 * *Command Menu*): date insertion (Today / Yesterday / Tomorrow / Date Picker) and the ten table-editing actions.
 * Each is registered with the Command registry (id → handler) and reaches the live editor
 * through `getActiveEditorView()` — so the same Commands are invocable later from a
 * keybinding that holds no view. The matching menu-item descriptors are registered with the
 * Contribution registry (the `command-menu` kind); each descriptor's `command` is one of the
 * ids below. Handlers no-op when no editor is focused or the caret is not in a table.
 */

import { indentLess, indentMore, moveLineDown, moveLineUp } from '@codemirror/commands'
import type { EditorView } from '@codemirror/view'

import { showNotice } from '#lib/activity/notices.js'

import {
    anchorFromArg,
    type CommandBarItem,
    type CommandMenuItem,
    type CommandRegistry,
    type ContextMenuItem,
    type ContributionRegistry,
    isTableTarget,
    registerCommandBarItem,
    registerCommandMenuItem,
    registerContextMenuItem,
} from '../../surface'
import { getActiveEditorView } from '../active-editor'
import { openLineMenuAtCaret } from '../view/augmentations/bookmarks'
import { getActiveGraphSettings } from '../active-graph-settings'
import { zoomEditorFont } from '../editor-font'
import { isSpellCheckEnabled, setSpellCheckEnabled, toggleSpellCheck } from '../spell-check-preference'
import { bulletContent, contentColumn, isBulletLine, lineIndent } from '../outliner'
import {
    indentBranch,
    moveBranchDown,
    moveBranchUp,
    outdentBranch,
    toggleBullet,
    toggleFoldAtCaret,
    toggleTask,
} from '../view/outliner-keymap'
import { indentListItem, outdentListItem } from '../view/list-items-keymap'
import { isTextFile } from '../view/text-file-facet'
import type { Align, MarkdownTable } from '../markdown-table'
import {
    addColumns,
    addRows,
    formatTable,
    removeColumn,
    removeColumnsLeft,
    removeColumnsRight,
    removeRow,
    removeRowsAbove,
    removeRowsBelow,
    setColumnAlign,
} from '../markdown-table-edit'
import { formatISODate, shiftDate } from '../calendar/month-grid-core'
import { openDateCalendar } from '../view/augmentations/date-calendar'
import { acceptTableSize, openTableSizePicker } from '../view/augmentations/table-size-picker'
import { clampTableSize, type TableSize } from '../view/augmentations/table-size-picker-core'
import { openAssetPicker } from '../view/asset-picker'
import { cellBlock, editTableAsText } from '../view/table-cell'
import { removeColumns, removeRows } from '../table-cells'
import { cellInputView } from '../view/augmentations/table-cell-editor'
import { bodyWritable } from '../view/body-writable'
import { redoCommand, undoCommand } from '../view/editor-history'
import { type TableCaret, tableAtCaret, tableInsertable } from '../view/table-context'
import { type CaretCell, editTableAtCaret } from '../view/table-edit'
import { toggleBold, toggleHighlight, toggleItalic, wikilinkButtonSpec } from '../view/wrap-selection'

/** Insert `text` at the caret and place the cursor after it. */
function insertAtCursor(view: EditorView, text: string, userEvent = 'input.complete'): void {
    const at = view.state.selection.main.head
    view.dispatch({
        changes: { from: at, insert: text },
        selection: { anchor: at + text.length },
        userEvent,
    })
}

/**
 * The wikilink to the day `offset` days from today: `[[YYYY-MM-DD]]`, the journal entry's name.
 * The clock is read when the command runs, never cached, because a tab stays open for days.
 */
function dayLink(offset: number): string {
    return `[[${formatISODate(shiftDate(new Date(), offset))}]]`
}

/**
 * What a [[Plain Folder]] leaves out of the editor's Commands, by id: the ones that write a graph's
 * syntax (a day as a wikilink, `[[`, a task's tags) or act on a graph (its search).
 * A file there is plain markdown, and a row that wrote `[[2026-11-21]]` into it would write text.
 */
const GRAPH_ONLY = new Set([
    'date.today',
    'date.yesterday',
    'date.tomorrow',
    'date.pick',
    'editor.insertWikilinkOpen',
    'editor.insertWikilinkClose',
    'task.bar.priority',
    'task.bar.status',
    'task.bar.due',
    'task.bar.menu',
    'search.open',
    'asset.upload',
])

/**
 * Register the date + table Commands and their Command Menu descriptors. Returns a teardown.
 * With `plain`, for a Plain Folder's workspace, the graph's own are left out ({@link GRAPH_ONLY}).
 */
export function registerEditorCommands(
    commands: CommandRegistry,
    contributions: ContributionRegistry,
    options: { plain?: boolean } = {},
): () => void {
    const offs: (() => void)[] = []
    const wanted = (id: string) => !(options.plain && GRAPH_ONLY.has(id))
    const command = (id: string, handler: (arg?: unknown) => void) => {
        if (wanted(id)) offs.push(commands.register(id, handler))
    }
    const item = (descriptor: CommandMenuItem) => {
        if (wanted(descriptor.id)) offs.push(registerCommandMenuItem(contributions, descriptor))
    }
    const menuRow = (descriptor: ContextMenuItem) => {
        if (wanted(descriptor.id)) offs.push(registerContextMenuItem(contributions, descriptor))
    }
    const barItem = (descriptor: CommandBarItem) => {
        if (wanted(descriptor.id)) offs.push(registerCommandBarItem(contributions, descriptor))
    }

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
        withWritableView((view) => void editTableAtCaret(view, transform, after))

    // ── Editor block-op Commands (the Command Bar's invokers) ─────────────────
    // Thin wrappers over the CM-native outliner commands, reachable from the mobile
    // Command Bar (and any future keybinding/palette). The keymap still calls the CM
    // commands directly — these wrappers are additive (Dual Mode Editor.md → Command Bar).
    // A file in the Text Editor has no outline: indent and move act on its lines, and the rest do nothing.
    const inOutline = (fn: (view: EditorView) => void) => withWritableView((view) => void (view.state.facet(isTextFile) || fn(view)))
    // In a Plain Folder the other list kinds answer first, as they do to the keys (list-items-keymap.ts).
    command('editor.indent', withWritableView((view) => void (view.state.facet(isTextFile) ? indentMore(view) : indentListItem(view) || indentBranch(view))))
    command('editor.outdent', withWritableView((view) => void (view.state.facet(isTextFile) ? indentLess(view) : outdentListItem(view) || outdentBranch(view))))
    command('editor.moveUp', withWritableView((view) => void (view.state.facet(isTextFile) ? moveLineUp(view) : moveBranchUp(view))))
    command('editor.moveDown', withWritableView((view) => void (view.state.facet(isTextFile) ? moveLineDown(view) : moveBranchDown(view))))
    command('editor.toggleTask', inOutline((view) => void toggleTask(view)))
    command('editor.toggleBullet', inOutline((view) => void toggleBullet(view)))
    command('editor.toggleFold', withView((view) => void toggleFoldAtCaret(view)))
    // In a table's cell the menu opens in the cell's own editor, where the caret is drawn (table-cell-editor.ts).
    command('editor.openCommandMenu', withView((view) => openCommandMenu(cellInputView(view))))
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
    command('date.today', withWritableView((view) => insertAtCursor(view, dayLink(0))))
    command('date.yesterday', withWritableView((view) => insertAtCursor(view, dayLink(-1))))
    command('date.tomorrow', withWritableView((view) => insertAtCursor(view, dayLink(1))))
    command(
        'date.pick',
        withWritableView((view) => {
            // The calendar opens at the caret, which in a table's cell is the cell's own editor's.
            const at = cellInputView(view)
            at.dispatch({ effects: openDateCalendar.of({ pos: at.state.selection.main.head }) })
        }),
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
    // Above and below, left and right: the grid's row and column menus (and the Command Menu's rows).
    // Each puts the caret in the new row or column, where the next thing typed belongs. A table
    // always has its header first, so nothing goes above it.
    command('table.addRowAbove', tableEdit((h) => (h.bodyRow >= 0 ? addRows(h.table, 1, h.bodyRow - 1) : null)))
    command('table.addRowBelow', tableEdit((h) => addRows(h.table, 1, Math.max(h.bodyRow, -1)), (h) => ({ bodyRow: Math.max(h.bodyRow, -1) + 1, column: h.column })))
    command('table.addColumnLeft', tableEdit((h) => addColumns(h.table, h.column - 1, 1)))
    command('table.addColumnRight', tableEdit((h) => addColumns(h.table, h.column, 1), (h) => ({ bodyRow: h.bodyRow, column: h.column + 1 })))
    // A column's alignment, written in its delimiter cell. Choosing the one it has takes it off again.
    const align = (value: Align) => tableEdit((h) => setColumnAlign(h.table, h.column, h.table.align[h.column] === value ? null : value))
    command('table.alignLeft', align('left'))
    command('table.alignCenter', align('center'))
    command('table.alignRight', align('right'))
    command('table.format', tableEdit((h) => formatTable(h.table)))
    // Show the table's markdown in place of its grid, until the caret leaves the table
    // (`tablesAsTextField`, table-cell.ts). The caret stays where it was, now in the row's text, and the keyboard
    // goes with it: the cell's editor hands it back to the document's as it goes (table-cell-editor.ts).
    command(
        'table.editAsText',
        withWritableView((view) => {
            const hit = tableAtCaret(view.state)
            if (!hit) return
            view.dispatch({ effects: editTableAsText.of(hit.from) })
        }),
    )
    // With a block of cells selected in the grid, every row or column of the block goes (ADR 0205).
    command(
        'table.removeRow',
        withWritableView((view) => {
            const rect = cellBlock(view.state)?.rect
            if (rect) editTableAtCaret(view, (h) => removeRows(h.table, rect.top, rect.bottom), (h) => ({ bodyRow: h.bodyRow < 0 ? h.bodyRow : Math.max(rect.top, 0), column: h.column }))
            else editTableAtCaret(view, (h) => removeRow(h.table, h.bodyRow))
        }),
    )
    command(
        'table.removeColumn',
        withWritableView((view) => {
            const rect = cellBlock(view.state)?.rect
            if (rect) editTableAtCaret(view, (h) => removeColumns(h.table, rect.left, rect.right), (h) => ({ bodyRow: h.bodyRow, column: rect.left }))
            else editTableAtCaret(view, (h) => removeColumn(h.table, h.column))
        }),
    )
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
    barItem({ id: 'editor.openCommandMenu', icon: 'slash', label: 'Commands', order: 0, command: 'editor.openCommandMenu', writableOnly: true, markdownOnly: true })
    // The table group is a Contextual Group (CONTEXT.md → Command Bar): present only while the
    // caret is in a table, absent otherwise, and placed right after the slash button so it is on
    // screen without scrolling. Its remove buttons grey where their Command would refuse - the
    // header and separator rows, a single column. The six rarer table edits stay Menu-only.
    barItem({ id: 'table.addRow', icon: 'table-add-row', label: 'Add row', order: 0, command: 'table.addRow', contextualGroup: 'table', writableOnly: true })
    barItem({ id: 'table.addColumn', icon: 'table-add-column', label: 'Add column', order: 0, command: 'table.addColumn', contextualGroup: 'table', writableOnly: true })
    barItem({ id: 'table.removeRow', icon: 'table-remove-row', label: 'Remove row', order: 0, command: 'table.removeRow', contextualGroup: 'table', tableRowOnly: true, writableOnly: true })
    barItem({ id: 'table.removeColumn', icon: 'table-remove-column', label: 'Remove column', order: 0, command: 'table.removeColumn', contextualGroup: 'table', tableMultiColumnOnly: true, writableOnly: true })
    // The task group is a Contextual Group too: present only while the caret is on a task line,
    // after the slash button. A phone has no right-click, so it holds what the line's menu offers a
    // desktop: Priority and Status open that menu with only their rows, Due date the calendar the
    // tag menu's "Due date…" row opens, and the last button the whole menu (Open in task editor,
    // Copy agent instruction). The rows write the line as they do from a right-click.
    // Each opens its menu from the button pressed (`anchored`: the bar hands the Command the
    // button's box), rising above the bar, rather than at the caret, which may be anywhere on screen.
    command('task.bar.priority', withWritableView((view, arg) => void openLineMenuAtCaret(view, 'task.setPriority.', anchorFromArg(arg))))
    command('task.bar.status', withWritableView((view, arg) => void openLineMenuAtCaret(view, 'task.setStatus.', anchorFromArg(arg))))
    command('task.bar.menu', withView((view, arg) => void openLineMenuAtCaret(view, undefined, anchorFromArg(arg))))
    command(
        'task.bar.due',
        withWritableView((view, arg) =>
            view.dispatch({
                effects: openDateCalendar.of({ pos: view.state.selection.main.head, target: { kind: 'task-tag', tag: 'due' }, anchor: anchorFromArg(arg) ?? undefined }),
            }),
        ),
    )
    barItem({ id: 'task.bar.priority', icon: 'flag', label: 'Priority', order: 0, command: 'task.bar.priority', contextualGroup: 'task', writableOnly: true, anchored: true })
    barItem({ id: 'task.bar.status', icon: 'check', label: 'Status', order: 0, command: 'task.bar.status', contextualGroup: 'task', writableOnly: true, anchored: true })
    barItem({ id: 'task.bar.due', icon: 'calendar', label: 'Due date', order: 0, command: 'task.bar.due', contextualGroup: 'task', writableOnly: true, anchored: true })
    barItem({ id: 'task.bar.menu', icon: 'more', label: 'Task menu', order: 0, command: 'task.bar.menu', contextualGroup: 'task', anchored: true })
    // The bullet toggle is the first fixed button after the slash: making a line a bullet, or a
    // bullet prose again, is the block edit a phone reaches for most. Prose (a blank line included)
    // becomes a bullet and a bullet at column 0 becomes prose. A nested bullet greys it, since as
    // prose it would split its tree. It shows pressed on a bullet, so the button says which way a
    // tap goes. Inside a table the table group comes first (order 0) and this is greyed.
    barItem({ id: 'editor.toggleBullet', icon: 'bullet', label: 'Bullet', order: 1, command: 'editor.toggleBullet', bulletToggleOnly: true, pressed: 'bullet', writableOnly: true })
    barItem({
        id: 'editor.insertWikilinkOpen',
        icon: 'wikilink-open',
        label: 'Insert [[',
        order: 2,
        command: 'editor.insertWikilinkOpen',
        writableOnly: true,
    })
    barItem({
        id: 'editor.insertWikilinkClose',
        icon: 'wikilink-close',
        label: 'Insert ]]',
        order: 3,
        command: 'editor.insertWikilinkClose',
        writableOnly: true,
    })
    barItem({ id: 'asset.upload', icon: 'image', label: 'Upload', order: 8, command: 'asset.upload', writableOnly: true })
    // Insert is never dead the way the edits are, so it is a fixed button: greyed only where no
    // table can go (code, frontmatter, inside a table), where its Command refuses.
    barItem({ id: 'table.insert', icon: 'table', label: 'Insert table', order: 9, command: 'table.insert', tableInsertOnly: true, writableOnly: true })
    // Outdent and Indent come straight after the `[[ ]]` pair (orders 4 and 5): with the bullet
    // toggle they are how a phone shapes an outline while typing, so they sit in the strip's first
    // screenful, ahead of the task toggle.
    barItem({ id: 'editor.outdent', icon: 'outdent', label: 'Outdent', order: 4, command: 'editor.outdent', outlinerOnly: true, actsOnTextLines: true, writableOnly: true })
    // Indent is live on prose too: there it makes the line a block (the mobile way into block mode).
    barItem({ id: 'editor.indent', icon: 'indent', label: 'Indent', order: 5, command: 'editor.indent', convertibleOnly: true, writableOnly: true })
    barItem({ id: 'editor.moveUp', icon: 'move-up', label: 'Move up', order: 30, command: 'editor.moveUp', outlinerOnly: true, actsOnTextLines: true, writableOnly: true })
    barItem({ id: 'editor.moveDown', icon: 'move-down', label: 'Move down', order: 40, command: 'editor.moveDown', outlinerOnly: true, actsOnTextLines: true, writableOnly: true })
    // Order 6, after Outdent and Indent, not 50 among the block ops: on a phone the strip
    // scrolls, and at 50 the one button people reach for on a task was off-screen.
    // `taskToggleOnly`, not `outlinerOnly`: on prose the toggle MAKES the line a task, so the
    // button is live there too; it is disabled only where the command refuses (heading, code,
    // frontmatter) — the two read the same predicate.
    barItem({ id: 'editor.toggleTask', icon: 'task', label: 'Toggle task', order: 6, command: 'editor.toggleTask', taskToggleOnly: true, writableOnly: true })
    // Order 7, at the edge of the strip's first screenful: undo is the button reached for in a hurry, and a
    // soft keyboard has no Mod-z. Greyed on an empty stack (`undoOnly` / `redoOnly` ←
    // `editorContext.canUndo` / `canRedo`), so the pair also shows whether there is anything to undo.
    barItem({ id: 'editor.undo', icon: 'undo', label: 'Undo', order: 7, command: 'editor.undo', undoOnly: true, writableOnly: true })
    barItem({ id: 'editor.redo', icon: 'redo', label: 'Redo', order: 7, command: 'editor.redo', redoOnly: true, writableOnly: true })
    barItem({ id: 'editor.toggleFold', icon: 'fold', label: 'Fold', order: 60, command: 'editor.toggleFold', outlinerOnly: true })
    // Last of the scrolling buttons: the pinned group at the bar's right end is for the buttons
    // extensions pin there, and zoom is set once and left.
    barItem({ id: 'editor.zoomOut', icon: 'zoom-out', label: 'Decrease font size', order: 100, command: 'editor.zoomOut' })
    barItem({ id: 'editor.zoomIn', icon: 'zoom-in', label: 'Increase font size', order: 110, command: 'editor.zoomIn' })

    // ── Command Menu descriptors ──────────────────────────────────────────────
    // Every row that writes to the body is hidden on a locked Protected Document (the menu's
    // vocabulary is hide, not grey); Search stays, which is why the menu itself stays reachable.
    // Each row's `group` is the heading it is listed under (Insert, Go to, Settings) and its `order`
    // places it among the other modules' rows of that group; command-menu-order.test.ts writes the
    // whole order down. Insert leads with the rows reached for most: Table, Today, Upload asset,
    // Code block. The rows for the table the caret is in come where Table would, which is hidden there.
    // `actsOnText` marks the rows that insert, format or edit the text at the caret: the only ones an
    // editor showing part of a document offers (the Task Editor, ADR 0170). Search, Find and replace,
    // Reset workspace and Spell check act on the graph, the tab, the workspace or a setting.
    const writable = (ctx: { bodyWritable: boolean }) => ctx.bodyWritable
    const inTable = (ctx: { inTable: boolean; bodyWritable: boolean }) => ctx.inTable && ctx.bodyWritable
    const insertable = (ctx: { tableInsertable: boolean; bodyWritable: boolean }) => ctx.tableInsertable && ctx.bodyWritable
    item({ id: 'search.open', title: 'Search', detail: 'Search names and text across this graph', icon: 'search', group: 'Go to', order: 10, keywords: ['find', 'text', 'full', 'grep'], command: 'search.open' })
    // Find and Replace in this document (ADR 0153): the way in on a phone, which has no Ctrl+F. Not
    // gated on `bodyWritable`: find still reads a locked document's frontmatter, and the box says
    // why it cannot replace.
    item({ id: 'document.findReplace', title: 'Find and replace', detail: 'Find text in this document, and replace it', icon: 'search', group: 'Go to', order: 11, keywords: ['find', 'replace', 'search', 'match', 'text'], command: 'document.findReplace' })
    // Opens a confirmation, never resets on its own; not gated on `bodyWritable`, because it
    // touches the Layout and nothing in any document.
    item({ id: 'workspace.reset', title: 'Reset workspace', detail: 'Close every tab and put the sidebars back to their defaults', icon: 'reset', group: 'Settings', order: 200, keywords: ['layout', 'panes', 'tabs', 'sidebars', 'default'], command: 'workspace.reset' })
    // One row at a time, naming the change it makes. Not gated on `bodyWritable`: the preference
    // writes to no document, so it stays on a locked Protected Document (where it has no effect).
    item({ id: 'editor.spellCheckOff', title: 'Spell check: turn off', detail: 'Stop underlining misspellings on this device', icon: 'spell-check', group: 'Settings', order: 180, keywords: ['spelling', 'spellcheck', 'dictionary'], when: () => isSpellCheckEnabled(), command: 'editor.toggleSpellCheck', args: { enabled: false } })
    item({ id: 'editor.spellCheckOn', title: 'Spell check: turn on', detail: 'Underline misspellings on this device', icon: 'spell-check', group: 'Settings', order: 180, keywords: ['spelling', 'spellcheck', 'dictionary'], when: () => !isSpellCheckEnabled(), command: 'editor.toggleSpellCheck', args: { enabled: true } })
    item({ id: 'asset.upload', title: 'Upload asset', detail: 'Insert an image or file', icon: 'image', group: 'Insert', order: 30, keywords: ['image', 'file', 'attach', 'upload', 'photo'], when: writable, command: 'asset.upload', actsOnText: true })
    item({ id: 'date.today', title: 'Today', detail: 'Insert today as a wikilink', icon: 'today', group: 'Insert', order: 20, keywords: ['now'], when: writable, command: 'date.today', actsOnText: true })
    item({ id: 'date.yesterday', title: 'Yesterday', detail: 'Insert yesterday as a wikilink', icon: 'yesterday', group: 'Insert', order: 60, keywords: ['previous', 'last'], when: writable, command: 'date.yesterday', actsOnText: true })
    item({ id: 'date.tomorrow', title: 'Tomorrow', detail: 'Insert tomorrow as a wikilink', icon: 'tomorrow', group: 'Insert', order: 61, keywords: ['next'], when: writable, command: 'date.tomorrow', actsOnText: true })
    item({ id: 'date.pick', title: 'Date Picker', detail: 'Pick a date to insert', icon: 'calendar', group: 'Insert', order: 50, keywords: ['date', 'calendar'], when: writable, command: 'date.pick', actsOnText: true })
    // The menu's `/` has replaced any selection by the time a row runs, so from here a toggle
    // opens an empty pair with the caret inside; the wrap keys and chords are the selection path.
    item({ id: 'editor.bold', title: 'Bold', detail: 'Wrap in **, or open an empty pair', icon: 'bold', group: 'Insert', order: 120, keywords: ['strong', 'format'], when: writable, command: 'editor.bold', actsOnText: true })
    item({ id: 'editor.italic', title: 'Italic', detail: 'Wrap in *, or open an empty pair', icon: 'italic', group: 'Insert', order: 121, keywords: ['emphasis', 'format'], when: writable, command: 'editor.italic', actsOnText: true })
    item({ id: 'editor.highlight', title: 'Highlight', detail: 'Wrap in ==, or open an empty pair', icon: 'highlight', group: 'Insert', order: 122, keywords: ['mark', 'marker', 'format'], when: writable, command: 'editor.highlight', actsOnText: true })
    item({ id: 'editor.insertCodeBlock', title: 'Code block', detail: 'Insert a fenced code block', icon: 'code', group: 'Insert', order: 40, keywords: ['code', 'fence', 'snippet', 'pre'], when: writable, command: 'editor.insertCodeBlock', actsOnText: true })
    item({ id: 'table.insert', title: 'Table', detail: 'Insert a table (choose its size)', icon: 'table', group: 'Insert', order: 10, keywords: ['grid'], when: insertable, command: 'table.insert', actsOnText: true })
    item({ id: 'table.addColumn', title: 'Table: Add column', detail: 'Add a column after this one', icon: 'table-add-column', group: 'Insert', order: 12, when: inTable, command: 'table.addColumn', actsOnText: true })
    item({ id: 'table.addRow', title: 'Table: Add row', detail: 'Add a row below', icon: 'table-add-row', group: 'Insert', order: 12, when: inTable, command: 'table.addRow', actsOnText: true })
    item({ id: 'table.addRowAbove', title: 'Table: Add row above', detail: 'Above this one', icon: 'table-add-row', group: 'Insert', order: 12, when: inTable, command: 'table.addRowAbove', actsOnText: true })
    item({ id: 'table.addColumnLeft', title: 'Table: Add column left', detail: 'Before this one', icon: 'table-add-column', group: 'Insert', order: 12, when: inTable, command: 'table.addColumnLeft', actsOnText: true })
    item({ id: 'table.alignLeft', title: 'Table: Align left', detail: 'This column', icon: 'align-left', group: 'Insert', order: 12, when: inTable, command: 'table.alignLeft', actsOnText: true })
    item({ id: 'table.alignCenter', title: 'Table: Align centre', detail: 'This column', icon: 'align-center', group: 'Insert', order: 12, keywords: ['center', 'middle'], when: inTable, command: 'table.alignCenter', actsOnText: true })
    item({ id: 'table.alignRight', title: 'Table: Align right', detail: 'This column', icon: 'align-right', group: 'Insert', order: 12, when: inTable, command: 'table.alignRight', actsOnText: true })
    item({ id: 'table.editAsText', title: 'Table: Edit as text', detail: 'Show the markdown of this table', icon: 'code', group: 'Insert', order: 12, when: inTable, command: 'table.editAsText', actsOnText: true })
    item({ id: 'table.format', title: 'Table: Format', detail: 'Normalise column widths', icon: 'table-format', group: 'Insert', order: 12, when: inTable, command: 'table.format', actsOnText: true })
    item({ id: 'table.removeRow', title: 'Table: Remove row', detail: 'Remove the current row', icon: 'table-remove-row', group: 'Insert', order: 12, when: inTable, command: 'table.removeRow', actsOnText: true })
    item({ id: 'table.removeColumn', title: 'Table: Remove column', detail: 'Remove the current column', icon: 'table-remove-column', group: 'Insert', order: 12, when: inTable, command: 'table.removeColumn', actsOnText: true })
    item({ id: 'table.removeRowsAbove', title: 'Table: Remove rows above', detail: 'Remove rows above', icon: 'table-remove-row', group: 'Insert', order: 12, when: inTable, command: 'table.removeRowsAbove', actsOnText: true })
    item({ id: 'table.removeRowsBelow', title: 'Table: Remove rows below', detail: 'Remove rows below', icon: 'table-remove-row', group: 'Insert', order: 12, when: inTable, command: 'table.removeRowsBelow', actsOnText: true })
    item({ id: 'table.removeColumnsRight', title: 'Table: Remove columns right', detail: 'Remove columns to the right', icon: 'table-remove-column', group: 'Insert', order: 12, when: inTable, command: 'table.removeColumnsRight', actsOnText: true })
    item({ id: 'table.removeColumnsLeft', title: 'Table: Remove columns left', detail: 'Remove columns to the left', icon: 'table-remove-column', group: 'Insert', order: 12, when: inTable, command: 'table.removeColumnsLeft', actsOnText: true })

    // ── The Table Grid's row and column menus (ADR 0205) ──────────────────────
    // Raised by the handles on the grid (markdown-table.ts). The press that raises one has put the
    // caret in that row and column, so each row is the Command the Command Menu runs at the caret.
    const onRow = (target: Parameters<NonNullable<ContextMenuItem['when']>>[0]) => target.kind === 'table-row'
    const onColumn = (target: Parameters<NonNullable<ContextMenuItem['when']>>[0]) => target.kind === 'table-column'
    const aligned = (value: Align) => (target: Parameters<NonNullable<ContextMenuItem['checked']>>[0]) => isTableTarget(target) && target.align === value
    menuRow({ id: 'table.addRowAbove', label: 'Add row above', icon: 'table-add-row', order: 10, command: 'table.addRowAbove', when: (target) => isTableTarget(target) && onRow(target) && !target.header })
    menuRow({ id: 'table.addRowBelow', label: 'Add row below', icon: 'table-add-row', order: 11, command: 'table.addRowBelow', when: onRow })
    menuRow({ id: 'table.addColumnLeft', label: 'Add column left', icon: 'table-add-column', order: 10, command: 'table.addColumnLeft', when: onColumn })
    menuRow({ id: 'table.addColumnRight', label: 'Add column right', icon: 'table-add-column', order: 11, command: 'table.addColumnRight', when: onColumn })
    menuRow({ id: 'table.alignLeft', label: 'Align left', order: 20, command: 'table.alignLeft', separatorBefore: true, when: onColumn, checked: aligned('left') })
    menuRow({ id: 'table.alignCenter', label: 'Align centre', order: 21, command: 'table.alignCenter', when: onColumn, checked: aligned('center') })
    menuRow({ id: 'table.alignRight', label: 'Align right', order: 22, command: 'table.alignRight', when: onColumn, checked: aligned('right') })
    menuRow({ id: 'table.editAsText', label: 'Edit table as text', icon: 'code', order: 30, command: 'table.editAsText', separatorBefore: true, when: isTableTarget })
    menuRow({ id: 'table.removeRow', label: (target) => (isTableTarget(target) && target.selectedRows > 1 ? `Remove ${target.selectedRows} rows` : 'Remove row'), icon: 'table-remove-row', order: 40, command: 'table.removeRow', separatorBefore: true, danger: true, when: (target) => isTableTarget(target) && onRow(target) && !target.header })
    menuRow({ id: 'table.removeColumn', label: (target) => (isTableTarget(target) && target.selectedColumns > 1 ? `Remove ${target.selectedColumns} columns` : 'Remove column'), icon: 'table-remove-column', order: 40, command: 'table.removeColumn', separatorBefore: true, danger: true, when: (target) => isTableTarget(target) && onColumn(target) && target.columns > target.selectedColumns })

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
    // As typing, because the menu opens only on a typed `/` (slash-complete.ts).
    insertAtCursor(view, slashInsertText(before), 'input.type')
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
    // An empty line is replaced whole, so its own spaces do not trail the closing fence.
    const from = onEmptyLine ? line.from : head
    const to = onEmptyLine ? line.to : head
    const lead = onEmptyLine ? 0 : 1 // the leading '\n' when not on an empty line
    const anchor = from + lead + `${indent}${fence}${lang}\n${indent}`.length
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor }, userEvent: 'input.complete' })
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
