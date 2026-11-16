/**
 * The block menu (the plan "Bullet Context Actions"; Editor Content Rules → The block menu): the
 * rows a right-click or long press on a bullet's dot raises, each a [[Command]] over the bullet's
 * [[Block]] and every Block nested under it. The line menu, raised on the line's text and a task's
 * checkbox, keeps its own rows; none of these appear there.
 *
 * A row the Block cannot take is left out rather than greyed: Indent on a first child, Fold on a
 * bullet with no children, every editing row on a document that takes no text.
 */

import type { EditorState, StateCommand, TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import { showNotice } from '#lib/activity/notices.js'

import {
    type CommandRegistry,
    type ContextMenuTarget,
    type ContributionRegistry,
    isBlockTarget,
    registerContextMenuItem,
} from '../../surface'
import { bookmarkEditorFor } from '../view/augmentations/bookmarks'
import { hasFoldedDescendant, isFoldableBullet, isFoldedBullet, toggleBulletFoldSpec, unfoldBranchSpec } from '../view/augmentations/outline-folds'
import {
    blockMarkdown,
    caretSpec,
    deleteBlockSpec,
    duplicateBlockSpec,
    emptySiblingSpec,
    nestedBlockCount,
    outdentBlockSpec,
    structureSpec,
} from '../view/block-actions'
import { bodyWritable } from '../view/body-writable'
import { indentBranch, moveBranchDown, moveBranchUp, outdentBranch } from '../view/outliner-keymap'
import { dispatchPaste, readClipboard } from './paste-commands'

/** The editor and the 1-based line a block target stands on now, or null when either is gone. */
interface Found {
    view: EditorView
    line: number
}

/**
 * The target's editor and its line, while that line still holds the text it had when the menu opened.
 * Null once an edit has moved or changed it: a row then does nothing, rather than act on a bullet
 * the person did not choose.
 */
function find(target: ContextMenuTarget): Found | null {
    if (!isBlockTarget(target)) return null
    const view = bookmarkEditorFor(target.concept, target.panelId)
    if (!view) return null
    const { doc } = view.state
    return target.line <= doc.lines && doc.line(target.line).text === target.text ? { view, line: target.line } : null
}

function writable(state: EditorState): boolean {
    return !state.readOnly && bodyWritable(state)
}

function run(found: Found, spec: (state: EditorState, line: number) => TransactionSpec | null): void {
    const result = spec(found.view.state, found.line)
    if (result) found.view.dispatch(result)
}

/** Dispatch `spec` and give the editor the focus, so the caret it places is where typing goes. */
function runFocused(found: Found, spec: (state: EditorState, line: number) => TransactionSpec | null): void {
    run(found, spec)
    found.view.focus()
}

/** Put the Block's markdown on the clipboard; `say` confirms it, since the clipboard shows nothing. */
async function copyBlock(found: Found, say = true): Promise<boolean> {
    const text = blockMarkdown(found.view.state, found.line)
    if (text === null) return false
    try {
        await navigator.clipboard.writeText(text)
        if (say) showNotice({ id: 'block-copy', tone: 'info', text: 'Copied the block.' })
        return true
    } catch (error) {
        showNotice({ id: 'block-copy', tone: 'error', text: `Could not copy the block: ${error instanceof Error ? error.message : String(error)}` })
        return false
    }
}

/** Paste as a sibling of the Block: the clipboard read first, so a refusal leaves no empty bullet behind. */
async function pasteBeside(target: ContextMenuTarget, where: 'before' | 'after'): Promise<void> {
    find(target)?.view.focus()
    const data = await readClipboard()
    if (!data) return
    // The read waits on the browser: the Block is found again, in the text as it is now.
    const found = find(target)
    const spec = found ? emptySiblingSpec(found.view.state, found.line, where) : null
    if (!found || !spec) return
    found.view.dispatch(spec)
    dispatchPaste(found.view, data)
}

/** One row: its Command, label, when it shows, and the group it is drawn in. */
interface Row {
    id: string
    label: string | ((found: Found) => string)
    group: number
    icon?: string
    danger?: boolean
    /** Whether the row applies; it is not shown on a document that takes no text unless `readOnly` says it may be. */
    applies: (found: Found) => boolean
    /** Shown only when a touch opened the menu. */
    touchOnly?: boolean
    readOnly?: boolean
    run: (found: Found, target: ContextMenuTarget) => void | Promise<unknown>
}

const structural = (command: StateCommand) => (state: EditorState, line: number) => structureSpec(state, line, command)

const ROWS: Row[] = [
    {
        id: 'block.fold',
        label: ({ view, line }) => (isFoldedBullet(view.state, line) ? 'Unfold' : 'Fold'),
        group: 1,
        icon: 'fold',
        readOnly: true,
        applies: ({ view, line }) => isFoldableBullet(view.state, line),
        run: (found) => run(found, toggleBulletFoldSpec),
    },
    {
        id: 'block.unfoldAll',
        label: 'Unfold all inside',
        group: 1,
        readOnly: true,
        applies: ({ view, line }) => hasFoldedDescendant(view.state, line),
        run: (found) => run(found, unfoldBranchSpec),
    },
    {
        id: 'block.cursorStart',
        label: 'Cursor to start',
        group: 2,
        readOnly: true,
        touchOnly: true,
        applies: () => true,
        run: (found) => runFocused(found, (state, line) => caretSpec(state, line, 'start')),
    },
    {
        id: 'block.cursorEnd',
        label: 'Cursor to end',
        group: 2,
        readOnly: true,
        touchOnly: true,
        applies: () => true,
        run: (found) => runFocused(found, (state, line) => caretSpec(state, line, 'end')),
    },
    { id: 'block.copy', label: 'Copy block', group: 3, icon: 'copy', readOnly: true, applies: () => true, run: (found) => copyBlock(found) },
    {
        id: 'block.cut',
        label: 'Cut block',
        group: 3,
        applies: () => true,
        run: async (found) => {
            if (!(await copyBlock(found, false))) return
            run(found, (state, line) => deleteBlockSpec(state, line, 'delete.cut'))
        },
    },
    { id: 'block.pasteBefore', label: 'Paste before', group: 3, applies: () => true, run: (_found, target) => pasteBeside(target, 'before') },
    { id: 'block.pasteAfter', label: 'Paste after', group: 3, applies: () => true, run: (_found, target) => pasteBeside(target, 'after') },
    { id: 'block.duplicate', label: 'Duplicate', group: 3, applies: () => true, run: (found) => run(found, duplicateBlockSpec) },
    {
        id: 'block.indent',
        label: 'Indent',
        group: 4,
        icon: 'indent',
        applies: ({ view, line }) => structureSpec(view.state, line, indentBranch) !== null,
        run: (found) => run(found, structural(indentBranch)),
    },
    {
        id: 'block.outdent',
        label: 'Outdent',
        group: 4,
        icon: 'outdent',
        applies: ({ view, line }) => outdentBlockSpec(view.state, line, outdentBranch) !== null,
        run: (found) => run(found, (state, line) => outdentBlockSpec(state, line, outdentBranch)),
    },
    {
        id: 'block.moveUp',
        label: 'Move up',
        group: 4,
        icon: 'move-up',
        applies: ({ view, line }) => structureSpec(view.state, line, moveBranchUp) !== null,
        run: (found) => run(found, structural(moveBranchUp)),
    },
    {
        id: 'block.moveDown',
        label: 'Move down',
        group: 4,
        icon: 'move-down',
        applies: ({ view, line }) => structureSpec(view.state, line, moveBranchDown) !== null,
        run: (found) => run(found, structural(moveBranchDown)),
    },
    {
        id: 'block.delete',
        label: ({ view, line }) => {
            const nested = nestedBlockCount(view.state, line)
            return nested === 0 ? 'Delete block' : `Delete block and ${nested} inside`
        },
        group: 5,
        icon: 'trash',
        danger: true,
        applies: () => true,
        run: (found) => run(found, deleteBlockSpec),
    },
]

/**
 * Whether `row` is shown for the target's Block. The rows that place the caret are a touch screen's:
 * a mouse puts the caret at a line's start or end in one click, a finger cannot reliably.
 */
function shown(row: Row, found: Found | null, target: ContextMenuTarget): found is Found {
    if (!found) return false
    if (row.touchOnly && !(isBlockTarget(target) && target.touch)) return false
    if (!row.readOnly && !writable(found.view.state)) return false
    return row.applies(found)
}

export function registerBlockCommands(commands: CommandRegistry, contributions: ContributionRegistry): () => void {
    const disposers: (() => void)[] = []
    ROWS.forEach((row, index) => {
        disposers.push(commands.register(row.id, (arg) => {
            const target = arg && typeof arg === 'object' ? (arg as ContextMenuTarget) : null
            const found = target ? find(target) : null
            if (target && shown(row, found, target)) void row.run(found, target)
        }))
        disposers.push(
            registerContextMenuItem(contributions, {
                id: row.id,
                label: (target) => {
                    const found = find(target)
                    return typeof row.label === 'string' ? row.label : found ? row.label(found) : ''
                },
                command: row.id,
                order: 10 + index,
                ...(row.icon ? { icon: row.icon } : {}),
                ...(row.danger ? { danger: true } : {}),
                // A rule above the first row shown of each group, whichever of its rows the Block takes.
                separatorBefore: (target) => {
                    const found = find(target)
                    return !ROWS.slice(0, index).some((earlier) => earlier.group === row.group && shown(earlier, found, target))
                },
                when: (target) => isBlockTarget(target) && shown(row, find(target), target),
            }),
        )
    })
    return () => {
        for (const dispose of disposers.splice(0)) dispose()
    }
}
