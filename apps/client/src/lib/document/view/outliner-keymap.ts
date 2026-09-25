/**
 * The Logseq-style outliner keyboard layer (Dual Mode Editor.md → Keyboard scheme).
 * These are CodeMirror commands operating on the active EditorView — editor ops are
 * CM-native, not routed through the app command registry (they need synchronous view
 * access + a boolean return). The structural logic lives in the pure `../outliner`
 * module; this file is the thin CM adapter.
 */

import { codeFolding, foldService, toggleFold } from '@codemirror/language'
import { type ChangeSpec, EditorSelection, type Extension, type StateCommand, type TransactionSpec } from '@codemirror/state'
import { type Command, type KeyBinding, keymap } from '@codemirror/view'

import { frontmatterLines } from '$lib/storage/fs/frontmatter-span'

import { getActiveGraphSettings } from '../active-graph-settings'
import {
    blockBodyEnd,
    branchRange,
    branchRootsWithin,
    bulletContent,
    canIndent,
    canOutdent,
    computeMove,
    contentColumn,
    continuationFloor,
    cycleTask,
    healAfterRangeDelete,
    healOrphanIndent,
    opaqueLineFlags,
    isBulletLine,
    isHeadingLine,
    isMergeableSource,
    lineIndent,
    MARKER_WIDTH,
    markerLength,
    mergeTargetAbove,
    mergeWouldStrand,
    newBulletMarker,
    outdentTarget,
    ownerBulletIndex,
    prevSiblingRange,
    shiftLines,
    treeRootIndex,
} from '../outliner'
import { buildFenceCompletion, fencedBlocks, fenceLineInfo } from '../fenced-code'
import { INDENT, INDENT_UNIT } from '../indent-unit'
import { minimalReplacement } from './minimal-replacement'
import { toggleBold, toggleHighlight, toggleItalic } from './wrap-selection'
import { isBlockSelection, rangeBlockOwner } from './block-select'
import { caretContext, type FencedBlock, fencedBlockAt, unterminatedFenceOpenerAt } from './outliner-context'
import { taskToggleable } from './task-toggleable'

/**
 * What a command needs: the state and a way to dispatch a transaction. Every structural command is
 * a CodeMirror `StateCommand` (not a `Command`) on purpose - it touches no DOM, so the keyboard rules
 * run in plain Node against `EditorState` (see `testing/editor-state-fixture.ts`) as well as inside
 * a live `EditorView`. A `StateCommand` is assignable wherever a `Command` is expected.
 */
type Target = Parameters<StateCommand>[0]

/** Apply a transaction spec to a command target (an `EditorView` or a bare state holder). */
function dispatch(target: Target, spec: TransactionSpec): void {
    target.dispatch(target.state.update(spec))
}

interface Ctx {
    lines: string[]
    /** 0-based index of the line holding the cursor. */
    index: number
    /** Cursor head offset. */
    head: number
    line: string
    /** Document-offset of the start of line `index`. */
    lineFrom: number
    empty: boolean // selection is empty (a caret)
}

function ctx(view: Target): Ctx {
    const { state } = view
    const sel = state.selection.main
    const lineObj = state.doc.lineAt(sel.head)
    const lines = state.doc.toString().split('\n')
    return {
        lines,
        index: lineObj.number - 1,
        head: sel.head,
        line: lines[lineObj.number - 1],
        lineFrom: lineObj.from,
        empty: sel.empty,
    }
}

/** Document offset of the start of 0-based line `n`. */
function offsetOfLine(view: Target, n: number): number {
    return view.state.doc.line(n + 1).from
}

/**
 * The branches a block selection covers: the 0-based index of every bullet line in the selected
 * lines that is not inside an earlier selected branch. A selection reaching from one block into
 * another is block-granular (block-select.ts), so Tab and Shift-Tab act on all of its branches
 * together, the way Logseq moves a multi-block selection — not on the line the head happens to sit
 * on. Null for a caret, a text range or a prose selection: those keep the caret-line rule (a range
 * inside one block acting on that block). Descendants past the selection's last line still travel
 * with their root; a branch is never split by where a drag stopped.
 */
function selectedBranchRoots(view: Target, lines: string[]): { roots: number[]; firstLine: number; lastLine: number } | null {
    if (!isBlockSelection(view.state)) return null
    const main = view.state.selection.main
    const firstLine = view.state.doc.lineAt(main.from).number - 1
    const lastLine = view.state.doc.lineAt(main.to).number - 1
    return { roots: branchRootsWithin(lines, firstLine, lastLine), firstLine, lastLine }
}

/**
 * Apply a shift of every selected branch and keep the selection on the same whole lines. Mapping
 * the selection through the change would leave its start after the inserted indent (a range's
 * `from` maps forward past an insertion at its position), so it is re-anchored explicitly.
 */
function dispatchBranchShift(view: Target, changes: ChangeSpec[], firstLine: number, lastLine: number): void {
    const { state } = view
    const set = state.changes(changes)
    const from = set.mapPos(state.doc.line(firstLine + 1).from, -1)
    const to = set.mapPos(state.doc.line(lastLine + 1).to, 1)
    const forward = state.selection.main.head >= state.selection.main.anchor
    dispatch(view, { changes: set, selection: EditorSelection.single(forward ? from : to, forward ? to : from) })
}

/**
 * The columns Tab adds to the branch rooted at `root`: onto the grid one Indent Unit under its
 * previous sibling (ADR 0067). On two-space text that is exactly one unit; on foreign text (a
 * four-space child) it is whatever lands the root at sibling + 2, the descendants keeping their
 * own offsets. Only for a root that {@link canIndent}.
 */
function indentDelta(lines: string[], root: number): number {
    const sibling = prevSiblingRange(lines, root)!
    return lineIndent(lines[sibling.start]) + INDENT_UNIT - lineIndent(lines[root])
}

/** Changes shifting every line of the branch rooted at `root` by `delta` columns (never below 0). */
function branchShift(view: Target, lines: string[], root: number, delta: number): ChangeSpec[] {
    const { start, end } = branchRange(lines, root)
    const changes: ChangeSpec[] = []
    for (let j = start; j <= end; j++) {
        const from = offsetOfLine(view, j)
        if (delta > 0) changes.push({ from, insert: ' '.repeat(delta) })
        else if (delta < 0) {
            const n = Math.min(-delta, lineIndent(lines[j]))
            if (n > 0) changes.push({ from, to: from + n })
        }
    }
    return changes
}

export const indentBranch: StateCommand = (view) => {
    const { lines, index, line, lineFrom, head } = ctx(view)
    const selected = selectedBranchRoots(view, lines)
    if (selected) {
        // Every selected branch nests one level, or none does: each needs a previous sibling to
        // nest under, judged in the document as it stands — a later selected sibling's previous
        // sibling is the earlier one, which moves with it, so the pair keeps its shape.
        if (!selected.roots.every((root) => canIndent(lines, root))) return true // consume — never move focus
        const changes: ChangeSpec[] = []
        for (const root of selected.roots) changes.push(...branchShift(view, lines, root, indentDelta(lines, root)))
        dispatchBranchShift(view, changes, selected.firstLine, selected.lastLine)
        return true
    }
    // A range across lines of one block acts on the block, as a caret on its bullet line does
    // (Logseq): read from the head's line alone, a continuation would become a child of its own block.
    // The range is mapped through the shift, so it stays on its text.
    const at = rangeBlockOwner(view.state) ?? index
    if (!isBulletLine(lines[at])) {
        // Prose: Tab makes the line a block. Leading spaces in markdown prose are meaningless at best
        // and an indented code block at four, so "indent" here means "enter the list": a bullet at
        // column 0, or one level under its bullet when the line is a continuation (the same rule the
        // task conversion uses). Headings, code and frontmatter are refused; the key is still consumed
        // so focus never leaves the editor. This is also the Command Bar's indent button on mobile,
        // where there is no other way into block mode than positioning the caret by touch.
        if (!taskToggleable(view.state)) return true
        const indent = ' '.repeat(taskIndentFor(lines, index))
        const text = line.trimStart()
        const next = `${indent}- ${text}`
        const textCaret = Math.max(0, head - lineFrom - (line.length - text.length))
        dispatch(view, {
            changes: { from: lineFrom, to: lineFrom + line.length, insert: next },
            selection: { anchor: lineFrom + indent.length + MARKER_WIDTH + textCaret },
        })
        return true
    }
    if (!canIndent(lines, at)) return true // consume — never move focus
    dispatch(view, { changes: branchShift(view, lines, at, indentDelta(lines, at)) })
    return true
}

