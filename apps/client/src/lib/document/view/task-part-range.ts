/**
 * The runs of a task's lines the [[Task Editor]] shows in an editor of their own (ADR 0170): its
 * description, its [[Task Comment]]s, or its additional context (the lines after its comments),
 * read by `task-structure.ts` from the task on the editor's anchored line (`line-anchor.ts`), which
 * follows the task through lines added above it. For `shown-range.ts`.
 */
import type { EditorState } from '@codemirror/state'

import { readTaskStructure } from '../task-structure'
import { analysisFor } from './analysis/editor-analysis'
import { anchoredLine } from './line-anchor'
import type { ShownRange, ShownRangeOf } from './shown-range'

/** Which part of a task an editor shows. */
export type TaskPart = 'description' | 'comments' | 'additionalContext'

/**
 * Where `part` of the task on the anchored line is, or null when that line holds no task (it was
 * deleted, or its line taken by another) or the part has no lines.
 */
export function taskPartRange(part: TaskPart): ShownRangeOf {
    return (state: EditorState): ShownRange | null => {
        const number = anchoredLine(state)
        if (number === null) return null
        const { lines, fencedBlocks } = analysisFor(state)
        const task = readTaskStructure(lines, number - 1, fencedBlocks)
        if (task === null) return null
        const span = part === 'description' ? task.description : part === 'comments' ? task.comments : task.additionalContext
        if (span === null || span.from === span.to) return null
        // Drawn from the level below the bullet the part is nested under: the task for the
        // description and the additional context, the Comments bullet for the comments
        // (`outline-base.ts`).
        const parent = part === 'comments' ? (task.commentsLine ?? task.line) : task.line
        return { from: state.doc.line(span.from + 1).from, to: state.doc.line(span.to).to, nestedUnder: parent + 1 }
    }
}
