/**
 * Caret clamp (ADR 0021): an empty-selection caret may never rest left of a line's content column —
 * the bullet marker's end, a fenced-code line's fence column, or a continuation line's floor. One
 * selection-level filter enforces it for every placement path (arrow keys, mouse clicks, Home,
 * programmatic moves), so typing can never land in the structural margin and break the formatting.
 *
 * ArrowLeft AT the clamp (a one-position leftward move from it) jumps to the end of the previous
 * line instead — the caret flows block-to-block like Logseq — while any other placement into the
 * margin (click, Home, vertical motion) snaps right to the clamp.
 *
 * A text range is clamped the same way: each end in the margin moves to its own line's clamp, so the
 * structural prefix — indent and `- ` / `- [ ] ` marker — is never part of a text range, and a key that
 * replaces the selection (Enter, Shift+Enter, Ctrl+Enter, typing) cannot eat the marker. A one-character
 * selection over the `-` followed by Shift+Enter used to leave `-` alone on its line with the content
 * pushed to a soft line (found by the outliner invariant property test under seeds 1, 42 and 55). A
 * selection lying wholly in one line's margin collapses to a caret at the clamp. A range that reaches a
 * second block is block-granular (block-select.ts) and selects the markers on purpose, so it is left to
 * the block snap.
 */

import { EditorSelection, EditorState, type Extension, type SelectionRange, type Text, type Transaction, type TransactionSpec } from '@codemirror/state'

import { frontmatterLines } from '$lib/storage/fs/frontmatter-span'

import { fencedBlocks } from '../fenced-code'
import { continuationFloor, isBulletLine, lineIndent, markerLength } from '../outliner'
import { isBlockRange } from './block-select'

/** The leftmost column the caret may rest at on line `i` (0-based) of `lines`. */
export function clampColumn(lines: string[], i: number): number {
    const line = lines[i]
    // [[Frontmatter]] is unclamped YAML: a `  - alias` there is a list entry whose indentation
    // the caret must be able to reach, and the lines above the body own nothing below them.
    const frontmatter = frontmatterLines(lines)
    if (i < frontmatter) return 0
    const blocks = fencedBlocks(lines)
    const block = blocks.find((b) => i >= b.start && i <= b.end)
    if (block && i > block.start) return Math.min(block.fenceColumn, line.length) // code body/closer: the fence column
    if (isBulletLine(line)) return lineIndent(line) + markerLength(line) // after `- ` / `- [ ] ` (covers form-1 openers)
    const floor = continuationFloor(lines.slice(frontmatter), i - frontmatter)
    if (floor > 0) return Math.min(floor, line.length) // a continuation/soft line: its owning block's floor
    return 0 // plain prose / headings / bare fences: unclamped
}

/**
 * Edits are clamped too: a command or a default CodeMirror edit (the plain line move, a join) can
 * leave the caret at column 0 of a line that has just become a continuation, and typing from there
 * would land in the structural margin. After any change an empty caret left of its new line's clamp
 * snaps right; the ArrowLeft flow applies only to pure selection moves (found by the outliner
 * invariant property test).
 */
function clampAfterEdit(tr: Transaction): TransactionSpec | readonly TransactionSpec[] {
    const sel = tr.newSelection.main
    if (tr.newSelection.ranges.length !== 1) return tr
    const doc = tr.newDoc
    const line = doc.lineAt(sel.head)
    if (!sel.empty && doc.lineAt(sel.anchor).number !== line.number) return tr // multi-line: block selection's
    const clamp = line.from + clampColumn(doc.toString().split('\n'), line.number - 1)
    if (sel.from >= clamp) return tr
    return [tr, { selection: clampedRange(sel, clamp), sequential: true }]
}

/** `range` with any end left of `clamp` moved to it, its direction kept; wholly in the margin → a caret at the clamp. */
function clampedRange(range: SelectionRange, clamp: number): EditorSelection {
    return EditorSelection.single(Math.max(range.anchor, clamp), Math.max(range.head, clamp))
}

/** A text range across lines with each end moved right of its own line's clamp, its direction kept. */
function clampedEnds(doc: Text, lines: string[], range: SelectionRange): EditorSelection {
    const clampAt = (pos: number) => {
        const line = doc.lineAt(pos)
        return Math.max(pos, line.from + clampColumn(lines, line.number - 1))
    }
    return EditorSelection.single(clampAt(range.anchor), clampAt(range.head))
}

export function caretClamp(): Extension {
    return EditorState.transactionFilter.of((tr) => {
        if (!tr.changes.empty) return clampAfterEdit(tr)
        if (!tr.selection) return tr
        const sel = tr.newSelection.main
        if (tr.newSelection.ranges.length !== 1) return tr
        const doc = tr.startState.doc
        const line = doc.lineAt(sel.head)
        const lines = doc.toString().split('\n')
        if (!sel.empty) {
            if (doc.lineAt(sel.anchor).number !== line.number) {
                // Across lines: a text range inside one block keeps each end off its line's margin; a
                // range reaching another block is the block snap's, which widens it to whole lines.
                if (isBlockRange(tr.startState, sel)) return tr
                const clamped = clampedEnds(doc, lines, sel)
                return clamped.main.eq(sel) ? tr : { selection: clamped }
            }
            // A range within one line: clamp its margin end.
            const clamp = line.from + clampColumn(lines, line.number - 1)
            return sel.from >= clamp ? tr : { selection: clampedRange(sel, clamp) }
        }
        const clamp = line.from + clampColumn(lines, line.number - 1)
        if (sel.head >= clamp) return tr
        // A single-position leftward move from exactly the clamp = ArrowLeft at the wall → flow to the
        // end of the previous line (which is always at/right of its own clamp).
        const old = tr.startState.selection.main
        const leftFromClamp = old.empty && old.head === clamp && sel.head === clamp - 1
        if (leftFromClamp && line.number > 1) {
            return { selection: EditorSelection.cursor(doc.line(line.number - 1).to) }
        }
        if (leftFromClamp) return { selection: EditorSelection.cursor(clamp) } // first line: nowhere to flow
        return { selection: EditorSelection.cursor(clamp) } // click/Home/vertical into the margin → snap right
    })
}