export const outdentBranch: StateCommand = (view) => {
    const { lines, index, line, lineFrom } = ctx(view)
    // Shift-Tab lands the root on its parent's indent (column 0 without one): one press is one level
    // on any grid (ADR 0067), the descendants keeping their own offsets.
    const outdentDelta = (root: number) => outdentTarget(lines, root) - lineIndent(lines[root])
    const selected = selectedBranchRoots(view, lines)
    if (selected) {
        // Every selected branch lifts one level, or none does. A root at the top level is refused
        // rather than turned into prose: the caret-line rule's exit from the list would leave the
        // other selected blocks under a prose line, split from their group.
        if (!selected.roots.every((root) => canOutdent(lines, root))) return true // consume
        const changes: ChangeSpec[] = []
        for (const root of selected.roots) changes.push(...branchShift(view, lines, root, outdentDelta(root)))
        dispatchBranchShift(view, changes, selected.firstLine, selected.lastLine)
        return true
    }
    const at = rangeBlockOwner(view.state) ?? index // a range inside one block lifts the block, as for Tab
    if (!isBulletLine(lines[at])) {
        // A continuation line under a bullet can't outdent past the content column (bullet + space).
        const floor = continuationFloor(lines, index)
        const n = Math.max(0, Math.min(INDENT_UNIT, lineIndent(line) - floor))
        if (n > 0) dispatch(view, { changes: { from: lineFrom, to: lineFrom + n } })
        return true
    }
    if (!canOutdent(lines, at)) {
        outdentPastRoot(view, lines, at)
        return true
    }
    dispatch(view, { changes: branchShift(view, lines, at, outdentDelta(at)) })
    return true
}

/**
 * Outdent the branch at `root` PAST the root. The bullet line becomes prose (marker and any checkbox
 * removed, the caret staying on its character), its own continuation lines and fenced block go to
 * column 0 with it, and its descendants come up one level so none is left under a prose line. The
 * mobile Command Bar's outdent button is the only way out of block mode there other than positioning
 * the caret by touch; Ctrl+Enter is the keyboard's. Reached from the root line, and from a fence line
 * of the root's block ({@link shiftTabInCode}), so the caret is mapped through the removals rather
 * than assumed to be on the root.
 */
function outdentPastRoot(view: Target, lines: string[], root: number): void {
    const { state } = view
    const lineFrom = offsetOfLine(view, root)
    const { end } = branchRange(lines, root)
    const bodyEnd = blockBodyEnd(lines, root)
    const marker = markerLength(lines[root])
    const changes: ChangeSpec[] = [{ from: lineFrom, to: lineFrom + marker }]
    // The children come up by the first child's own indent, so a four-space child lands at 0 too.
    const childDrop = end > bodyEnd ? lineIndent(lines[bodyEnd + 1]) : 0
    for (let j = root + 1; j <= end; j++) {
        const from = offsetOfLine(view, j)
        const drop = j <= bodyEnd ? Math.min(lineIndent(lines[j]), MARKER_WIDTH) : Math.min(lineIndent(lines[j]), childDrop)
        if (drop > 0) changes.push({ from, to: from + drop })
    }
    const set = state.changes(changes)
    const sel = state.selection.main
    dispatch(view, { changes: set, selection: EditorSelection.range(set.mapPos(sel.anchor, -1), set.mapPos(sel.head, -1)) })
}

/** The caret's line as a continuation of a block: its owner and floor, or null on a bullet, prose or code line. */
function continuationAt(view: Target): { lines: string[]; index: number; line: string; lineFrom: number; head: number; owner: number; floor: number } | null {
    if (!view.state.selection.main.empty || caretContext(view.state) === 'fenced-code') return null
    const c = ctx(view)
    if (isBulletLine(c.line)) return null
    const owner = ownerBulletIndex(c.lines, c.index)
    const floor = continuationFloor(c.lines, c.index)
    if (owner === null || floor <= 0) return null
    return { ...c, owner, floor }
}

/**
 * Enter on a [[Continuation Line]] splits the block there (CONTEXT.md → Continuation Line): the caret's
 * line from the caret on, and every line after it up to the block's last own line, become a new block
 * of the same kind (unchecked). A sibling at the same indent, or the first child when the block has
 * children (ADR 0019's rule for Enter at the end of a bullet with children), so existing children are
 * never re-parented. Travelling lines shift with the new content column, a fence as a unit.
 */
const splitContinuation: StateCommand = (view) => {
    const cont = continuationAt(view)
    if (!cont) return false
    const { lines, index, line, lineFrom, head, owner, floor } = cont
    const { state } = view
    const ownerIndent = lineIndent(lines[owner])
    const bodyEnd = blockBodyEnd(lines, owner)
    const branchEnd = branchRange(lines, owner).end
    const hasChildren = branchEnd > bodyEnd
    // A continuation after the block's children (a paragraph after a sublist, as CommonMark writes it)
    // is past the body: the new block is the owner's next sibling and takes the rest of the branch.
    const afterChildren = index > bodyEnd
    const last = afterChildren ? branchEnd : bodyEnd
    // A first child matches the existing children's indent (as Enter at the end of a bullet does), so a
    // document on a foreign grid keeps its shape (ADR 0067).
    const newIndent = hasChildren && !afterChildren ? lineIndent(lines[bodyEnd + 1]) : ownerIndent
    const marker = newBulletMarker(lines[owner])
    const col = head - lineFrom
    const keepBefore = line.slice(0, col).trim() !== ''
    const moved = [' '.repeat(newIndent) + marker + line.slice(col), ...shiftLines(lines.slice(index + 1, last + 1), newIndent + MARKER_WIDTH - floor)]
    // Replace from the caret (keeping the text before it as the last continuation) or, when nothing
    // precedes the caret, from the end of the previous line so no blank continuation is left behind.
    const from = keepBefore ? head : state.doc.line(index).to
    const to = state.doc.line(last + 1).to
    const insert = '\n' + moved.join('\n')
    dispatch(view, { changes: { from, to, insert }, selection: { anchor: from + 1 + newIndent + marker.length }, userEvent: 'input' })
    return true
}

const enterBullet: StateCommand = (view) => {
    const { lines, index, line, head, lineFrom, empty } = ctx(view) // `empty` = a bare caret (NOT "empty bullet")
    if (!empty || !isBulletLine(line)) return false // a real selection → let the default split handle it

    // At the end of a bullet that HAS children → a new FIRST child, matching the children's indent
    // (ADR 0019). Otherwise → a sibling at the same indent (covers empty-content and mid-line splits;
    // the empty→outdent arm is gone — outdent is Shift-Tab, leaving the list is Mod-Enter breakout).
    const atLineEnd = head === lineFrom + line.length
    const next = lines[index + 1]
    if (atLineEnd && next !== undefined && isBulletLine(next) && lineIndent(next) > lineIndent(line)) {
        const insert = '\n' + ' '.repeat(lineIndent(next)) + newBulletMarker(next)
        dispatch(view, { changes: { from: head, insert }, selection: { anchor: head + insert.length } })
        return true
    }
    const indent = line.slice(0, lineIndent(line))
    const insert = '\n' + indent + newBulletMarker(line)
    dispatch(view, { changes: { from: head, insert }, selection: { anchor: head + insert.length } })
    return true
}

const softNewline: StateCommand = (view) => {
    const { line, head } = ctx(view)
    const cont = continuationAt(view)
    if (cont) {
        // On a continuation line, another continuation at the block's floor (not the line's own indent).
        const insert = '\n' + ' '.repeat(cont.floor)
        dispatch(view, { changes: { from: head, insert }, selection: { anchor: head + insert.length } })
        return true
    }
    if (!isBulletLine(line)) return false
    // Continuation aligns to the marker's content column (one space right of the bullet, ADR 0020).
    const insert = '\n' + ' '.repeat(contentColumn(line))
    dispatch(view, { changes: { from: head, insert }, selection: { anchor: head + insert.length } })
    return true
}

