/**
 * The source hard-guard backstop for [[Fenced Code Block]]s (ADR 0020): a transaction filter
 * that, after any user edit touching a fenced block, re-clamps the block's content to the fence
 * column and rebalances the closing fence. The keymap handles the interactive cases (Enter / Tab /
 * Backspace); this catches the rest — pastes, multi-line edits, drag-drop.
 *
 * Blocks are found with the same **column-scoped line-scan** as the visual layer and fence
 * completion ({@link fencedBlocks}) — NOT the CommonMark parser. A CommonMark parse lets a stray
 * unterminated fence anywhere above swallow the outliner block below it as "code", which made this
 * guard clamp a freshly-completed block's closer to the stray fence's column (the balancing bug).
 * Column-scoped pairing means fences outside the block never interfere; an unterminated opener
 * yields no complete block and is simply not guarded (consistent with "incomplete fence ⇒ plain
 * text" everywhere else). Tilde fences are likewise not handled in this slice.
 *
 * Skip conditions keep it from looping or polluting history; corrections ride the *same*
 * transaction (so one paste is one undo step).
 */

import { type ChangeSpec, EditorState, type Extension, Transaction } from '@codemirror/state'

import { fencedBlocks, fenceLineInfo, normaliseFenceLines } from '../fenced-code'
import { EXTERNAL } from './cm-document'

export function fenceGuard(): Extension {
    return EditorState.transactionFilter.of((tr) => {
        if (!tr.docChanged) return tr
        if (tr.annotation(EXTERNAL)) return tr // remote / git-reload — never normalise it
        if (tr.annotation(Transaction.addToHistory) === false) return tr // don't fight undo/redo

        const doc = tr.newDoc
        const changed: { from: number; to: number }[] = []
        tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => changed.push({ from: fromB, to: toB }))
        if (changed.length === 0) return tr

        const docLines = doc.toString().split('\n')
        const corrections: ChangeSpec[] = []
        // The strict scan's openers: a tolerant "closer" that is really another block's opener means
        // the tolerant pairing joined an unclosed opener above to the block below (they sat within
        // three columns), and normalising it would drag that block's fence left. Found live: typing
        // the first backtick of a closer under a fresh opener re-indented the nested block below.
        const strictOpeners = new Set(fencedBlocks(docLines).map((b) => b.start))
        // closerTolerance 3 (CommonMark's): recognise a closer a raw edit nudged ≤3 columns right, so
        // normalise can snap it back to the fence column. Everything else pairs col-exact.
        for (const block of fencedBlocks(docLines, 3)) {
            const openerLine = doc.line(block.start + 1)
            const from = openerLine.from
            const to = doc.line(block.end + 1).to
            if (!changed.some((c) => c.from < to && c.to > from)) continue // block untouched by this edit
            // A block whose OPENER this edit created or changed is not an existing block to re-clamp: a
            // freshly typed opener pairs, under the tolerant scan, with an existing block's opener a few
            // columns right of it, and "normalising" that would drag the existing block's fence left
            // (found live: typing ``` on a soft line above a nested code block re-indented that block).
            if (changed.some((c) => c.from <= openerLine.to && c.to >= openerLine.from)) continue
            if (strictOpeners.has(block.end)) continue // its closer is a real block's opener: not a nudged closer

            const lines = docLines.slice(block.start, block.end + 1)
            const opener = fenceLineInfo(lines[0])
            if (!opener) continue
            const fixed = normaliseFenceLines(lines, block.fenceColumn, opener.run)
            for (let k = 0; k < lines.length; k++) {
                if (fixed[k] !== lines[k]) {
                    const ln = doc.line(block.start + 1 + k)
                    corrections.push({ from: ln.from, to: ln.to, insert: fixed[k] })
                }
            }
        }

        if (corrections.length === 0) return tr // no-op ⇒ loop-breaker
        return [tr, { changes: corrections, sequential: true }]
    })
}
