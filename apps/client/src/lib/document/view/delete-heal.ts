/**
 * Heal the outline after a delete the keymap does not see (ADR 0021). Backspace and Delete over a
 * multi-line selection go through the keymap, which heals the group afterwards; two other deletions
 * bypass it and used to leave a block's surviving descendants floating at their old depth with no
 * parent:
 *
 * - **Ctrl+X** goes through CodeMirror's own cut handler. A cut that removed more than one line gets
 *   the same heal ({@link healAfterRangeDelete}): the blank artifact at the join goes, and every
 *   orphaned block is pulled up to one level under its nearest surviving ancestor (indent 0 when the
 *   whole top of the tree went), its subtree and fenced blocks moving with it.
 * - A **within-line selection that takes a bullet's marker** (a drag from the line's left margin over
 *   the dot, then Backspace, Delete or Ctrl+X) is character-precise, so the default delete runs and
 *   the line stops being a bullet while its children keep their depth — under a blank line, or under
 *   a prose line, with no parent either way. The block is gone, so its children re-parent as if it
 *   had been deleted whole: a whitespace-only remainder is removed and the group healed
 *   ({@link healAfterRangeDelete}); a prose remainder stays as the line it is (a soft line of the
 *   block above, or top-level prose) and the group is healed around it ({@link healOrphanIndent}
 *   with the line masked out, so it is nobody's parent). A within-line delete that leaves the marker
 *   in place (the content cleared) is an edit to the block, not its removal, and is left alone.
 *
 * Fenced-code interiors and the [[Frontmatter]] are opaque: a `- x` there is code or YAML, and a
 * filter never changes the document beyond the edit made in it.
 *
 * The caret: in the live editor the caret clamp runs BEFORE this filter (it is registered later, in
 * editor-extensions.ts), so a caret the heal's replacement span swallows would collapse to the span's
 * start — column 0 of the next line. When the caret falls inside the span it is placed explicitly at
 * the healed line's content column; otherwise it maps through the change as usual.
 */

import { EditorState, type Extension } from '@codemirror/state'

import { fencedBlocks } from '../fenced-code'
import { healAfterRangeDelete, healOrphanIndent, healSpan, isBulletLine, opaqueLineFlags } from '../outliner'
import { clampColumn } from './caret-clamp'
import { minimalReplacement } from './minimal-replacement'

export function deleteHeal(): Extension {
    return EditorState.transactionFilter.of((tr) => {
        if (!tr.docChanged || !(tr.isUserEvent('delete.cut') || tr.isUserEvent('delete.selection'))) return tr
        let count = 0
        let fromA = -1
        let toA = -1
        let at = -1
        tr.changes.iterChanges((a, b, c) => {
            count += 1
            fromA = a
            toA = b
            at = c
        })
        if (count !== 1) return tr
        const before = tr.startState.doc
        const startLines = before.toString().split('\n')
        const firstA = before.lineAt(fromA).number - 1
        if (opaqueLineFlags(startLines, fencedBlocks(startLines))[firstA]) return tr // code or YAML: not an outline
        const removedLines = before.lineAt(toA).number - firstA
        const text = tr.newDoc.toString()
        const lines = text.split('\n')
        const caretLine = tr.newDoc.lineAt(at).number - 1
        let healed: string[]
        let healedCaretLine = caretLine
        if (tr.isUserEvent('delete.cut') && removedLines >= 2) {
            ;({ lines: healed, caretLine: healedCaretLine } = healAfterRangeDelete(lines, caretLine))
        } else if (removedLines === 1 && isBulletLine(startLines[firstA]) && !isBulletLine(lines[caretLine])) {
            if (lines[caretLine].trim() === '') {
                ;({ lines: healed, caretLine: healedCaretLine } = healAfterRangeDelete(lines, caretLine))
            } else {
                const blocks = fencedBlocks(lines)
                const { start, end } = healSpan(lines, caretLine, blocks)
                const masked = lines.slice()
                masked[caretLine] = '' // a blank is skipped by the heal: the prose line is nobody's parent
                healed = healOrphanIndent(masked, start, end, blocks)
                healed[caretLine] = lines[caretLine]
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