/**
 * Break out of the outliner (ADR 0019): open a prose line at column 0 *after the whole tree* the
 * caret's block belongs to (its top-level ancestor's branch), carrying any text right of the caret
 * out to it. After the branch alone, a nested block's following siblings would be cut off from their
 * parent by the prose line and, in CommonMark, an indented line after a paragraph is that
 * paragraph's continuation, not a list item, so the exit point is the tree's end and no key ever
 * leaves an orphan. In prose this returns false so the default newline applies.
 */
const breakoutToProse: StateCommand = (view) => {
    const cont = continuationAt(view)
    if (cont) {
        // On a continuation line everything from the caret on leaves as prose after the branch, dedented
        // by the floor (a trailing fence as a unit); the block keeps the text before the caret.
        const { lines, index, line, lineFrom, head, owner, floor } = cont
        const { state } = view
        const bodyEnd = blockBodyEnd(lines, owner)
        // From a continuation after the block's children the rest of the branch leaves with the text.
        const last = index > bodyEnd ? branchRange(lines, owner).end : bodyEnd
        const col = head - lineFrom
        const keepBefore = line.slice(0, col).trim() !== ''
        const leaving = [line.slice(col), ...shiftLines(lines.slice(index + 1, last + 1), -floor)]
        const from = keepBefore ? head : state.doc.line(index).to
        const to = state.doc.line(last + 1).to
        const branchEndTo = state.doc.line(branchRange(lines, treeRootIndex(lines, owner)).end + 1).to
        const insert = '\n' + leaving.join('\n')
        const changes = [
            { from, to, insert: '' },
            { from: branchEndTo, insert },
        ]
        const anchor = branchEndTo - (to - from) + 1 // start of the first leaving line
        dispatch(view, { changes, selection: { anchor }, userEvent: 'input' })
        return true
    }
    const { lines, index, line, head } = ctx(view)
    if (!isBulletLine(line)) return false
    const { end } = branchRange(lines, treeRootIndex(lines, index))
    const curLineTo = view.state.doc.line(index + 1).to
    const branchEndTo = view.state.doc.line(end + 1).to
    const tail = view.state.sliceDoc(head, curLineTo) // text right of the caret on this line
    const changes = [
        { from: head, to: curLineTo, insert: '' }, // lift the tail off the current line
        { from: branchEndTo, insert: '\n' + tail }, // …and re-lay it on a fresh col-0 line after the branch
    ]
    const anchor = branchEndTo - tail.length + 1 // start of the tail on the new line
    dispatch(view, { changes, selection: { anchor }, userEvent: 'input' })
    return true
}

// ── Fenced code blocks (ADR 0018 / 0020) ──────────────────────────────────────────────────

// No default info-string unless the graph configures one — a bare fence (no tag) is the default.
const defaultCodeLang = (): string => getActiveGraphSettings().defaultCodeLanguage ?? ''

/**
 * On Enter, complete an unterminated fence opener: append the default info-string (if bare), an
 * empty middle line, and a balanced closer — all clamped to the fence column (the backtick column,
 * which equals the content column for `- ``` ` inside a bullet).
 *
 * The open/closed decision is a pure line-scan ({@link unterminatedFenceOpenerAt}), NOT the global
 * Lezer tree — and it uses the same column-scoped, pending-aware pairing as the visual layer, so
 * fences belonging to *other* blocks (stray bullets, unterminated prose fences anywhere above) never
 * make a fresh opener look paired, while Enter on a fence of an already complete block — its opener,
 * empty or holding content, its closer, or a shorter content fence — never generates another pair.
 */
const completeFence: StateCommand = (view) => {
    const { state } = view
    const sel = state.selection.main
    if (!sel.empty) return false
    const lineObj = state.doc.lineAt(sel.head)
    if (sel.head !== lineObj.to) return false // only at the end of the line
    const opener = fenceLineInfo(lineObj.text)
    if (!opener) return false // not a fence line (also skips task bullets, which the regex rejects)
    // The balance check: a fence a complete block already accounts for — its opener, empty or holding
    // content, its closer, or a shorter fence that is content — never grows a second closer. Enter
    // there is enterInCode's: the first content line, or the new block below the closer.
    if (!unterminatedFenceOpenerAt(state, sel.head)) return false

    const { insert, caretOffset } = buildFenceCompletion({
        indent: ' '.repeat(opener.col),
        ticks: opener.run,
        info: opener.info,
        defaultLang: defaultCodeLang(),
    })
    dispatch(view, {
        changes: { from: sel.head, insert },
        selection: { anchor: sel.head + caretOffset },
        userEvent: 'input.complete',
    })
    return true
}

/** The lead for a fresh line opened AFTER a block's closing fence: a sibling bullet marker when the
 *  block lives in a bullet (the opener itself for form-1, else the owning bullet above the opener),
 *  otherwise `''` — a column-0 prose line.
 *
 *  The owner is the nearest bullet above whose CONTENT column is the fence column or left of it — a
 *  fence is that bullet's content only when it sits at the bullet's clamp. A deeper bullet above is
 *  skipped, never adopted: it is a descendant of something, not the block this fence belongs to. That
 *  matters most for a column-0 prose fence, which no bullet can own (a bullet's content column is at
 *  least the marker width) — reading the nearest bullet as its owner turned Enter after a prose
 *  block's closer into a bullet, or a task checkbox, copied from whatever bullet stood anywhere above
 *  (found live, 2026-09-12). A non-bullet line left of the fence column still ends the search. */
function leadAfterBlock(lines: string[], openerIdx: number, fenceColumn: number): string {
    let ownerIdx = isBulletLine(lines[openerIdx]) ? openerIdx : -1
    if (ownerIdx < 0)
        for (let j = openerIdx - 1; j >= 0; j--) {
            if (lines[j].trim() === '') continue
            if (isBulletLine(lines[j])) {
                if (contentColumn(lines[j]) > fenceColumn) continue
                ownerIdx = j
                break
            }
            if (lineIndent(lines[j]) < fenceColumn) break
        }
    return ownerIdx >= 0 ? lines[ownerIdx].slice(0, lineIndent(lines[ownerIdx])) + newBulletMarker(lines[ownerIdx]) : ''
}

/**
 * Enter inside a code block: a plain newline clamped to the fence column (never a sibling bullet).
 * The one way OUT through Enter is at the END of the closing-fence line (right of the closing
 * ticks), which opens a fresh block below — a sibling bullet when the block lives in a bullet,
 * otherwise a prose line (Shift-Enter there is the multiline continuation instead). From the
 * content, leaving is Mod+Enter ({@link breakoutFromCode}).
 */
const enterInCode: StateCommand = (view) => {
    const { state } = view
    if (caretContext(state) !== 'fenced-code') return false
    const head = state.selection.main.head
    const block = fencedBlockAt(state, head)
    if (!block) return false
    const line = state.doc.lineAt(head)
    const closerLine = state.doc.lineAt(block.to)
    const openerLine = state.doc.lineAt(block.from)
    // A fence line is structure: Enter anywhere on it acts as Enter at its end, so a caret inside
    // the backtick run can never split the fence (found by the outliner invariant property test).
    if (line.number === openerLine.number && head < line.to) {
        const insert = '\n' + ' '.repeat(block.fenceColumn)
        dispatch(view, { changes: { from: line.to, insert }, selection: { anchor: line.to + insert.length }, userEvent: 'input' })
        return true
    }
    if (line.number === closerLine.number) {
        // Caret right of the closing ticks → a new block below the fence.
        const lines = state.doc.toString().split('\n')
        const lead = leadAfterBlock(lines, openerLine.number - 1, block.fenceColumn)
        const insert = '\n' + lead
        dispatch(view, {
            changes: { from: closerLine.to, insert },
            selection: { anchor: closerLine.to + insert.length },
            userEvent: 'input',
        })
        return true
    }
    // Inside the content Enter is always a newline clamped to the fence column. Leaving the block is
    // Mod+Enter's job (below); an empty last row is not an exit, which is how Obsidian behaves too.
    const insert = '\n' + ' '.repeat(block.fenceColumn)
    dispatch(view, { changes: { from: head, insert }, selection: { anchor: head + insert.length }, userEvent: 'input' })
    return true
}

