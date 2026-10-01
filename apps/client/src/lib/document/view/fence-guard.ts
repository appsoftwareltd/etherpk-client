/**
 * The source hard-guard backstop for [[Fenced Code Block]]s (ADR 0020): a transaction filter
 * that, after any user edit touching a fenced block, re-clamps the block's content to the fence
 * column and rebalances the closing fence. The keymap handles the interactive cases (Enter / Tab /
 * Backspace); this catches the rest — pastes, multi-line edits, drag-drop.
 *
 * A code line an edit leaves short of its fence column (a character typed on an empty line that
 * holds none of the fence column's spaces) is padded out to it by a second filter, {@link fencePad},
 * which runs before the caret clamp; the guard pads what that one leaves (a paste, a drop) as a
 * backstop, then re-clamps.
 *
 * Blocks are found with the same **column-scoped line-scan** as the visual layer and fence
 * completion ({@link fencedBlocks}) — NOT the CommonMark parser. A CommonMark parse lets a stray
 * unterminated fence anywhere above swallow the outliner block below it as "code", which made this
 * guard clamp a freshly-completed block's closer to the stray fence's column (the balancing bug).
 * Column-scoped pairing means fences outside the block never interfere; an unterminated opener
 * yields no complete block and is simply not guarded (consistent with "incomplete fence ⇒ plain
 * text" everywhere else). Tilde fences are likewise not handled in this slice.
 *
 * Skip conditions keep it from looping, polluting history or leaving a shared text behind;
 * corrections ride the *same* transaction (so one paste is one undo step).
 */

import { ChangeSet, type ChangeSpec, EditorState, type Extension, MapMode, type Text, Transaction, type TransactionSpec } from '@codemirror/state'

import { frontmatterLines } from '$lib/storage/fs/frontmatter-span'

import { type FencedBlockRange, fencedBlocks, fenceLineInfo, normaliseFenceLines } from '../fenced-code'
import { editorAnalysisField, type EditorAnalysis } from './analysis/editor-analysis'
import { EXTERNAL, collaborative } from './cm-document'
import { isOwnEditing } from './own-editing'

type Range = { from: number; to: number }

/**
 * Transactions neither filter touches: a write-back from the workspace or a remote change
 * (`EXTERNAL`), undo and redo, and in a shared graph any change that is not this user's own editing
 * (another member's, or the shared undo manager's). Those arrive through y-codemirror, which never
 * sends a correction added to them on to the shared text, so this editor would fall out of step
 * with every other member's; their author's editor held these rules when they typed
 * (frontmatter-boundary.ts, the same).
 */
function leftAlone(tr: Transaction): boolean {
    return (
        !tr.docChanged ||
        !!tr.annotation(EXTERNAL) ||
        tr.annotation(Transaction.addToHistory) === false ||
        (tr.startState.facet(collaborative) && !isOwnEditing(tr))
    )
}

/**
 * Pads out to its block's fence column every code line an edit left short of it, for the blocks as
 * they stood BEFORE the edit. The post-edit scan cannot do this: a non-blank line left of a block's
 * fence column ends the block for the fence scan, so by then there is no block to pad. That is what
 * a character typed on an empty code line of a bullet's block did (a blank line written without the
 * fence column's spaces, as other tools and agents write it): it landed at column 0 and dissolved
 * the whole block into prose.
 *
 * Left alone: a block whose fence line the edit touched, which is the user's own fence edit and may
 * dissolve it on purpose, and a line the edit made a fence line, for the same reason.
 */
function padsBelowFenceColumn(tr: Transaction): ChangeSpec[] {
    const before = tr.startState
    // The analysis already holds the blocks as they stood (the pending, half-typed fence set aside);
    // a state without it (a bare test state) scans.
    const analysis = before.field(editorAnalysisField, false) as EditorAnalysis | undefined
    const blocks: readonly FencedBlockRange[] = analysis?.fencedBlocks ?? fencedBlocks(before.doc.toString().split('\n'))
    // A line inside nested blocks takes the deepest column, which is the innermost block's.
    const columns = new Map<number, number>()
    for (const block of blocks) {
        if (block.fenceColumn === 0) continue // no line sits left of column 0
        const opener = before.doc.line(block.start + 1)
        const closer = before.doc.line(block.end + 1)
        let fenceEdited = false
        let codeEdited = false
        tr.changes.iterChangedRanges((fromA, toA) => {
            if ((fromA <= opener.to && toA >= opener.from) || (fromA <= closer.to && toA >= closer.from)) fenceEdited = true
            else if (fromA > opener.to && toA < closer.from) codeEdited = true
        })
        if (fenceEdited || !codeEdited) continue
        // The code lines as they stand after the edit: from below the opener to above the closer.
        const first = tr.newDoc.lineAt(tr.changes.mapPos(opener.to, 1)).number + 1
        const last = tr.newDoc.lineAt(tr.changes.mapPos(closer.from, -1)).number - 1
        for (let n = first; n <= last; n++) {
            const text = tr.newDoc.line(n).text
            const indent = text.length - text.trimStart().length
            if (indent === text.length || indent >= block.fenceColumn) continue // blank, or at the column
            if (fenceLineInfo(text)) continue
            columns.set(n, Math.max(columns.get(n) ?? 0, block.fenceColumn))
        }
    }
    return [...columns].map(([n, column]) => {
        const line = tr.newDoc.line(n)
        return { from: line.from, insert: ' '.repeat(column - (line.text.length - line.text.trimStart().length)) }
    })
}

