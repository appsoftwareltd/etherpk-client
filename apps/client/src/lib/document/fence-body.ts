/**
 * Changes to the body of a fenced block, line by line: what an interactive fence's widget asks
 * the editor to do to the text behind it (`view/augmentations/interactive-fence.ts`). A [[Map
 * Block]] adds, moves, renames and removes its places this way (ADR 0118).
 *
 * The body is the block's lines between its fences, less the indentation up to the fence's
 * column (`codeLineText`). A replace or a removal names the text the widget last read on that
 * line, and applies only while the line still says it, so a widget acting on an old reading never
 * lands on another member's edit or on a line that moved.
 *
 * Framework-free: the editor applies these to its document, and tests apply them to arrays.
 */

import { fenceLineInfo } from './fenced-code'

/** One change to a fenced block's body. */
export type FenceBodyEdit =
    | { kind: 'insert'; line: number; text: string }
    | { kind: 'replace'; line: number; expect: string; text: string }
    | { kind: 'remove'; line: number; expect: string }

/** Adding a line after the last one that holds anything, so trailing blank lines stay last. */
export function appendFenceLine(body: readonly string[], text: string): FenceBodyEdit {
    let line = body.length
    while (line > 0 && body[line - 1].trim() === '') line -= 1
    return { kind: 'insert', line, text }
}

/** Changing a line, while it still says what was last read there. */
export function replaceFenceLine(line: number, expect: string, text: string): FenceBodyEdit {
    return { kind: 'replace', line, expect, text }
}

/** Removing a line, while it still says what was last read there. */
export function removeFenceLine(line: number, expect: string): FenceBodyEdit {
    return { kind: 'remove', line, expect }
}

/** The body after an edit, or null when the line it names no longer says what was expected. */
export function applyFenceBodyEdit(body: readonly string[], edit: FenceBodyEdit): string[] | null {
    if (!fenceBodyEditApplies(body, edit)) return null
    const next = [...body]
    if (edit.kind === 'insert') next.splice(edit.line, 0, edit.text)
    else if (edit.kind === 'replace') next[edit.line] = edit.text
    else next.splice(edit.line, 1)
    return next
}

/** Whether an edit can be applied to this body: its line exists and still says what was expected. */
export function fenceBodyEditApplies(body: readonly string[], edit: FenceBodyEdit): boolean {
    if (edit.kind === 'insert') return edit.line >= 0 && edit.line <= body.length
    return edit.line >= 0 && edit.line < body.length && body[edit.line] === edit.expect
}

/**
 * A line of text that may sit in a fence's body: one line, and never one the fence analysis reads
 * as a fence line (`fenceLineInfo`). A closer would end the block early, an opener with an info word
 * takes over from the block's own opener, and a longer run starts a block of its own, so any of them
 * would leave the widget's fence broken. Such a line keeps its words, with its backticks written as
 * quotes.
 */
export function safeFenceLine(text: string): string {
    const single = text.replace(/[\r\n]+/g, ' ')
    const fence = fenceLineInfo(single)
    if (!fence) return single
    return single.slice(0, fence.col) + "'".repeat(fence.len) + single.slice(fence.col + fence.len)
}