/** Shift-Enter inside a code block: the multiline continuation — a newline clamped to the fence
 *  column. On the closing-fence line this opens a soft line AFTER the block (still the same bullet),
 *  the deliberate alternative to Enter's new-block-below. */
const shiftEnterInCode: StateCommand = (view) => {
    const { state } = view
    if (caretContext(state) !== 'fenced-code') return false
    const head = state.selection.main.head
    const block = fencedBlockAt(state, head)
    if (!block) return false
    // On a fence line the newline goes after the fence, never inside its backticks.
    const at = onFenceLine(view, block, head) ? state.doc.lineAt(head).to : head
    const insert = '\n' + ' '.repeat(block.fenceColumn)
    dispatch(view, { changes: { from: at, insert }, selection: { anchor: at + insert.length }, userEvent: 'input' })
    return true
}

/** The 1-based line numbers of a block's opening and closing fences. */
function fenceLines(view: Target, block: FencedBlock): { opener: number; closer: number } {
    return { opener: view.state.doc.lineAt(block.from).number, closer: view.state.doc.lineAt(block.to).number }
}

/** Whether `pos` sits on a block's opening or closing fence line (as opposed to its content). */
function onFenceLine(view: Target, block: FencedBlock, pos: number): boolean {
    const n = view.state.doc.lineAt(pos).number
    const { opener, closer } = fenceLines(view, block)
    return n === opener || n === closer
}

/**
 * The 1-based lines the main selection covers. A caret covers its line; a range that ends at a
 * line's start has not reached that line (CodeMirror's `changeBySelectedLine` convention, and
 * the shape Shift+Down leaves: the head at column 0 of the line below the last one selected).
 */
function selectedLines(view: Target): { first: number; last: number } {
    const { state } = view
    const sel = state.selection.main
    const first = state.doc.lineAt(sel.from).number
    const toLine = state.doc.lineAt(sel.to)
    const last = !sel.empty && sel.to === toLine.from && toLine.number > first ? toLine.number - 1 : toLine.number
    return { first, last }
}

/**
 * Shift the whole fenced block (opener, content, closer) by `delta` columns, never below `floor`. A
 * fence pairs only with a closer at its own column, so indenting one fence line on its own dissolves
 * the block (found by the outliner invariant property test): on a fence line, Tab and Shift-Tab move
 * the block as a unit instead. The caret keeps its place on its line.
 */
function shiftFencedBlock(view: Target, block: FencedBlock, delta: number, floor: number): void {
    const { state } = view
    const first = state.doc.lineAt(block.from).number
    const last = state.doc.lineAt(block.to).number
    const changes: ChangeSpec[] = []
    for (let n = first; n <= last; n++) {
        const line = state.doc.line(n)
        if (delta > 0) {
            changes.push({ from: line.from, insert: ' '.repeat(delta) })
        } else {
            const removable = Math.max(0, Math.min(-delta, lineIndent(line.text) - floor))
            if (removable > 0) changes.push({ from: line.from, to: line.from + removable })
        }
    }
    if (changes.length === 0) return
    // Map the selection through the change set (assoc 1 keeps an end after spaces inserted at it).
    const set = state.changes(changes)
    const sel = state.selection.main
    dispatch(view, { changes: set, selection: EditorSelection.range(set.mapPos(sel.anchor, 1), set.mapPos(sel.head, 1)) })
}

/** Whether the main selection (a caret included) reaches the block's opening or closing fence line. */
function selectionReachesFence(view: Target, block: FencedBlock): boolean {
    const { first, last } = selectedLines(view)
    const { opener, closer } = fenceLines(view, block)
    return (opener >= first && opener <= last) || (closer >= first && closer <= last)
}

/** Whether the main selection runs outside `block` (into prose above, or another block below). */
function selectionLeavesBlock(view: Target, block: FencedBlock): boolean {
    const sel = view.state.selection.main
    return sel.from < block.from || sel.to > block.to
}

/**
 * Tab / Shift+Tab over code (VS Code): at a caret, Tab inserts the indent where the caret is and
 * Shift+Tab removes one from the line; over a selection, every line it touches indents or outdents
 * and the selection stays on its text. Never replaces the selection, and never left of the fence
 * column.
 */
function indentCodeLines(view: Target, block: FencedBlock, delta: number): void {
    const { state } = view
    const sel = state.selection.main
    if (sel.empty && delta > 0) {
        dispatch(view, state.replaceSelection(INDENT))
        return
    }
    const { first, last } = selectedLines(view)
    const changes: ChangeSpec[] = []
    for (let n = first; n <= last; n++) {
        const line = state.doc.line(n)
        if (delta > 0) {
            changes.push({ from: line.from, insert: ' '.repeat(delta) })
        } else {
            const removable = Math.max(0, Math.min(-delta, lineIndent(line.text) - block.fenceColumn))
            if (removable > 0) changes.push({ from: line.from, to: line.from + removable })
        }
    }
    if (changes.length === 0) return
    const set = state.changes(changes)
    dispatch(view, { changes: set, selection: EditorSelection.range(set.mapPos(sel.anchor, 1), set.mapPos(sel.head, 1)) })
}

/**
 * Tab inside a code block: code indentation ({@link indentCodeLines}). A fence line of a bullet's
 * block, or a selection reaching one, is the bullet's structure (Editor Content Rules → Keys inside
 * a block): a block never indents on its own, so the owning branch nests, fence and all, or nothing
 * moves when it has no previous sibling. A prose block's fence line moves the block as a unit.
 */
const tabInCode: StateCommand = (view) => {
    const { state } = view
    // A block selection is the outliner's, whichever line its head reached: replacing it with
    // code indentation would delete every selected block.
    if (isBlockSelection(state)) return false
    if (caretContext(state) !== 'fenced-code') return false
    const block = fencedBlockAt(state, state.selection.main.head)
    if (!block) return false
    // A range running out of the code: from its own block's bullet or continuation lines it is the
    // outliner's, and the block nests (indentBranch). Out into prose, or from prose into a bullet's
    // code, only this block would move; consumed, so focus never leaves the editor.
    if (selectionLeavesBlock(view, block)) return rangeBlockOwner(state) === null
    if (selectionReachesFence(view, block)) {
        const { lines } = ctx(view)
        const owner = ownerBulletIndex(lines, state.doc.lineAt(block.from).number - 1)
        if (owner === null) {
            shiftFencedBlock(view, block, INDENT_UNIT, 0)
            return true
        }
        if (!canIndent(lines, owner)) return true // consume — never move focus
        dispatch(view, { changes: branchShift(view, lines, owner, indentDelta(lines, owner)) })
        return true
    }
    indentCodeLines(view, block, INDENT_UNIT)
    return true
}

/**
 * Shift-Tab inside a code block: remove code indentation ({@link indentCodeLines}), never left of
 * the fence column. On a fence line of a bullet's block, or a selection reaching one, the owning
 * branch outdents (a top-level owner becomes prose, its fence at column 0), after a block that a
 * paste left deeper than the owner's content column has first come back to it. A prose block's
 * fence line moves the block as a unit, never past column 0.
 */
const shiftTabInCode: StateCommand = (view) => {
    const { state } = view
    if (isBlockSelection(state)) return false // the outliner's selection, as for Tab
    if (caretContext(state) !== 'fenced-code') return false
    const block = fencedBlockAt(state, state.selection.main.head)
    if (!block) return false
    if (selectionLeavesBlock(view, block)) return rangeBlockOwner(state) === null // as for Tab
    if (selectionReachesFence(view, block)) {
        const { lines, index } = ctx(view)
        const openerIdx = state.doc.lineAt(block.from).number - 1
        // A caret on a form-1 opener (`- \`\`\``) is on the bullet line itself, which outdents as a
        // branch (outdentBranch); from the closer the owner path below reaches the same branch.
        if (index === openerIdx && isBulletLine(lines[openerIdx])) return false
        const owner = ownerBulletIndex(lines, openerIdx)
        // The floor is the owner's content column, never a shallower continuation line's indent:
        // a block sits at that column or comes back to it, whatever lies between it and its bullet.
        const floor = owner === null ? 0 : contentColumn(lines[owner])
        if (owner === null || block.fenceColumn > floor) {
            shiftFencedBlock(view, block, -INDENT_UNIT, floor)
            return true
        }
        if (canOutdent(lines, owner)) {
            dispatch(view, { changes: branchShift(view, lines, owner, outdentTarget(lines, owner) - lineIndent(lines[owner])) })
        } else {
            outdentPastRoot(view, lines, owner)
        }
        return true
    }
    indentCodeLines(view, block, -INDENT_UNIT)
    return true
}

