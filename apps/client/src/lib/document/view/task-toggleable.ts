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
 * (`- [ ] # Title` is neither) and an unterminated fence line, which as a task would open a block
 * that pairs with the next fence at its column. A bullet whose fence opens on its line (form 1) is
 * part of its block's code here: the task marker would push the fence past the content column, where
 * its closer no longer pairs with it, and the code block would dissolve.
 *
 * **Indent** (`editor.indent`, the Command Bar's Indent button; Tab runs the code and fence handlers
 * first). A block selection, or a range across one block's lines, nests its blocks wherever its head
 * sits; a bullet nests, a form-1 opener included, since it is the bullet its code block belongs to;
 * prose enters the list where the task toggle would make it a task.
 *
 * **Outdent and Move** (the Command Bar's `outlinerOnly` buttons) act on the bullet at the caret: a
 * bullet of the outline, a form-1 opener included, and never a bullet-shaped code or YAML line.
 */

import type { EditorState } from '@codemirror/state'

import { fenceLineInfo } from '../fenced-code'
import { formOneOpeners, isHeadingLine } from '../outliner'
import { analysisFor } from './analysis/editor-analysis'
import { isBlockSelection, rangeBlockOwner } from './block-select'
import { caretContext } from './outliner-context'

/** Whether the caret's line is a form-1 opener in the body (`formOneOpeners`). */
function onFormOneOpener(state: EditorState): boolean {
    const { lines, fencedBlocks } = analysisFor(state)
    return formOneOpeners(lines, fencedBlocks).has(state.doc.lineAt(state.selection.main.head).number - 1)
}

export function taskToggleable(state: EditorState): boolean {
    const context = caretContext(state)
    // A form-1 opener's caret context is its fenced block's, so it is refused with the code below it.
    if (context === 'frontmatter' || context === 'fenced-code') return false
    const line = state.doc.lineAt(state.selection.main.head).text
    if (isHeadingLine(line)) return false
    return !(context === 'prose' && fenceLineInfo(line))
}

export function indentable(state: EditorState): boolean {
    if (isBlockSelection(state) || rangeBlockOwner(state) !== null) return true
    return outlinerBulletAtCaret(state) || taskToggleable(state)
}

export function outlinerBulletAtCaret(state: EditorState): boolean {
    const context = caretContext(state)
    return context === 'bullet' || context === 'task' || (context === 'fenced-code' && onFormOneOpener(state))
}