/**
 * The pads as a spec of their own, the selection carried with them: a caret at a padded line's start
 * moves past the pad, onto the fence column (Backspace joining a line into an empty one lands there).
 */
function padSpec(tr: Transaction, pads: ChangeSpec[]): { set: ChangeSet; spec: TransactionSpec } {
    const set = ChangeSet.of(pads, tr.newDoc.length)
    return { set, spec: { changes: set, selection: tr.newSelection.map(set, 1), sequential: true } }
}

/**
 * The pad, for the edits the keys and typing make. It is registered after the caret clamp in the
 * feature stack (editor-extensions.ts), so it runs BEFORE it (CodeMirror runs filters in reverse):
 * the clamp then judges the padded line as the code it is. Judged unpadded, a joined line that
 * looks like a bullet (`- x`, code in a block) took a bullet's clamp, and the pad then carried the
 * caret past the `- `.
 *
 * Not padded here: a paste or a drop, which the paste clamp places as a unit (a pad line by line
 * would flatten the fragment's own indentation), and an IME composition, which a change beside the
 * text being composed can break. The guard below deals with both.
 */
export function fencePad(): Extension {
    return EditorState.transactionFilter.of((tr) => {
        if (leftAlone(tr)) return tr
        if (tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop') || tr.isUserEvent('input.type.compose')) return tr
        const pads = padsBelowFenceColumn(tr)
        return pads.length ? [tr, padSpec(tr, pads).spec] : tr
    })
}

/**
 * Each fence line the strict scan paired before `tr`, mapped to the line it was paired with, both as
 * lines of the edited text. A line counts where the edit kept it, its start and its end landing on one
 * line: a closer the edit nudged right keeps its pairing, and a fence the edit deleted or split has
 * none. The pad inserts no line, so these are the padded text's lines too.
 */
function pairingsBefore(tr: Transaction): Map<number, number> {
    const before = tr.startState.doc
    const kept = (index: number): number | null => {
        const line = before.line(index + 1)
        const start = tr.changes.mapPos(line.from, 1, MapMode.TrackDel)
        const end = tr.changes.mapPos(line.to, -1, MapMode.TrackDel)
        if (start === null || end === null) return null
        const at = tr.newDoc.lineAt(start).number - 1
        return tr.newDoc.lineAt(end).number - 1 === at ? at : null
    }
    const partners = new Map<number, number>()
    for (const block of fencedBlocks(before.toString().split('\n'))) {
        const start = kept(block.start)
        const end = kept(block.end)
        if (start === null || end === null) continue
        partners.set(start, end)
        partners.set(end, start)
    }
    return partners
}

/**
 * The re-clamp of every complete block the edit touched, as changes to `doc`. `before` gives the
 * strict pairing as it stood before the edit ({@link pairingsBefore}), read only when a block needs
 * a repair.
 */
function normaliseTouchedBlocks(doc: Text, changed: readonly Range[], before: () => Map<number, number>): ChangeSpec[] {
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
        if (fixed.every((line, k) => line === lines[k])) continue
        // A repair restores a pairing the edit broke, or makes a new one. It never pairs a fence the
        // strict scan paired with another line before the edit: a "closer" a few columns right of the
        // opener can be another block's fence, not one an edit nudged. In a code sample written with
        // three backticks, an inner opener that stops being a fence (a backtick deleted, a second word
        // typed after its info string) leaves the inner closer two columns right of the sample's opener,
        // and snapping it back closed the sample there. Judged against the text after the edit, a nudge
        // can look the same: the opener pairs with a stray fence further down until the repair.
        const paired = before()
        if ((paired.get(block.start) ?? block.end) !== block.end || (paired.get(block.end) ?? block.start) !== block.start) continue
        for (let k = 0; k < lines.length; k++) {
            if (fixed[k] !== lines[k]) {
                const ln = doc.line(block.start + 1 + k)
                corrections.push({ from: ln.from, to: ln.to, insert: fixed[k] })
            }
        }
    }
    return corrections
}