/** The indent of the block a merge onto line `j` joins: the owning bullet's when `j` is a
 *  continuation line, else the line's own. Measuring a strand against a continuation's deeper indent
 *  let a merge orphan the removed bullet's child (found by the outliner invariant property test). */
function mergeTargetIndent(lines: string[], j: number): number {
    const owner = isBulletLine(lines[j]) ? j : ownerBulletIndex(lines, j)
    return lineIndent(lines[owner ?? j])
}

/** Merge the line at `head` (its caret position) up into the previous line: delete from the end of
 *  the previous line to `head`, landing the caret at that previous line's end (the text right of the
 *  caret rides up). */
function mergeUp(view: Target, lineNumber: number, head: number): void {
    const prev = view.state.doc.line(lineNumber - 1)
    dispatch(view, { changes: { from: prev.to, to: head }, selection: { anchor: prev.to }, userEvent: 'delete' })
}

/**
 * Merge the bullet at line `index` up into the block above ({@link mergeUp} from its content start),
 * carrying its own continuation lines and fenced block along: they are pulled right to the target's
 * content column when it is deeper than the merged bullet's, so they stay that block's content. On
 * text on the grid the target is never deeper (it is a sibling or the parent's line); on foreign text
 * a bullet can merge onto a deeper sibling (`    - x` above `  - c`), and without the shift the
 * merged block's soft line was left below the new content column and fell to the grandparent
 * (found by the foreign-grid invariant property test, ADR 0067).
 */
function mergeBlockUp(view: Target, lines: string[], index: number, targetContentColumn: number): void {
    const { state } = view
    const line = state.doc.line(index + 1)
    const contentStart = line.from + lineIndent(lines[index]) + markerLength(lines[index])
    const prev = state.doc.line(index)
    const changes: ChangeSpec[] = [{ from: prev.to, to: contentStart }]
    const delta = targetContentColumn - contentColumn(lines[index])
    if (delta > 0) {
        const bodyEnd = blockBodyEnd(lines, index)
        for (let j = index + 1; j <= bodyEnd; j++) changes.push({ from: offsetOfLine(view, j), insert: ' '.repeat(delta) })
    }
    dispatch(view, { changes, selection: { anchor: prev.to }, userEvent: 'delete' })
}

/**
 * A fence line is structure, not content: joining a neighbouring line onto it (or it onto a
 * neighbour) turns a bare closer into an info-string opener, or splices a bullet into the fence, and
 * the block dissolves. So at a fence edge the joining keys are consumed: Backspace at the clamp of an
 * opener or closer line, and Delete at the end of an opener, a closer, or the last content line
 * before the closer. Found by the outliner invariant property test; Logseq likewise never lets a
 * join cross a code block's edge.
 */
function fenceEdges(view: Target): { block: FencedBlock; lineNumber: number; first: number; last: number } | null {
    const { state } = view
    if (!state.selection.main.empty) return null
    const head = state.selection.main.head
    const block = fencedBlockAt(state, head)
    if (!block) return null
    return {
        block,
        lineNumber: state.doc.lineAt(head).number,
        first: state.doc.lineAt(block.from).number,
        last: state.doc.lineAt(block.to).number,
    }
}

const backspaceAtFenceEdge: StateCommand = (view) => {
    const { state } = view
    if (!state.selection.main.empty) return false
    const head = state.selection.main.head
    const line = state.doc.lineAt(head)
    // Only a caret in the structural margin (at or left of the first content character) is a join.
    const margin = lineIndent(line.text) + (isBulletLine(line.text) ? markerLength(line.text) : 0)
    if (head - line.from > margin) return false
    const edges = fenceEdges(view)
    if (edges && (edges.lineNumber === edges.first || edges.lineNumber === edges.last)) return true
    // The line after a closer: joining its CONTENT onto the closer would turn the closer into an
    // opener. A line with nothing after its margin (an empty bullet, a blank soft line) has nothing
    // to join, so its own rule applies: the empty bullet deletes as a block, caret at the closer's end.
    if (line.text.slice(margin).trim() === '') return false
    if (line.number > 1) {
        const previous = state.doc.line(line.number - 1)
        const block = fencedBlockAt(state, previous.from)
        if (block && state.doc.lineAt(block.to).number === previous.number) return true
    }
    return false
}

const deleteAtFenceEdge: StateCommand = (view) => {
    const { state } = view
    if (!state.selection.main.empty) return false
    const head = state.selection.main.head
    const line = state.doc.lineAt(head)
    if (head !== line.to) return false
    const edges = fenceEdges(view)
    if (edges) {
        const { lineNumber, first, last } = edges
        if (lineNumber === first || lineNumber === last || lineNumber === last - 1) return true
    }
    // The line before an opener: joining the opener onto it would move the fence off its column.
    if (line.number < state.doc.lines) {
        const next = state.doc.line(line.number + 1)
        const block = fencedBlockAt(state, next.from)
        if (block && state.doc.lineAt(block.from).number === next.number) return true
    }
    return false
}

/**
 * Backspace inside a code block. At/left of the fence column (cursor in the leading whitespace) it
 * MERGES the line up — the text right of the caret rides up to the end of the line above — rather than
 * deleting the indent (which would pull content left of the fence). Within extra code indentation it
 * falls through to the default (delete one space, still ≥ the fence column). It never merges non-empty
 * content into the opening fence line (that would corrupt the fence).
 */
const backspaceInCode: StateCommand = (view) => {
    const { state } = view
    if (caretContext(state) !== 'fenced-code') return false
    const sel = state.selection.main
    if (!sel.empty) return false // let the default delete the selection
    const block = fencedBlockAt(state, sel.head)
    if (!block) return false
    const line = state.doc.lineAt(sel.head)
    const caretColumn = sel.head - line.from
    if (line.text.slice(0, caretColumn).trim() !== '') return false // text to the left → normal delete
    if (caretColumn > block.fenceColumn) return false // extra code indent → default deletes one space
    if (line.number <= 1) return true // nothing above to merge into
    const openerLineNumber = state.doc.lineAt(block.from).number
    const previousIsOpener = line.number - 1 === openerLineNumber
    if (previousIsOpener && line.text.trim() !== '') return true // don't append content onto the fence
    // Merge from the content boundary (first non-whitespace), not the raw caret — so a caret parked in
    // the leading indent of an empty/under-typed row can't leave that whitespace dangling on the line
    // above (it would surface as a stray trailing space).
    mergeUp(view, line.number, line.from + lineIndent(line.text))
    return true
}

/**
 * Backspace at the content-column boundary of an outliner continuation line (a non-bullet line under
 * a bullet — e.g. a Shift+Enter soft line). Mirrors the code-block rule: the caret can never delete
 * left of the content-column clamp. Within the content it deletes normally; in any extra indent it
 * deletes one space down to the clamp; at (or anywhere left of) the clamp it MERGES the line's content
 * up to the end of the line above — dropping the structural indent so nothing strays into the margin.
 */
const backspaceInContinuation: StateCommand = (view) => {
    const { state } = view
    const sel = state.selection.main
    if (!sel.empty) return false
    const cont = continuationAt(view)
    if (!cont) return false // a bullet's own line, code, or standalone prose → default (or backspaceInCode)
    const { index, line, lineFrom, head, floor } = cont
    const indentLen = line.length - line.trimStart().length // first non-whitespace column
    const caretColumn = head - lineFrom
    if (caretColumn > indentLen) return false // caret is within the content → normal delete
    if (caretColumn > floor) return false // extra indent above the clamp → default deletes one space
    if (index < 1) return false
    // Merge from the content boundary (not the raw caret): joins the content to the end of the line
    // above and removes the whole indent, so a caret parked left of the clamp can't leave stray spaces.
    mergeUp(view, index + 1, lineFrom + indentLen)
    return true
}

