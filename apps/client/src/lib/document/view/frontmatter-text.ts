/**
 * The [[Frontmatter]] block as the editor's frontmatter features read it, from the shared analysis
 * (`frontmatterEnd`), so the typing keys, the tidy and problem marks, and completion measure the
 * same block.
 */
import type { EditorState } from '@codemirror/state'

import { analysisFor } from './analysis/editor-analysis'

/** The block with the line terminator after its closing delimiter, or null when there is none. */
export function frontmatterHead(state: EditorState): string | null {
    const end = analysisFor(state).frontmatterEnd
    if (end < 0) return null
    const closer = state.doc.lineAt(end)
    return state.sliceDoc(0, Math.min(state.doc.length, closer.to + 1))
}

/**
 * Whether line `lineNumber` (1-based) lies strictly between the block's delimiters: a line of YAML,
 * never a delimiter. `lineInFrontmatter` (outliner-context.ts) counts the delimiter lines as well.
 */
export function isFrontmatterBodyLine(state: EditorState, lineNumber: number): boolean {
    const end = analysisFor(state).frontmatterEnd
    if (end < 0) return false
    return lineNumber > 1 && lineNumber < state.doc.lineAt(end).number
}
