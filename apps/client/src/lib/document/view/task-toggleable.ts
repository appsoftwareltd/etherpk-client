/**
 * Where the task toggle (`editor.toggleTask`: the `Mod-Shift-Enter` chord and the Command Bar's
 * task button) has something to do.
 *
 * On a bullet or task line it cycles the state. On a **prose** line it makes the line a task —
 * `Buy milk` → `- [ ] Buy milk` — so the button is usable wherever a task might be wanted, not
 * only once a bullet already exists. Three places refuse, because a task there is nonsense or
 * would corrupt structure: a heading (`- [ ] # Title` is neither), a line inside a fenced code
 * block (sample text, and the derived index ignores it), and frontmatter.
 *
 * One predicate for both the command (to refuse) and the Command Bar (to disable the button),
 * so the button is never live where the command would do nothing.
 */

import type { EditorState } from '@codemirror/state'

import { isBulletLine, isHeadingLine } from '../outliner'
import { analysisFor } from './analysis/editor-analysis'
import { caretContext } from './outliner-context'

export function taskToggleable(state: EditorState): boolean {
    const line = state.doc.lineAt(state.selection.main.head)
    if (isBulletLine(line.text)) return true
    if (isHeadingLine(line.text)) return false
    if (caretContext(state) === 'fenced-code') return false
    if (analysisFor(state).frontmatterEnd >= line.from) return false
    return true
}