/**
 * Backspace on an **empty bullet** (no content after the `- ` / `- [ ] ` marker, caret at its end):
 * delete the whole bullet as a block rather than nibbling the marker character-by-character, and land
 * the caret at the end of the previous line's content (its sibling or parent block above) — the
 * standard outliner merge-up. Any descendant lines below are left in place (they re-flow under the
 * block above). A non-empty bullet, or a caret not at the marker end, falls through to the default.
 *
 * With **nothing mergeable above** — the top of the document, or a group boundary (a blank line, a
 * heading, prose, a fence) on the line above — there is no block for the children to re-flow under.
 * An empty bullet **with a subtree** is then removed and its subtree healed up a level, exactly as
 * deleting the line as a selection would ({@link healAfterRangeDelete}); one with no subtree drops
 * its marker at the top of the document, and elsewhere joins the boundary line as before. Dropping
 * the marker, or merging the line away onto a blank, used to leave the children under a line that
 * is no parent, an orphan (indented, then the parent backspaced away — seen on a phone, 2026-09-13
 * at the top of the document and 2026-09-14 under a blank line).
 *
 * The first body line under the [[Frontmatter]] is the top of the document here. The block above
 * it is opaque, so it is never a merge target, and its closer may not be joined onto at all
 * (`frontmatter-boundary.ts`) - so the join the boundary case falls back to was refused, and the
 * last bullet under a block could not be deleted (2026-09-15). Dropping the marker leaves the
 * caret on its own line below the closer, which the YAML never notices.
 */
const backspaceEmptyBullet: StateCommand = (view) => {
    const { lines, index, line, lineFrom, head } = ctx(view)
    if (!view.state.selection.main.empty) return false
    if (!isBulletLine(line) || bulletContent(line) !== '') return false // only a truly empty bullet
    if (head !== lineFrom + line.length) return false // caret must be at the marker's end
    const top = index < 1 || index === frontmatterLines(lines)
    if (top || !mergeTargetAbove(lines, index)) {
        const { end } = branchRange(lines, index)
        if (lines.slice(index + 1, end + 1).some((l) => l.trim() !== '')) {
            // A subtree with no block above to re-flow under: the line goes and the subtree is pulled
            // up to the top level, the caret at its first line's content start (the same landing as
            // deleting the group's first block line). Healed from this line down: the line above is a
            // boundary or prose, never a parent.
            const rest = healAfterRangeDelete(lines.slice(index + 1), 0).lines
            // The heal moves a form-2 fence with its owner; with the owner gone and nothing above, the
            // fence would keep the owner's column. It is top-level code now: to column 0, fences paired.
            const fence = fencedBlocks(rest).find((b) => b.start === 0)
            if (fence && !isBulletLine(rest[0]) && lineIndent(rest[0]) > 0) {
                rest.splice(0, fence.end + 1, ...shiftLines(rest.slice(0, fence.end + 1), -lineIndent(rest[0])))
            }
            const healed = [...lines.slice(0, index), ...rest]
            const first = rest[0]
            const anchor = lineFrom + lineIndent(first) + (isBulletLine(first) ? markerLength(first) : 0)
            const change = minimalReplacement(view.state.doc.toString(), healed.join('\n'))
            dispatch(view, { changes: change ?? [], selection: { anchor }, userEvent: 'delete' })
            return true
        }
        if (top) {
            // Nothing above to merge into: drop the marker so the line becomes empty prose. Letting the
            // default nibble one character would leave `-` or `- [x]`, a line that is no longer a bullet
            // but still looks like one (found by the outliner invariant property test).
            dispatch(view, { changes: { from: lineFrom, to: lineFrom + line.length, insert: '' }, selection: { anchor: lineFrom }, userEvent: 'delete' })
            return true
        }
    }
    if (mergeWouldStrand(lines, index, mergeTargetIndent(lines, index - 1))) return true // refuse: would orphan a child
    mergeUp(view, index + 1, head)
    return true
}

/**
 * Backspace at the content-column start of a **non-empty** bullet (ADR 0021, Logseq-style merge): join
 * the bullet's content onto the block on the line directly above — dropping this bullet's marker — as
 * long as that line is a mergeable member of the same [[Outliner Block Group]]. Descendant lines keep
 * their indentation and re-derive their parent. At the group's top boundary the key is consumed (the
 * merge never crosses a heading / prose / blank), rather than nibbling the marker.
 */
const backspaceMergeBullet: StateCommand = (view) => {
    const { state } = view
    if (!state.selection.main.empty) return false
    if (caretContext(state) === 'fenced-code') return false
    const { lines, index, line, lineFrom, head } = ctx(view)
    if (!isBulletLine(line) || bulletContent(line) === '') return false // empty bullet → backspaceEmptyBullet
    const contentStart = lineFrom + lineIndent(line) + markerLength(line)
    if (head !== contentStart) return false // caret must be exactly at the content start
    if (!mergeTargetAbove(lines, index)) return true // group boundary — consume, no cross-boundary merge
    const targetIndent = mergeTargetIndent(lines, index - 1)
    if (mergeWouldStrand(lines, index, targetIndent)) return true // refuse: would orphan a child
    mergeBlockUp(view, lines, index, targetIndent + MARKER_WIDTH)
    return true
}

/**
 * Delete at the end of a block's line (ADR 0021): pull the next block's content up onto this line —
 * the forward twin of {@link backspaceMergeBullet} — when the next line is a mergeable member of the same
 * [[Outliner Block Group]]. Its descendants re-flow under this block. Consumed at the group's bottom edge.
 * The line may be the bullet's own line or one of its continuations: a soft line is still part of the
 * block, and letting the default join splice the next bullet's indent and marker into it produced an
 * orphan (found by the outliner invariant property test).
 */
const deleteMergeNext: StateCommand = (view) => {
    const { state } = view
    if (!state.selection.main.empty) return false
    if (caretContext(state) === 'fenced-code') return false
    const { lines, index, line, lineFrom, head } = ctx(view)
    const owner = isBulletLine(line) ? index : ownerBulletIndex(lines, index)
    if (owner === null) return false // prose, not part of a block
    if (head !== lineFrom + line.length) return false // caret must be at the end of the line
    const nextIdx = index + 1
    if (!mergeTargetAbove(lines, nextIdx) || !isMergeableSource(lines, nextIdx)) return true // boundary → consume
    if (fencedBlockAt(state, state.doc.line(nextIdx + 1).from)) return true // a fence opener is structure, never content
    // The merged content joins the OWNER block, so its children are measured against the owner's indent.
    if (mergeWouldStrand(lines, nextIdx, lineIndent(lines[owner]))) return true // refuse: would orphan a child
    if (isBulletLine(lines[nextIdx])) {
        mergeBlockUp(view, lines, nextIdx, contentColumn(lines[owner]))
        return true
    }
    const nextLine = state.doc.line(nextIdx + 1)
    mergeUp(view, nextIdx + 1, nextLine.from + lineIndent(nextLine.text))
    return true
}

/**
 * Backspace/Delete over a MULTI-LINE selection (ADR 0021): after the raw deletion, heal the outliner
 * structure so the delete can't leave orphaned blocks or a blank-line artifact — remove a whitespace-only
 * line formed at the join, and re-indent any block that jumped more than one level below its new parent.
 * Single-line selections (and carets) fall through to the defaults / the caret-specific commands.
 */
