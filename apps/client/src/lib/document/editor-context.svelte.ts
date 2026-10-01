/**
 * The reactive editor context the Command Bar reads to disable its buttons and to show the bullet
 * toggle pressed. It disables the outliner-only ones when the caret is not in an outliner block (a
 * bullet or task line), and every editing one when the document's body will not take an edit (a
 * locked Protected Document). A shared rune-state singleton (the Svelte 5 cross-component pattern),
 * updated by the active editor on every selection / doc change, by the workspace on every lock
 * transition, and reset to `false` when no editor is focused.
 *
 * "Active" is singular today (one focused editor at a time), mirroring `active-editor.ts`.
 */

import type { EditorView } from '@codemirror/view'

import { getActiveEditorView } from './active-editor'
import { bodyWritable } from './view/body-writable'
import { canRedo, canUndo } from './view/editor-history'
import { misspellingAt } from './view/augmentations/spell-check'
import { tableAtCaret, tableInsertable } from './view/table-context'
import { bulletToggleable, bulletToggleOn, indentable, outlinerBulletAtCaret, taskToggleable } from './view/task-toggleable'

/** What the Command Bar's table group needs to know about the table under the caret. */
export interface EditorTableContext {
    /** 0-based body row, negative on the header or separator (where Remove row has nothing to do). */
    bodyRow: number
    /** Column count (Remove column has nothing to do on a single column). */
    columns: number
}

export const editorContext = $state<{
    inOutlinerBlock: boolean
    taskToggleable: boolean
    bulletToggleable: boolean
    bulletToggleOn: boolean
    indentable: boolean
    bodyWritable: boolean
    tableInsertable: boolean
    table: EditorTableContext | null
    canUndo: boolean
    canRedo: boolean
    misspelling: boolean
}>({
    inOutlinerBlock: false,
    /** The task button's own, wider gate: prose counts, headings / code / frontmatter do not. */
    taskToggleable: false,
    /**
     * The bullet button's gate: prose and a bullet at column 0 count, a nested bullet, a heading,
     * code, frontmatter, a table row and a block selection do not, nor a bullet whose leaving the list
     * would pair a fence differently or move the frontmatter (`view/task-toggleable.ts`). Computed
     * only while a Command Bar is mounted (`registerCommandBar`), and false otherwise.
     */
    bulletToggleable: false,
    /** Whether the line the bullet toggle acts on is a bullet: the bullet button shows pressed. */
    bulletToggleOn: false,
    /** The Indent button's gate: the task button's, and a form-1 opener too (`view/task-toggleable.ts`). */
    indentable: false,
    /**
     * The reactive mirror of `bodyWritable(view.state)` for the active editor: false on a locked
     * Protected Document, where every editing Command is off (`view/body-writable.ts`). The
     * Command handlers ask the predicate itself; this is only what the bar greys on.
     */
    bodyWritable: false,
    /** The insert-table button's gate: off in fenced code, frontmatter and inside a table. */
    tableInsertable: false,
    /**
     * The table the caret is in, or null. The bar's table group (CONTEXT.md → Command Bar,
     * *Contextual Group*) is present exactly while this is non-null, and its remove buttons grey
     * from the row and column counts here - the same reading the Commands act on
     * (`view/table-context.ts`).
     */
    table: null,
    /**
     * Whether the active editor's history has a step to undo / redo, whichever history it holds
     * (`view/editor-history.ts`): the undo and redo buttons grey on an empty stack. Refreshed on
     * every doc change, which is when a stack changes, and on the lock transition that clears it.
     */
    canUndo: false,
    canRedo: false,
    /**
     * Whether the caret is in a word Spell Check has underlined: the Command Bar's Fix spelling
     * group (CONTEXT.md → Command Bar, *Contextual Group*) is present exactly while this is true.
     */
    misspelling: false,
})

/**
 * How many Command Bars are mounted. On a bullet at column 0 the bullet button's gate scans the whole
 * document's fences (`canLeaveList`), on every caret move, so it runs only while a bar is there to
 * grey the button: a desktop editor, which has none, never pays for it.
 */
let mountedCommandBars = 0

/**
 * Count a mounted Command Bar in, and refresh the context at once so its bullet button starts out
 * current. Returns the function that counts it out again.
 */
export function registerCommandBar(): () => void {
    mountedCommandBars += 1
    refreshEditorContext(getActiveEditorView())
    return () => {
        mountedCommandBars -= 1
    }
}

/** Recompute the context from `view`'s caret line, or reset it when there is no editor. */
export function refreshEditorContext(view: EditorView | null): void {
    if (!view) {
        editorContext.inOutlinerBlock = false
        editorContext.taskToggleable = false
        editorContext.bulletToggleable = false
        editorContext.bulletToggleOn = false
        editorContext.indentable = false
        editorContext.bodyWritable = false
        editorContext.tableInsertable = false
        editorContext.table = null
        editorContext.canUndo = false
        editorContext.canRedo = false
        editorContext.misspelling = false
        return
    }
    // A bullet of the outline, a form-1 opener included; a bullet-shaped code or YAML line is not one.
    editorContext.inOutlinerBlock = outlinerBulletAtCaret(view.state)
    editorContext.taskToggleable = taskToggleable(view.state)
    editorContext.bulletToggleable = mountedCommandBars > 0 && bulletToggleable(view.state)
    editorContext.bulletToggleOn = bulletToggleOn(view.state)
    editorContext.indentable = indentable(view.state)
    editorContext.bodyWritable = bodyWritable(view.state)
    editorContext.tableInsertable = tableInsertable(view.state)
    const table = tableAtCaret(view.state)
    editorContext.table = table ? { bodyRow: table.bodyRow, columns: table.columns } : null
    editorContext.canUndo = canUndo(view.state)
    editorContext.canRedo = canRedo(view.state)
    const caret = view.state.selection.main
    editorContext.misspelling = caret.empty && misspellingAt(view, caret.head) !== null
}
