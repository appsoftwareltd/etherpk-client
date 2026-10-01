/**
 * Where the task toggle, Indent, and the Outdent and Move Commands have something to do. The Command
 * Bar greys their buttons by these predicates and the Commands refuse on the same ones, so a live
 * button never does nothing.
 *
 * **The task toggle** (`editor.toggleTask`: the `Mod-Shift-Enter` chord and the Command Bar's task
 * button). On a bullet or task line it cycles the state. On a **prose** line it makes the line a
 * task — `Buy milk` → `- [ ] Buy milk` — so the button is usable wherever a task might be wanted,
 * not only once a bullet already exists. It is refused where a task is nonsense or would corrupt
 * structure: frontmatter (a `- alias` there is a YAML list entry), a line of a fenced code block
 * (sample text, a bullet-shaped line included, and the derived index ignores it), a heading
 * (`- [ ] # Title` is neither), an unterminated fence line, which as a task would open a block
 * that pairs with the next fence at its column, and a table row, which cannot be a task without
 * leaving its table behind. The bullet line a table opens on is a bullet, and cycles like one. A
 * bullet whose fence opens on its line (form 1) is part of its block's code here: the task marker
 * would push the fence past the content column, where its closer no longer pairs with it, and the
 * code block would dissolve. A range across one block's lines cycles that block wherever its head
 * sits, so the gate reads the block, not the head's line.
 *
 * **Indent** (`editor.indent`, the Command Bar's Indent button; Tab runs the code and fence handlers
 * first). A block selection, or a range across one block's lines, nests its blocks wherever its head
 * sits; a bullet nests, a form-1 opener included, since it is the bullet its code block belongs to;
 * prose enters the list where the task toggle would make it a task.
 *
 * **Outdent and Move** (the Command Bar's `outlinerOnly` buttons) act on the bullet at the caret: a
 * bullet of the outline, a form-1 opener included, and never a bullet-shaped code or YAML line.
 *
 * **The bullet toggle** (`editor.toggleBullet`, the Command Bar's bullet button) acts on one line: the
 * block a range across one block's lines lies in, as for Indent, or else the caret's line. Prose enters
 * the list where the task toggle would make it a task, a blank line included. A bullet at column 0
 * leaves it where Shift+Tab past the root would (`canLeaveList`). A nested bullet is refused, because
 * a prose line inside a tree would split it, and a prose line may only land between two top-level
 * trees (Editor Content Rules → Splits never orphan). A block selection is refused, because it has no
 * one line (the caret is hidden) and making one of its blocks prose would split the rest from their
 * group. Shift+Tab refuses a selection with a block at the root for the same reason.
 */

import type { EditorState } from '@codemirror/state'

import { type FencedBlockRange, fenceLineInfo } from '../fenced-code'
import { canLeaveList, canOutdent, formOneOpeners, isHeadingLine } from '../outliner'
import { analysisFor } from './analysis/editor-analysis'
import { isBlockSelection, rangeBlockOwner } from './block-select'
import { caretContext } from './outliner-context'
import { tableAtCaret } from './table-context'

/** Whether 0-based line `line` is a form-1 opener in the body (`formOneOpeners`). */
function isFormOneOpener(state: EditorState, line: number): boolean {
    const { lines, fencedBlocks } = analysisFor(state)
    return formOneOpeners(lines, fencedBlocks).has(line)
}

/** Whether the caret's line is a form-1 opener in the body. */
function onFormOneOpener(state: EditorState): boolean {
    return isFormOneOpener(state, state.doc.lineAt(state.selection.main.head).number - 1)
}

export function taskToggleable(state: EditorState): boolean {
    // A range across one block's lines cycles that block, wherever the head sits, as the command reads
    // it (`toggleTask`): refused only on a form-1 block, whose code block the marker would break.
    const owner = rangeBlockOwner(state)
    if (owner !== null) return !isFormOneOpener(state, owner)
    const context = caretContext(state)
    // A form-1 opener's caret context is its fenced block's, so it is refused with the code below it.
    if (context === 'frontmatter' || context === 'fenced-code') return false
    const line = state.doc.lineAt(state.selection.main.head).text
    if (isHeadingLine(line)) return false
    if (context !== 'prose') return true
    return !fenceLineInfo(line) && tableAtCaret(state) === null
}

export function indentable(state: EditorState): boolean {
    if (isBlockSelection(state) || rangeBlockOwner(state) !== null) return true
    return outlinerBulletAtCaret(state) || taskToggleable(state)
}

export function outlinerBulletAtCaret(state: EditorState): boolean {
    const context = caretContext(state)
    return context === 'bullet' || context === 'task' || (context === 'fenced-code' && onFormOneOpener(state))
}

/**
 * The bullet the bullet toggle acts on, as a 0-based line: the block a range across one block's lines
 * lies in, or the caret's line when it is a bullet of the outline. Null when the toggle's line is not a
 * bullet, and for a block selection, where the toggle does not act at all.
 */
export function toggledBullet(state: EditorState): number | null {
    if (isBlockSelection(state)) return null
    const owner = rangeBlockOwner(state)
    if (owner !== null) return owner
    return outlinerBulletAtCaret(state) ? state.doc.lineAt(state.selection.main.head).number - 1 : null
}

/** Whether the bullet toggle reads as on: its line is a bullet, nested or not. The bar shows it pressed. */
export function bulletToggleOn(state: EditorState): boolean {
    return toggledBullet(state) !== null
}

/** Where the bullet toggle has something to do. Its button is greyed elsewhere, and the command refuses. */
export function bulletToggleable(state: EditorState): boolean {
    if (isBlockSelection(state)) return false
    const bullet = toggledBullet(state)
    if (bullet === null) return taskToggleable(state)
    const analysis = analysisFor(state)
    const lines = analysis.lines as string[] // the shared analysis lines; read only
    if (canOutdent(lines, bullet)) return false
    // While a fence is pending the analysis pairs as if it were text, so the plain scan decides.
    const blocks = analysis.pendingFence === null ? (analysis.fencedBlocks as FencedBlockRange[]) : undefined
    return canLeaveList(lines, bullet, blocks)
}
