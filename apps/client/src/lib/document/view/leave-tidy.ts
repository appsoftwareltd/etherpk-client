/**
 * Tidy on leave: when the caret leaves a [[Block]] or a prose line, the text it left is trimmed of
 * ghost whitespace — the trailing spaces, empty soft lines and stray indentation editing leaves
 * behind and nothing ever shows — and a task's stray Task Tags move into its tag run (Editor
 * Content Rules → *Tidy on leave*).
 *
 * Ghost whitespace is not harmless. A whitespace-only soft line is *inside* its block by the
 * indent-decides rule (ADR 0021), so an empty `  ` left after a Shift+Enter keeps a block open,
 * moves group boundaries, and reads as a continuation to every structural key; trailing spaces
 * shift wrap points and caret columns; `-   text` renders a gap no key can explain. Trimming as the
 * caret leaves — the one moment the user has visibly finished with the block — removes all of it
 * without ever fighting what is being typed.
 *
 * What is trimmed, per kind of thing left:
 *
 * - **An outliner block** (a bullet plus its continuation lines, fences included): whitespace after
 *   the marker and at the end of every own line; whitespace-only soft lines at the block's END are
 *   removed (they are trailing newlines of the block's content); when the bullet line itself is
 *   empty, blank soft lines after it are removed and the first content line at the content column
 *   is pulled up onto the bullet line (leading newlines). Blank soft lines BETWEEN content lines stay:
 *   they are the block's own paragraph breaks. Fenced code inside the block is opaque and untouched.
 * - **A prose line** (owned by no bullet): trailing whitespace removed; a whitespace-only line
 *   becomes empty; leading whitespace of fewer than four spaces removed — CommonMark reads up to
 *   three as insignificant and four or more as an indented code block, which is kept.
 * - **A task's stray [[Task Tag]]s**: a Task Tag written as its own word later in a task's bullet
 *   line, outside code, links, URLs and inline maths, moves into the leading run, a priority or date
 *   set as the `#` helper sets it but never cleared, and a state tag setting the task's status with
 *   the checkbox to match (`applyStrayTaskTags`, task-tags.ts). The grammar reads only the run as
 *   metadata (ADR 0032), so `#P1` typed at the end of a task would otherwise stay prose. A status
 *   that ticks, archives or unticks the task brings its nested tasks along in the same transaction,
 *   as a status menu or Kanban move does (`task-cascade.ts`).
 * - **Fenced code and [[Frontmatter]]** are never touched, wherever the caret came from.
 *
 * Implemented as a transaction filter over transactions that set the selection (a click, an arrow,
 * a key that creates the next block): the trim rides in the same transaction as the move, so a
 * single undo reverses both. A selection being made (a drag, Shift+arrow) is not leaving, and each
 * change is cut down to the characters that differ, so a caret on an unchanged line stays put. Remote and external transactions never set a selection and are never
 * tidied; undo and redo are left alone, and so is a caret the app places (a reveal, a restored
 * Reading Position), which goes in out of the history (`placeSelection`, view-position.ts) because
 * the user did not walk away from anything. It is registered FIRST among the base filters, which
 * CodeMirror runs in reverse order, so it judges the transaction after the paste clamp, the fence
 * guard, the delete heal and the caret clamp have shaped it — tidying the raw paste of a newline,
 * before the clamp had indented it, removed the very soft line the clamp was about to create.
 */

import { type ChangeSpec, EditorState, type Extension, MapMode, type Text, Transaction, type TransactionSpec } from '@codemirror/state'

import { frontmatterLines } from '#lib/storage/fs/frontmatter-span.js'

import { fencedBlocks } from '../fenced-code'
import { nestedTaskWrites } from '../task-cascade'
import { applyStrayTaskTags } from '../task-tags'
import { blockBodyEnd, branchRange, bulletContent, contentColumn, formOneOpeners, isBulletLine, lineIndent, markerLength, opaqueLineFlags, ownerBulletIndex, trimLineEnd } from '../outliner'
import { scanInlineMath } from './augmentations/math-inline-core'
import { collaborative, EXTERNAL } from './cm-document'
import { minimalReplacement } from './minimal-replacement'
import { isOwnEditing } from './own-editing'

/** Where a caret is, as far as tidying is concerned: an outliner block (by its bullet line), a prose line, or nothing tidyable. */
export type TidyTarget = { kind: 'block'; owner: number } | { kind: 'prose'; line: number } | null

/** The tidy target containing 0-based line `i`. */
export function tidyTargetAt(lines: string[], i: number): TidyTarget {
    const blocks = fencedBlocks(lines)
    const opaque = opaqueLineFlags(lines, blocks)
    if (i < frontmatterLines(lines)) return null
    const owner = ownerBulletIndex(lines, i, blocks)
    if (owner !== null) return { kind: 'block', owner }
    if (opaque[i]) return null // top-level code: nothing to tidy
    if (lines[i].trim() === '' && lineIndent(lines[i]) === 0) return null // a bare empty line: already tidy, and nobody's
    return { kind: 'prose', line: i }
}