const rangeDeleteHeal: StateCommand = (view) => {
    const { state } = view
    if (state.selection.ranges.length !== 1) return false // leave multi-cursor to the default
    const sel = state.selection.main
    if (sel.empty) return false
    if (state.doc.lineAt(sel.from).number === state.doc.lineAt(sel.to).number) return false // within one line → ordinary delete

    const text = state.doc.toString()
    const from = sel.from
    let lines = (text.slice(0, from) + text.slice(sel.to)).split('\n')
    // Line index + column of the caret (the deletion point) in the post-delete text.
    let acc = 0
    let caretLine = 0
    for (let i = 0; i < lines.length; i++) {
        if (acc + lines[i].length >= from) {
            caretLine = i
            break
        }
        acc += lines[i].length + 1
    }
    // Drop the blank artifact at the join and heal orphans across the caret's group (shared with cut).
    ;({ lines, caretLine } = healAfterRangeDelete(lines, caretLine))

    // Caret lands at the end of the deleted block's previous sibling (same indent) or parent (shallower)
    // — skipping the sibling's own descendants — or at the group start if the first block line was deleted.
    // Resolved in the ORIGINAL doc: the target survives the delete (it sits above `from`), so its offset is
    // unchanged in the result — which is robust whether the deletion was in the middle or at the very end.
    const origLines = text.split('\n')
    const origInFence = opaqueLineFlags(origLines, fencedBlocks(origLines))
    const fromIdx = state.doc.lineAt(from).number - 1
    const R = lineIndent(origLines[fromIdx])
    let target = -1
    for (let j = fromIdx - 1; j >= 0; j--) {
        if (origInFence[j]) continue // fenced content is opaque
        if (origLines[j].trim() === '' || isHeadingLine(origLines[j])) break // group boundary → before the group
        const ind = lineIndent(origLines[j])
        if (ind > R) continue // a descendant/continuation of an earlier block — skip past it
        if (isBulletLine(origLines[j])) target = j // a sibling (== indent) or parent (< indent) bullet
        break
    }
    const finalText = lines.join('\n')
    let caret: number
    if (target >= 0) {
        let off = 0
        for (let i = 0; i < target; i++) off += origLines[i].length + 1
        caret = off + origLines[target].length // end of the surviving previous sibling / parent
    } else {
        // The first block line was deleted: the caret lands at the content start of the block now
        // heading the group (never in its marker margin, which the caret clamp forbids).
        caret = Math.min(from, finalText.length)
        const headLine = lines[caretLine] ?? ''
        if (isBulletLine(headLine) && caret === finalText.length - lines.slice(caretLine).join('\n').length)
            caret += lineIndent(headLine) + markerLength(headLine)
    }
    // Dispatch a minimal change (shared prefix/suffix trimmed) so scroll/other state isn't disturbed.
    let p = 0
    while (p < text.length && p < finalText.length && text[p] === finalText[p]) p++
    let suf = 0
    while (suf < text.length - p && suf < finalText.length - p && text[text.length - 1 - suf] === finalText[finalText.length - 1 - suf]) suf++
    dispatch(view, {
        changes: { from: p, to: text.length - suf, insert: finalText.slice(p, finalText.length - suf) },
        selection: { anchor: caret },
        userEvent: 'delete',
    })
    return true
}

/**
 * Mod-Enter inside a code block: leave it. In a bullet's block a sibling bullet opens after the
 * closing fence (the same lead Enter-at-the-closer uses). In a prose block the caret moves to the
 * start of the line directly below the closer when that line is empty, otherwise a fresh empty line
 * is inserted there (content directly after the closer, or the end of the document).
 */
const breakoutFromCode: StateCommand = (view) => {
    const { state } = view
    if (caretContext(state) !== 'fenced-code') return false
    const block = fencedBlockAt(state, state.selection.main.head)
    if (!block) return false
    const closerLine = state.doc.lineAt(block.to)
    const { lines } = ctx(view)
    const lead = leadAfterBlock(lines, state.doc.lineAt(block.from).number - 1, block.fenceColumn)
    if (lead !== '') {
        const insert = '\n' + lead
        dispatch(view, { changes: { from: closerLine.to, insert }, selection: { anchor: closerLine.to + insert.length }, userEvent: 'input' })
        return true
    }
    const below = closerLine.number < state.doc.lines ? state.doc.line(closerLine.number + 1) : null
    if (below && below.text.trim() === '') {
        dispatch(view, { selection: { anchor: below.from }, userEvent: 'select' })
        return true
    }
    dispatch(view, { changes: { from: closerLine.to, insert: '\n' }, selection: { anchor: closerLine.to + 1 }, userEvent: 'input' })
    return true
}


/** The indent a non-bullet line takes when it becomes a task: one level under the bullet above it in
 *  its group when it sits at or beyond that bullet's content column, else its own indentation. */
function taskIndentFor(lines: string[], index: number): number {
    const raw = lineIndent(lines[index])
    const inFence = opaqueLineFlags(lines, fencedBlocks(lines))
    for (let j = index - 1; j >= 0; j--) {
        const above = lines[j]
        if (inFence[j]) continue // fenced content is opaque
        if (above.length === 0 || isHeadingLine(above)) break // a bare blank or heading bounds the group
        if (!isBulletLine(above)) continue
        const bulletIndent = lineIndent(above)
        return raw >= bulletIndent + MARKER_WIDTH ? bulletIndent + INDENT_UNIT : raw
    }
    return raw
}

export const toggleTask: StateCommand = (view) => {
    const { line, lineFrom, head } = ctx(view)
    if (!isBulletLine(line)) {
        // Prose becomes a task (keeping its indentation and text); a heading, a code line or
        // frontmatter is refused — see task-toggleable.ts, which the Command Bar shares so
        // its button is disabled exactly where this returns false.
        if (!taskToggleable(view.state)) return false
        const { lines, index } = ctx(view)
        // A line under a bullet (a soft line, or any line indented to the bullet's content column or
        // beyond) becomes that bullet's child task, whatever extra indent it carried: a Tab on a soft
        // line adds code-style indentation, which is not a nesting level. Keeping the raw indent would
        // nest the new task deeper than one level, an orphan the invariant property test caught. Plain
        // prose with no bullet above it keeps its own indentation.
        const indent = ' '.repeat(taskIndentFor(lines, index))
        const text = line.trimStart()
        const next = `${indent}- [ ] ${text}`
        // A prose line bounds an outliner group, so the bullets after it may start indented (the
        // "allowable orphan" a Ctrl+Enter split leaves). Turning the line into a task joins the two
        // groups, and the lines below must then be healed into one tree, as a range delete heals.
        const merged = lines.slice()
        merged[index] = next
        let groupEnd = index
        const mergedInFence = opaqueLineFlags(merged, fencedBlocks(merged))
        while (groupEnd < merged.length - 1 && (mergedInFence[groupEnd + 1] || (merged[groupEnd + 1].trim() !== '' && !isHeadingLine(merged[groupEnd + 1])))) groupEnd++
        const healed = healOrphanIndent(merged, index, groupEnd)
        const changes: ChangeSpec[] = [{ from: lineFrom, to: lineFrom + line.length, insert: next }]
        for (let j = index + 1; j <= groupEnd; j++) {
            if (healed[j] === lines[j]) continue
            const ln = view.state.doc.line(j + 1)
            changes.push({ from: ln.from, to: ln.to, insert: healed[j] })
        }
        // Keep the caret on the same character of the text (or at the marker end when it sat in the indent).
        const textCaret = Math.max(0, head - lineFrom - (line.length - text.length))
        dispatch(view, { changes, selection: { anchor: lineFrom + indent.length + 6 + textCaret } })
        return true
    }
    const next = cycleTask(line)
    const delta = next.length - line.length
    dispatch(view, {
        changes: { from: lineFrom, to: lineFrom + line.length, insert: next },
        selection: { anchor: Math.max(lineFrom, head + delta) },
    })
    return true
}

/**
 * Workflowy-style visual-traversal move (ADR 0021), confined to the caret's [[Outliner Block Group]].
 * The structural decision (dive / swap / promote / consume) is the pure {@link computeMove}; this adapter
 * just resolves the branch root (the owning bullet, even when the caret sits on a continuation line) and
 * applies the resulting single-span edit.
 */
