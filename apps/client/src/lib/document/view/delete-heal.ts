/**
 * Heal the outline after a delete the keymap does not see (ADR 0021). Backspace and Delete over a
 * multi-line selection go through the keymap, which heals the group afterwards; the deletions below
 * bypass it and used to leave a block's surviving descendants floating at their old depth with no
 * parent:
 *
 * - **Ctrl+X** goes through CodeMirror's own cut handler. A cut that removed more than one line gets
 *   the same heal ({@link healAfterRangeDelete}): the blank artifact at the join goes, and every
 *   orphaned block is pulled up to one level under its nearest surviving ancestor (indent 0 when the
 *   whole top of the tree went), its subtree and fenced blocks moving with it. A cut from prose over a
 *   bullet's marker makes that bullet prose first, as the keymap's range delete does
 *   ({@link cutsAfterBulletIntoProse}). Shift+Backspace and the word deletes over a selection go
 *   through the keymap's range delete, as Backspace does.
 * - A **within-line selection that takes a bullet's marker** (a drag from the line's left margin over
 *   the dot, then Backspace, Delete or Ctrl+X) is character-precise, so the default delete runs and
 *   the line stops being a bullet while its children keep their depth — under a blank line, or under
 *   a prose line, with no parent either way. The block is gone, so its children re-parent as if it
 *   had been deleted whole: a whitespace-only remainder is removed and the group healed
 *   ({@link healAfterRangeDelete}); a prose remainder stays as the line it is (a soft line of the
 *   block above, or top-level prose) and the group is healed around it ({@link healAroundMasked}
 *   with the line masked out, so it is nobody's parent). A within-line delete that leaves the marker
 *   in place (the content cleared) is an edit to the block, not its removal, and is left alone.
 * - **Enter, or a typed character, over a selection from prose that takes a bullet's marker**
 *   ({@link cutsAfterBulletIntoProse}). The bullet's text joins the prose line, as with Delete, so the
 *   bullet leaves the list: its own lines come to the margin and its children up a level. Only the
 *   selection's own replacement counts: a plain Enter on a continuation line also dispatches a
 *   replace, and every other typed-over selection is left as typed. A composition (an IME, which on
 *   Android is every word typed with GBoard) is left whole.
 *
 * Fenced-code interiors and the [[Frontmatter]] are opaque: a `- x` there is code or YAML, and a
 * filter never changes the document beyond the edit made in it.
 *
 * The caret: in the live editor the caret clamp runs BEFORE this filter (it is registered later, in
 * editor-extensions.ts), so a caret the heal's replacement span swallows would collapse to the span's
 * start — column 0 of the next line. After a cut or a within-line delete, when the caret falls inside
 * the span it is placed explicitly at the healed line's content column; otherwise it maps through the
 * change as usual. After typing the caret sits after the new text, so that heal goes in as a change per
 * re-indented line and the caret maps through it.
 */

import { type ChangeSpec, EditorState, type Extension, type Text, Transaction } from '@codemirror/state'

import { fencedBlocks } from '../fenced-code'
import { applyLeaveListCuts, cutsAfterBulletIntoProse, formOneOpeners, healAfterRangeDelete, healAroundMasked, healSpan, isBulletLine, lineIndent, opaqueLineFlags } from '../outliner'
import { clampColumn } from './caret-clamp'
import { minimalReplacement } from './minimal-replacement'