export function fenceGuard(): Extension {
    return EditorState.transactionFilter.of((tr) => {
        if (leftAlone(tr)) return tr
        const changed: Range[] = []
        tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => changed.push({ from: fromB, to: toB }))
        if (changed.length === 0) return tr

        // What the pad left: a paste or a drop the paste clamp did not place at the fence column, or a
        // composition. A composition that leaves a line short of its column is left whole: padding it
        // can break the composition, and re-clamping the unpadded text could pair the dissolved block's
        // closer with some other fence and drag it to that fence's column.
        const pads = padsBelowFenceColumn(tr)
        if (pads.length && tr.isUserEvent('input.type.compose')) return tr
        // The re-clamp runs on the text as padded, where those blocks stand again.
        const padded = pads.length ? padSpec(tr, pads) : null
        const doc = padded ? padded.set.apply(tr.newDoc) : tr.newDoc
        const touched = padded ? changed.map((c) => ({ from: padded.set.mapPos(c.from, -1), to: padded.set.mapPos(c.to, 1) })) : changed
        let paired: Map<number, number> | undefined
        const corrections = normaliseTouchedBlocks(doc, touched, () => (paired ??= pairingsBefore(tr)))

        if (!padded && corrections.length === 0) return tr // no-op ⇒ loop-breaker
        const specs: (Transaction | TransactionSpec)[] = [tr]
        if (padded) specs.push(padded.spec)
        if (corrections.length) specs.push({ changes: corrections, sequential: true })
        return specs
    })
}

/**
 * Whether deleting `from` to `to` moves a fence line on its own or joins text onto one, without
 * deleting any of that fence's own text (its backticks and info string). A fence pairs only with one
 * at its own column on a line of its own, so either dissolves the block, or pairs the fence with
 * another. Deleting the fence's own text is how a block is dissolved on purpose, and stays allowed.
 *
 * - Above the fence: what is left before it on its line must be exactly what was there, its indent
 *   (and a form-1 bullet's marker). A deletion in that indent moves the fence, and one across the
 *   line break above joins the line above onto it. Deleting an empty line above leaves it as it was.
 * - Below the fence: a deletion across its line break must leave nothing after it but spaces. Joining
 *   the next line's text turns a closer into an opener, or an opener's info string into another.
 *
 * Every complete block in the body counts, an inner pair of a code sample included; a fence-like
 * line in the frontmatter is YAML text.
 */
export function deletionBreaksFence(state: EditorState, from: number, to: number): boolean {
    if (to <= from) return false
    const { doc } = state
    // The analysis holds the blocks as they stand (a half-typed fence set aside); a bare state scans.
    const analysis = state.field(editorAnalysisField, false) as EditorAnalysis | undefined
    const lines = analysis?.lines ?? doc.toString().split('\n')
    const blocks = analysis?.fencedBlocks ?? fencedBlocks(lines)
    const body = frontmatterLines(lines)
    const first = doc.lineAt(from).number - 1
    const last = doc.lineAt(to).number - 1
    for (const block of blocks) {
        if (block.start < body) continue
        for (const index of [block.start, block.end]) {
            if (index < first || index > last) continue
            const line = doc.line(index + 1)
            const info = fenceLineInfo(line.text)
            if (!info) continue
            const run = line.from + info.col
            const textEnd = line.from + line.text.trimEnd().length // the info string's end, not trailing spaces
            if (from < textEnd && to > run) continue // takes some of the fence's own text: on purpose
            if (from < run && to >= line.from) {
                const above = doc.lineAt(from)
                const kept = above.text.slice(0, from - above.from) + line.text.slice(Math.max(to, line.from) - line.from, info.col)
                if (kept !== line.text.slice(0, info.col)) return true
            }
            // From after the fence's text across its line break: what the line below holds joins it.
            if (from >= textEnd && to > line.to) {
                const below = doc.lineAt(to)
                if (below.text.slice(to - below.from).trim() !== '') return true
            }
        }
    }
    return false
}

/**
 * Holds every delete CodeMirror makes to {@link deletionBreaksFence}: Backspace and Delete, the word
 * deletes (Ctrl+Backspace, Ctrl+Delete, Alt on a Mac), the line deletes (Cmd+Backspace on a Mac) and
 * the emacs keys all dispatch as `delete.backward`, `delete.forward` or `delete.selection`. The
 * keymap's own fence-edge keys consume most of these first; this catches the rest, which once
 * deleted a fence's indent or joined the next line onto a closer. A refused delete changes nothing,
 * as a consumed key does. The keymap's own deletes (`delete`) judge their structure themselves.
 */
export function fenceDeleteGuard(): Extension {
    return EditorState.transactionFilter.of((tr) => {
        if (leftAlone(tr)) return tr
        if (!tr.isUserEvent('delete.backward') && !tr.isUserEvent('delete.forward') && !tr.isUserEvent('delete.selection')) return tr
        let breaks = false
        tr.changes.iterChanges((fromA, toA) => {
            if (!breaks && deletionBreaksFence(tr.startState, fromA, toA)) breaks = true
        })
        return breaks ? [] : tr
    })
}
