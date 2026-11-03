/**
 * The fence edits each board action asks for (`FenceEdit`, packages/extension-api/src/editor.ts),
 * planned against the body as last read so each one applies only while its line still says what
 * was read there:
 *
 * - **a stroke** goes in as a new line after the last line that holds anything, one edit, so the
 *   editor's undo takes it out again and two devices' strokes merge as lines of their own;
 * - **erasing** removes each erased stroke's line, and any earlier lines it hides;
 * - **moving** replaces each moved stroke's line with its moved points;
 * - **the paper** replaces the header, or writes one where there is none.
 *
 * Pure, checked in Node.
 */
import type { FenceEdit } from '@appsoftwareltd/etherpk-extension-api'

import { headerLine, type InkDrawing, type InkPaper, type InkStroke, strokeLine } from './format'
import { translatedPoints } from './geometry'

/** The edit that adds a stroke at the end of the body (before any trailing blank lines). */
export function planAddStroke(body: readonly string[], stroke: InkStroke): FenceEdit {
    let line = body.length
    while (line > 0 && body[line - 1].trim() === '') line -= 1
    return { kind: 'insert', line, text: strokeLine(stroke) }
}

/**
 * The edits that remove the strokes with these ids, and the earlier lines each hides, last line
 * first so each edit's line number holds as the ones before it apply.
 */
export function planErase(drawing: InkDrawing, ids: ReadonlySet<string>): FenceEdit[] {
    const lines = drawing.strokes.filter((s) => ids.has(s.stroke.id)).flatMap((s) => [{ line: s.line, text: s.text }, ...s.hidden])
    return lines.sort((a, b) => b.line - a.line).map(({ line, text }) => ({ kind: 'remove', line, expect: text }))
}

/** The edits that move the strokes with these ids by `dx`, `dy`, or none for no move. */
export function planMove(drawing: InkDrawing, ids: ReadonlySet<string>, dx: number, dy: number): FenceEdit[] {
    if (dx === 0 && dy === 0) return []
    return drawing.strokes
        .filter((s) => ids.has(s.stroke.id))
        .map((s) => {
            const text = strokeLine({ ...s.stroke, pts: translatedPoints(s.stroke.pts, dx, dy) })
            return { kind: 'replace' as const, line: s.line, expect: s.text, text }
        })
        .filter((edit) => edit.text !== edit.expect)
}

/**
 * The edit that sets the paper: the header replaced, or one written as the first line where there
 * is none, with `id` as the drawing's id when the header has none. Null when nothing changes.
 */
export function planHeader(drawing: InkDrawing, change: { paper?: InkPaper; id: () => string }): FenceEdit | null {
    const paper = change.paper ?? drawing.header.paper
    const id = drawing.header.id ?? change.id()
    const text = headerLine({ id, paper })
    if (drawing.headerLine === null) return { kind: 'insert', line: 0, text }
    if (drawing.headerLine.text === text) return null
    return { kind: 'replace', line: drawing.headerLine.line, expect: drawing.headerLine.text, text }
}