function moveBranch(view: Target, dir: 'up' | 'down'): boolean {
    const { lines, index, head, lineFrom } = ctx(view)
    // [[Frontmatter]] does not move. The key is still consumed, or CodeMirror's own moveLine
    // would do it instead - and carrying `title:` past the closing delimiter turns it into body
    // text, silently changing the [[Concept]] the document answers to.
    if (caretContext(view.state) === 'frontmatter') return true
    if (caretContext(view.state) === 'fenced-code') {
        // Inside code the default moveLine reorders code lines, but never across a fence: the default
        // would carry the opener, the closer, or the first/last content line over a fence line and
        // dissolve the block (found by the outliner invariant property test). A fence line itself moves
        // with its owning bullet's branch below; a prose fence's edges consume the key.
        const block = fencedBlockAt(view.state, head)
        if (!block) return false
        const first = view.state.doc.lineAt(block.from).number - 1
        const last = view.state.doc.lineAt(block.to).number - 1
        const onFence = index === first || index === last
        if (!onFence) {
            if (dir === 'up' && index - 1 === first) return true
            if (dir === 'down' && index + 1 === last) return true
            return false
        }
        if (ownerBulletIndex(lines, index) === null) return true
    }
    const root = ownerBulletIndex(lines, index)
    if (root === null) {
        // Prose: the default moveLine applies, unless it would carry this line across a fence line and
        // dissolve the block (a prose line right after a closer moved up into it, or before an opener
        // moved down). Same rule as inside code.
        const neighbour = dir === 'up' ? index - 1 : index + 1
        if (neighbour >= 0 && neighbour < lines.length) {
            if (fencedBlockAt(view.state, offsetOfLine(view, neighbour))) return true
            // Nor into an outliner group: swapping a prose line with a bullet or continuation line would
            // drop the prose inside the tree and leave the block below it without its parent.
            if (isBulletLine(lines[neighbour]) || continuationFloor(lines, neighbour) > 0) return true
        }
        return false
    }
    const edit = computeMove(lines, root, index, head - lineFrom, dir)
    if (!edit) return true // group boundary — consume, don't move the caret
    const from = offsetOfLine(view, edit.fromLine)
    const to = view.state.doc.line(edit.toLine + 1).to
    dispatch(view, { changes: { from, to, insert: edit.text }, selection: { anchor: from + edit.caretOffset }, userEvent: 'move' })
    return true
}

/** Move the caret's branch up one visual row within its group (Command-shaped for reuse). */
export const moveBranchUp: StateCommand = (view) => moveBranch(view, 'up')
/** Move the caret's branch down one visual row within its group (Command-shaped for reuse). */
export const moveBranchDown: StateCommand = (view) => moveBranch(view, 'down')

const blurEditor: Command = (view) => {
    view.contentDOM.blur()
    return true
}

/** Fold a bullet's descendants (everything more indented than it). */
const outlinerFoldService = foldService.of((state, lineStart) => {
    const lines = state.doc.toString().split('\n')
    const index = state.doc.lineAt(lineStart).number - 1
    if (!isBulletLine(lines[index])) return null
    const { start, end } = branchRange(lines, index)
    if (end <= start) return null
    return { from: state.doc.line(start + 1).to, to: state.doc.line(end + 1).to }
})

/**
 * Home and End inside a fenced block are the LOGICAL line ends (Editor Content Rules → Keys inside
 * a block; VS Code). The defaults move to the visual line boundary, found with `posAtCoords` at
 * the editor's edge, and code never soft-wraps: a long line is clipped and scrolls sideways
 * (ADR 0094), so that boundary is the clip edge, and End walked one screen at a time. End is the
 * end of the line; Home is the first non-space character (the caret clamp keeps it right of the
 * fence column). The Shift forms extend the selection to the same places. Each yields outside a
 * block, so prose and bullets keep the defaults.
 */
function lineBoundaryInCode(end: boolean, extend: boolean): StateCommand {
    return (view) => {
        const { state } = view
        if (caretContext(state) !== 'fenced-code') return false
        const range = state.selection.main
        const line = state.doc.lineAt(range.head)
        const target = end ? line.to : line.from + lineIndent(line.text)
        const selection = extend ? EditorSelection.range(range.anchor, target) : EditorSelection.cursor(target, end ? -1 : 1)
        dispatch(view, { selection, scrollIntoView: true, userEvent: 'select' })
        return true
    }
}
const lineEndInCode = lineBoundaryInCode(true, false)
const lineStartInCode = lineBoundaryInCode(false, false)
const selectLineEndInCode = lineBoundaryInCode(true, true)
const selectLineStartInCode = lineBoundaryInCode(false, true)

/**
 * The outliner key bindings in dispatch order (Dual Mode Editor.md → Keyboard scheme). Exported on
 * their own so the Node-level rule tests can dispatch by key name through the same yield chain the
 * live keymap uses; {@link outlinerKeymap} is the same list wrapped as an extension.
 */
export function outlinerBindings(): readonly KeyBinding[] {
    return [
        // Code-block context first: each consults the syntax tree and yields (returns false)
        // when the caret is not in a fence, so the structural commands below still run.
        { key: 'Tab', run: tabInCode },
        { key: 'Tab', run: indentBranch },
        { key: 'Shift-Tab', run: shiftTabInCode },
        { key: 'Shift-Tab', run: outdentBranch },
        { key: 'Enter', run: completeFence },
        { key: 'Enter', run: enterInCode },
        { key: 'Enter', run: enterBullet },
        { key: 'Enter', run: splitContinuation },
        { key: 'Mod-Enter', run: breakoutFromCode },
        { key: 'Mod-Enter', run: breakoutToProse },
        // Logical line ends inside a block (the defaults find the visual boundary, which under the
        // clip is the visible edge). Mac's Cmd+Arrow pair is the same movement there.
        { key: 'End', run: lineEndInCode },
        { key: 'Shift-End', run: selectLineEndInCode },
        { key: 'Home', run: lineStartInCode },
        { key: 'Shift-Home', run: selectLineStartInCode },
        { mac: 'Cmd-ArrowRight', run: lineEndInCode },
        { mac: 'Shift-Cmd-ArrowRight', run: selectLineEndInCode },
        { mac: 'Cmd-ArrowLeft', run: lineStartInCode },
        { mac: 'Shift-Cmd-ArrowLeft', run: selectLineStartInCode },
        // Multi-line selection delete heals orphans/whitespace first; it yields (false) for carets and
        // single-line selections, so the caret-specific commands and the defaults still run.
        { key: 'Backspace', run: rangeDeleteHeal },
        { key: 'Delete', run: rangeDeleteHeal },
        // A join across a fence edge is consumed before any merge can dissolve the block.
        { key: 'Backspace', run: backspaceAtFenceEdge },
        { key: 'Delete', run: deleteAtFenceEdge },
        { key: 'Backspace', run: backspaceInCode },
        { key: 'Backspace', run: backspaceInContinuation },
        { key: 'Backspace', run: backspaceEmptyBullet },
        { key: 'Backspace', run: backspaceMergeBullet },
        { key: 'Delete', run: deleteMergeNext },
        { key: 'Shift-Enter', run: shiftEnterInCode },
        { key: 'Shift-Enter', run: softNewline },
        { key: 'Mod-Shift-Enter', run: toggleTask },
        // Primary chord is Alt-Arrow (shadows CodeMirror's structure-blind moveLineUp/Down, which
        // would otherwise orphan a bullet by swapping raw lines); Alt-Shift-Arrow kept as an alias.
        { key: 'Alt-ArrowUp', run: moveBranchUp },
        { key: 'Alt-ArrowDown', run: moveBranchDown },
        { key: 'Alt-Shift-ArrowUp', run: moveBranchUp },
        { key: 'Alt-Shift-ArrowDown', run: moveBranchDown },
        { key: 'Mod-.', run: toggleFold },
        // Format Toggles (wrap-selection.ts, ADR 0077). `preventDefault` so a refused toggle (in a
        // fence, say) still does not reach the browser, where Mod-b opens Firefox's bookmarks.
        { key: 'Mod-b', run: toggleBold, preventDefault: true },
        { key: 'Mod-i', run: toggleItalic, preventDefault: true },
        { key: 'Mod-Shift-h', run: toggleHighlight, preventDefault: true },
        { key: 'Escape', run: blurEditor },
    ]
}

/** The full outliner keyboard extension (Dual Mode Editor.md → Keyboard scheme). */
export function outlinerKeymap(): Extension {
    return [codeFolding(), outlinerFoldService, keymap.of([...outlinerBindings()])]
}