export function deleteHeal(): Extension {
    return EditorState.transactionFilter.of((tr) => {
        const cut = tr.isUserEvent('delete.cut')
        const deleted = tr.isUserEvent('delete.selection')
        // Enter is CodeMirror's plain `input`, a typed character `input.type`. A composition (an IME)
        // is left whole, as the source guard leaves it.
        const typed = tr.annotation(Transaction.userEvent) === 'input' || (tr.isUserEvent('input.type') && !tr.isUserEvent('input.type.compose'))
        if (!tr.docChanged || !(cut || deleted || typed)) return tr
        // Typing is every keystroke: unless it replaced a selection reaching past one line, nothing here
        // applies, and the document is not read at all.
        if (typed) {
            const sel = tr.startState.selection.main
            if (sel.empty || tr.startState.doc.lineAt(sel.from).number === tr.startState.doc.lineAt(sel.to).number) return tr
        }
        let count = 0
        let fromA = -1
        let toA = -1
        let at = -1
        let end = -1
        tr.changes.iterChanges((a, b, c, d) => {
            count += 1
            fromA = a
            toA = b
            at = c
            end = d
        })
        if (count !== 1) return tr
        const before = tr.startState.doc
        const startLines = before.toString().split('\n')
        const firstA = before.lineAt(fromA).number - 1
        const lastA = before.lineAt(toA).number - 1
        const startBlocks = fencedBlocks(startLines)
        // Code or YAML is not an outline; a form-1 opener is a bullet, whose code travels with it.
        if (opaqueLineFlags(startLines, startBlocks)[firstA] && !formOneOpeners(startLines, startBlocks).has(firstA)) return tr
        const removedLines = lastA - firstA + 1
        // A range from prose that took a column-0 bullet's marker: the bullet leaves the list, its own lines
        // to the margin and its children up a level. Read before the edit; the line after the replacement
        // (Enter's new line included) is where the bullet's own line went, the lines after it in step.
        const cuts = cutsAfterBulletIntoProse(startLines, firstA, lastA, toA - before.line(lastA + 1).from, startBlocks)
        const text = tr.newDoc.toString()
        const lines = text.split('\n')
        const caretLine = tr.newDoc.lineAt(at).number - 1
        const shift = tr.newDoc.lineAt(end).number - 1 - lastA
        if (typed) {
            // Only the selection's own replacement, and only one that took a bullet into prose.
            const sel = tr.startState.selection.main
            if (sel.empty || sel.from !== fromA || sel.to !== toA || cuts.length === 0) return tr
            const changes = reindents(tr.newDoc, lines, applyLeaveListCuts(lines, cuts, shift))
            return changes.length ? [tr, { changes, sequential: true }] : tr
        }
        let healed: string[]
        let healedCaretLine = caretLine
        if (cut && removedLines >= 2) {
            ;({ lines: healed, caretLine: healedCaretLine } = healAfterRangeDelete(applyLeaveListCuts(lines, cuts, shift), caretLine))
        } else if (removedLines === 1 && isBulletLine(startLines[firstA]) && !isBulletLine(lines[caretLine])) {
            if (lines[caretLine].trim() === '') {
                ;({ lines: healed, caretLine: healedCaretLine } = healAfterRangeDelete(lines, caretLine))
            } else {
                const blocks = fencedBlocks(lines)
                const { start, end: last } = healSpan(lines, caretLine, blocks)
                healed = healAroundMasked(lines, caretLine, start, last, blocks)
            }
        } else {
            return tr
        }
        // The smallest replacement (shared prefix and suffix trimmed), appended to the delete itself.
        const change = minimalReplacement(text, healed.join('\n'))
        if (!change) return tr
        const head = tr.newSelection.main.head
        if (head < change.from || head > change.to) return [tr, { changes: change, sequential: true }]
        let offset = 0
        for (let i = 0; i < healedCaretLine; i++) offset += healed[i].length + 1
        const anchor = offset + clampColumn(healed, healedCaretLine)
        return [tr, { changes: change, sequential: true, selection: { anchor } }]
    })
}

/**
 * The heal as one change per line it re-indents: the heal moves lines only by their indentation, so a
 * caret on the text maps through untouched.
 */
function reindents(doc: Text, lines: string[], healed: string[]): ChangeSpec[] {
    const changes: ChangeSpec[] = []
    healed.forEach((line, i) => {
        if (line === lines[i]) return
        const from = doc.line(i + 1).from
        changes.push({ from, to: from + lineIndent(lines[i]), insert: line.slice(0, lineIndent(line)) })
    })
    return changes
}
