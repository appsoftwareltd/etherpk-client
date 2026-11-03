/**
 * The [[Task]] on the caret's line, as a [[Task Reference]] names it (ADR 0114): its document, its
 * line in the body (as the index counts lines) and its label. What **Copy task reference** copies
 * from the editor, and what the Command Menu asks to decide whether to offer that row.
 */
import type { EditorState } from '@codemirror/state'

import { bulletLabel } from '../index-derive'
import { parseTaskLine } from '../task-tags'
import { analysisFor } from './analysis/editor-analysis'
import { isProtectedDocumentFacet } from './augmentations/protected-fence'
import { editorDocument } from './editor-document'

export interface CaretTask {
    document: string
    /** 0-based body line. */
    line: number
    /** The text after the checkbox, tag run included. */
    label: string
}

/**
 * The task on the caret's line, or null: when the line is no task, when it sits in the frontmatter
 * or in fenced code (neither of which the index reads tasks from), and in a [[Protected Document]],
 * whose tasks no agent can read. The frontmatter and the fences come from the editor's shared
 * analysis, so they are the ones every other feature sees.
 */
export function caretTask(state: EditorState): CaretTask | null {
    return taskOnLine(state, state.doc.lineAt(state.selection.main.head).number)
}

/**
 * The task on line `number` (1-based, as the editor counts lines), on the same terms as
 * {@link caretTask}: what the line menu's **Copy task reference** copies from a right-click.
 */
export function taskOnLine(state: EditorState, number: number): CaretTask | null {
    return state.facet(isProtectedDocumentFacet)() ? null : bodyTaskOnLine(state, number)
}

/**
 * The task on line `number` (1-based) as the index reads one, a [[Protected Document]]'s included:
 * what a row that edits the task (setting its status from the line menu) acts on, where whether the
 * body takes the edit is `bodyWritable`'s question, not this one's.
 */
export function bodyTaskOnLine(state: EditorState, number: number): CaretTask | null {
    const shown = state.facet(editorDocument)
    if (!shown || number < 1 || number > state.doc.lines) return null
    const line = state.doc.line(number)
    if (parseTaskLine(line.text) === null) return null
    const analysis = analysisFor(state)
    if (analysis.frontmatterEnd >= 0 && line.from <= analysis.frontmatterEnd) return null
    const index = line.number - 1
    if (analysis.fencedBlocks.some((block) => block.start <= index && index <= block.end)) return null
    // `frontmatterEnd` is the end of the closing delimiter's text, so its line's number is how many
    // lines the frontmatter takes, and the body's lines are counted from there.
    const bodyStart = analysis.frontmatterEnd < 0 ? 0 : state.doc.lineAt(analysis.frontmatterEnd).number
    return { document: shown.concept, line: index - bodyStart, label: bulletLabel(line.text) }
}