/**
 * Leading newlines: an empty bullet line `out[0]` followed by blank soft lines and then content at
 * the content column takes that content onto its own line. Rewrites `out` in place.
 */
function pullUpLeadingContent(out: string[], isOpaque: (k: number) => boolean): void {
    let k = 1
    while (k < out.length && !isOpaque(k) && out[k].trim() === '') k++
    if (k < out.length && !isOpaque(k) && lineIndent(out[k]) === contentColumn(out[0])) {
        out[0] = out[0] + out[k].trimStart()
        out.splice(1, k)
    } else if (k > 1 && k >= out.length) {
        out.splice(1) // only blank soft lines followed: they were trailing after all
    }
}

/** The block's lines tidied (see the module comment): a replacement for `lines[owner..end]`, or null when nothing changes. */
export function tidiedBlock(lines: string[], owner: number): { from: number; to: number; lines: string[] } | null {
    const blocks = fencedBlocks(lines)
    const opaque = opaqueLineFlags(lines, blocks)
    const end = blockBodyEnd(lines, owner, blocks)
    const own = lines.slice(owner, end + 1)
    const isOpaque = (k: number) => opaque[owner + k] || blocks.some((b) => b.start === owner + k) // fence lines, opener included
    const out = own.map((line, k) => {
        if (isOpaque(k)) return line
        if (k === 0) {
            const indent = line.slice(0, lineIndent(line))
            const marker = line.slice(indent.length, indent.length + markerLength(line))
            return indent + marker + trimLineEnd(bulletContent(line).replace(/^[ \t]+/, ''))
        }
        return line.trim() === '' ? line : trimLineEnd(line)
    })
    // Trailing newlines: whitespace-only soft lines at the end of the block go.
    while (out.length > 1 && !isOpaque(out.length - 1) && out[out.length - 1].trim() === '') out.pop()
    if (!isOpaque(0) && bulletContent(out[0]) === '') pullUpLeadingContent(out, isOpaque)
    // A Task Tag written later in a task goes into its leading run, once the line is trimmed and any
    // content pulled up onto it. Only the bullet line is the task: a tag on a soft line is prose.
    if (!isOpaque(0)) out[0] = applyStrayTaskTags(out[0], scanInlineMath(out[0])) ?? out[0]
    return out.length === own.length && out.every((l, k) => l === own[k]) ? null : { from: owner, to: end, lines: out }
}

/**
 * The block's lines after its children tidied: the runs of its own lines that follow a child's branch
 * (a paragraph after a sublist, as CommonMark writes it; the outliner's keys never make one). Each run
 * loses its trailing whitespace; the last run loses its whitespace-only lines at the end, which are the
 * block's trailing newlines. A blank soft line between a child and a paragraph stays: it is what other
 * readers need to see a paragraph there. One replacement per run that changes, in document order; an
 * empty `lines` removes the run outright.
 */
export function tidiedAfterChildren(lines: string[], owner: number): { from: number; to: number; lines: string[] }[] {
    const blocks = fencedBlocks(lines)
    const opaque = opaqueLineFlags(lines, blocks)
    const bulletOpeners = formOneOpeners(lines, blocks)
    const bodyEnd = blockBodyEnd(lines, owner, blocks)
    const branchEnd = branchRange(lines, owner, blocks).end
    const runs: { from: number; to: number }[] = []
    for (let j = bodyEnd + 1; j <= branchEnd; j++) {
        if (isBulletLine(lines[j]) && (!opaque[j] || bulletOpeners.has(j))) {
            j = branchRange(lines, j, blocks).end // a child's branch, its own tidy's business
            continue
        }
        const last = runs[runs.length - 1]
        if (last && last.to === j - 1) last.to = j
        else runs.push({ from: j, to: j })
    }
    const out: { from: number; to: number; lines: string[] }[] = []
    runs.forEach((run, n) => {
        const own = lines.slice(run.from, run.to + 1)
        const tidied = own.map((line, k) => (opaque[run.from + k] || line.trim() === '' ? line : trimLineEnd(line)))
        if (n === runs.length - 1) while (tidied.length && !opaque[run.from + tidied.length - 1] && tidied[tidied.length - 1].trim() === '') tidied.pop()
        if (tidied.length !== own.length || tidied.some((l, k) => l !== own[k])) out.push({ from: run.from, to: run.to, lines: tidied })
    })
    return out
}

/** The prose line tidied, or null when it is already tidy. */
export function tidiedProse(line: string): string | null {
    if (line.trim() === '') return line === '' ? null : ''
    const indent = lineIndent(line)
    const next = trimLineEnd(indent < 4 && !line.slice(0, indent).includes('\t') ? line.slice(indent) : line)
    return next === line ? null : next
}

/** Whether `a` and `b` are the same target. */
function sameTarget(a: TidyTarget, b: TidyTarget): boolean {
    if (a === null || b === null) return a === b
    if (a.kind !== b.kind) return false
    return a.kind === 'block' ? a.owner === (b as { owner: number }).owner : a.line === (b as { line: number }).line
}

/**
 * The nested tasks a tidied task line brings with it: a stray state tag that sets the task's status
 * ticks, archives or unticks the tasks under it as a status menu or [[Kanban Board]] move does
 * (`nestedTaskWrites`, task-cascade.ts), one line each. Trimming alone never changes a status, so a
 * tidy without a state tag brings nothing. A line the leaving transaction itself wrote (`written`,
 * 0-based) is left out: it is the new task Enter just made under the one left, which the person is
 * about to type in, not one they finished with.
 */
function cascadedTaskTidies(lines: string[], owner: number, body: { lines: string[] } | null, written: (index: number) => boolean): { from: number; to: number; lines: string[] }[] {
    if (!body) return []
    return nestedTaskWrites(lines, owner, body.lines[0])
        .filter(({ index }) => !written(index))
        .map(({ index, after }) => ({ from: index, to: index, lines: [after] }))
}

/**
 * The changes that tidy the block at `owner` and its lines after its children, and write the nested
 * tasks a status set by a stray tag brings along, each cut down to the characters that differ
 * (`minimalReplacement`), so a caret on one of the block's unchanged lines keeps its place instead
 * of being carried to the edge of a replaced range. The ranges never overlap: the nested tasks are
 * bullet lines in the children's branches, which neither the body nor the runs after them hold.
 */
function blockTidyChanges(doc: Text, lines: string[], owner: number, written: (index: number) => boolean): ChangeSpec[] {
    const body = tidiedBlock(lines, owner)
    const tidies = [...(body ? [body] : []), ...tidiedAfterChildren(lines, owner), ...cascadedTaskTidies(lines, owner, body, written)]
    return tidies.flatMap((tidy) => {
        // A run removed outright takes the line break before it, so no bare blank line is left to end the group.
        const from = tidy.lines.length === 0 ? doc.line(tidy.from).to : doc.line(tidy.from + 1).from
        const to = doc.line(tidy.to + 1).to
        const change = minimalReplacement(doc.sliceString(from, to), tidy.lines.join('\n'))
        return change ? [{ from: from + change.from, to: from + change.to, insert: change.insert }] : []
    })
}

/** Whether the transaction's own changes wrote to a line of its new document (0-based), as a lookup. */
function writtenLines(tr: Transaction): (index: number) => boolean {
    const written = new Set<number>()
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
        for (let n = tr.newDoc.lineAt(fromB).number; n <= tr.newDoc.lineAt(toB).number; n++) written.add(n - 1)
    })
    return (index) => written.has(index)
}

export function leaveTidy(): Extension {
    return EditorState.transactionFilter.of((tr): TransactionSpec | readonly TransactionSpec[] => {
        if (!tr.selection) return tr // no caret motion of the user's
        if (tr.annotation(EXTERNAL)) return tr
        // A synced editor's change that is not the user's own editing came from the shared text:
        // another member's edit, or the undo manager's. It carries a selection when the caret clamp
        // moved the caret it mapped, but nobody left anything, and y-codemirror never sends what
        // rides that transaction to the Y.Text: a trim here would part the editor from it.
        if (tr.docChanged && tr.startState.facet(collaborative) && !isOwnEditing(tr)) return tr
        if (tr.annotation(Transaction.addToHistory) === false || tr.isUserEvent('undo') || tr.isUserEvent('redo')) return tr
        // A selection being made (a drag, Shift+arrow, Select all) is not leaving: a selection made to
        // copy would copy rewritten text, and a shrinking block selection must never edit.
        if (!tr.newSelection.main.empty) return tr
        const oldHead = tr.startState.selection.main.head
        const oldLines = tr.startState.doc.toString().split('\n')
        const left = tidyTargetAt(oldLines, tr.startState.doc.lineAt(oldHead).number - 1)
        if (left === null) return tr
        // Where the left thing sits now: its first line's start, mapped through this transaction's changes.
        const anchorLine = left.kind === 'block' ? left.owner : left.line
        const mapped = tr.changes.mapPos(tr.startState.doc.line(anchorLine + 1).from, 1, MapMode.TrackDel)
        if (mapped === null) return tr // the thing left was deleted by this very transaction
        const doc = tr.newDoc
        const lines = doc.toString().split('\n')
        const nowAt = doc.lineAt(mapped).number - 1
        const leftNow = tidyTargetAt(lines, nowAt)
        if (leftNow === null || (leftNow.kind === 'block' && leftNow.owner !== nowAt)) return tr // no longer the thing that was left: leave it
        const arrived = tidyTargetAt(lines, doc.lineAt(tr.newSelection.main.head).number - 1)
        if (sameTarget(leftNow, arrived)) return tr // still inside
        if (leftNow.kind === 'block') {
            const changes = blockTidyChanges(doc, lines, leftNow.owner, writtenLines(tr))
            return changes.length === 0 ? tr : [tr, { changes, sequential: true }]
        }
        const next = tidiedProse(lines[leftNow.line])
        if (next === null) return tr
        const line = doc.line(leftNow.line + 1)
        return [tr, { changes: { from: line.from, to: line.to, insert: next }, sequential: true }]
    })
}
