/**
 * Inline panels (ADR 0147): a block the editor draws beneath one line of a document that is not part
 * of the document's text. Nothing of it is saved or synced, and no other device sees it. An
 * extension opens one through `context.editor.openPanel`, and an [[Agent Chat]] started with
 * `/Agent` sits in one.
 *
 * - **Where it sits.** A panel is anchored to the start of its line, mapped through every change
 *   (typing here, a synced edit from elsewhere) and kept on that line: text typed at the line's start
 *   or end leaves it there, Enter at the line's start carries it down with the line, and Alt+Up or
 *   Alt+Down carries it with the line moved. A panel opened under the last line (`end`) is always
 *   drawn after the document's end.
 * - **How it is drawn.** A block widget after the line, at the line's text indent, at a fixed height
 *   the panel's content scrolls inside, so its height never changes under the height map (ADR 0022)
 *   while a streamed answer grows. The editor ignores events inside it, as it does an interactive
 *   fence's, so the panel's fields take their own keys, all but Mod+Z and Mod+Y outside a field.
 *   The content is mounted once, into a host that moves into each widget CodeMirror draws for the
 *   panel, so scrolling it out of view and back keeps what was typed in it.
 * - **How long it lasts.** For the visit: until it is closed, or its editor closes for good. When the
 *   editor is rebuilt (a Draft promoted, a document protected), the panel moves to the new editor at
 *   the same line (`editor-succession.ts`), unless the new one shows a Protected Document, where it
 *   closes. A panel is never drawn in a Protected Document, unlocked or not.
 * - **What it may write.** A block at its line, as one undoable change: beneath a bullet with text
 *   as the bullet's first child, after its own lines, and elsewhere by the rule `insertBlock`
 *   follows at the caret (block-insert.ts). The panel then moves beneath the block, and a later
 *   block goes after that one (`planPanelInsert`), read from the text so an undo in either history
 *   leaves nothing nested. A block that would rearrange the outline around it is refused
 *   (`keepsOutline`).
 *
 * The state half is pure over `EditorState` and tested in Node. The widget, its content kept across
 * a scroll, focus given back on close and Mod+Z from inside it are covered by the Client's browser
 * suite (tests-client/inline-panel.test.ts, tests-client/agent-chat.test.ts).
 */
import { type EditorState, type Line, StateEffect, StateField, type Text, type Transaction } from '@codemirror/state'
import { Decoration, EditorView, runScopeHandlers, ViewPlugin, WidgetType } from '@codemirror/view'

import { fencedBlocks, type FencedBlockRange } from '../../fenced-code'
import { blockBodyEnd, branchRange, bulletContent, contentColumn, firstChildSpot, indentBlock, isBulletLine, lineIndent, nextSiblingRange, parentIndex, prevSiblingRange, taskDone, withoutEdgeBlankLines } from '../../outliner'
import { analysisFor } from '../analysis/editor-analysis'
import { bodyWritable } from '../body-writable'
import { blockInsertableAfter, blockInsertableAt, blockTakesLine, changeKeepsOutline, insertContext, planBlockInsert } from '../block-insert'
import { editorDocument } from '../editor-document'
import { liveEditorView } from '../editor-succession'
import { BLOCK_WIDGET_SPACING, BULLET_BLOCK_DROP, blockWidgetIndent, blockWidgetLineStart } from './content-clamp'
import { type CaretBlock, caretKeptOff, historyChord, typingField } from './interactive-fence'
import { isProtectedDocumentFacet } from './protected-document'

/** Where one panel sits: the start of its line, or after the document's end. */
export interface InlinePanelSpot {
    id: number
    /** The line the panel opened at, or once it has put a block in, that block's first line. */
    lineStart: number
    /**
     * Once the panel has put a block in, the line it opened at, as `lineStart` held it before. A
     * block taken out by Mod+Z leaves `lineStart` on the line the block went beneath, which for a
     * bullet with more lines is its last own line, so the panel reads its line from here again.
     */
    anchor?: number
    mode: 'line' | 'end'
    /**
     * The shape of the block the panel last put in: the indentation of its first line, and how many
     * outline branches it was put in as (one for an outline with one root). Absent until a block is
     * put in, and for `end`. See {@link lastBlock}.
     */
    block?: { indent: number; branches: number; kind: BlockStart }
    /** The panel's height in CSS pixels, which its content scrolls inside; {@link DEFAULT_HEIGHT} when absent. */
    height?: number
}

/**
 * What a block's first line is: a bullet, a fence's opener, or another line. A line the panel's spot
 * comes back to after an undo (the bullet's own last line, a fence's closer) is of another kind, so
 * it is never read as the block.
 */
type BlockStart = 'bullet' | 'fence' | 'other'

/** Open a panel at a spot (or move an open one there). */
export const addInlinePanel = StateEffect.define<InlinePanelSpot>()
/** Close a panel by its id. */
export const removeInlinePanel = StateEffect.define<number>()
/** Give an open panel a new height: the lines below it move once. */
export const resizeInlinePanel = StateEffect.define<{ id: number; height: number }>()

/** The height a panel is drawn at when its opener does not say. */
export const DEFAULT_HEIGHT = 440

/** The smallest height a panel is drawn at: room for a line of text and a field. */
const MIN_HEIGHT = 80

/** A height an opener asked for, as a whole number of pixels no smaller than {@link MIN_HEIGHT}. */
function panelHeight(asked: number | undefined): number {
    return asked !== undefined && Number.isFinite(asked) ? Math.max(MIN_HEIGHT, Math.round(asked)) : DEFAULT_HEIGHT
}

/** The panels open in one editor. */
export const inlinePanelsField = StateField.define<readonly InlinePanelSpot[]>({
    create: () => [],
    update(spots, tr) {
        let next = spots
        if (tr.docChanged && next.length > 0) {
            next = next.map((spot) => ({ ...spot, lineStart: mapLineStart(tr, spot.lineStart), ...(spot.anchor === undefined ? {} : { anchor: mapLineStart(tr, spot.anchor) }) }))
        }
        for (const effect of tr.effects) {
            if (effect.is(addInlinePanel)) next = [...next.filter((spot) => spot.id !== effect.value.id), effect.value]
            else if (effect.is(removeInlinePanel)) next = next.filter((spot) => spot.id !== effect.value)
            else if (effect.is(resizeInlinePanel)) next = next.map((spot) => (spot.id === effect.value.id ? { ...spot, height: effect.value.height } : spot))
        }
        return next
    },
})

/**
 * Where the line starting at `lineStart` starts after `tr`.
 *
 * - Text put in at the line's start (typing, Enter) carries the line on past it (assoc 1): typing at
 *   the start stays on the line, and Enter there moves down with it.
 * - Text replaced from the line's start on is the line now (assoc -1). An undo or a redo replaces a
 *   block with the empty bullet it took, or the empty bullet with the block, in one change in
 *   CodeMirror's history and as text put in then text taken out from Yjs, and the line is what starts
 *   there afterwards, not the last line of what was put in.
 * - A block move (Alt+Up or Alt+Down) rewrites the lines it swaps as one change, which would leave
 *   the line on whichever line took its old place, so a line inside the move is found again by its
 *   text. A move from another device arrives as plain changes and is mapped like any other.
 */
function mapLineStart(tr: Transaction, lineStart: number): number {
    if (tr.isUserEvent('move')) {
        const moved = movedLineStart(tr, lineStart)
        if (moved !== null) return moved
    }
    let replacedHere = false
    tr.changes.iterChangedRanges((fromA, toA) => {
        if (fromA === lineStart && toA > fromA) replacedHere = true
    })
    return tr.newDoc.lineAt(tr.changes.mapPos(lineStart, replacedHere ? -1 : 1)).from
}

/**
 * The new start of a whole line a move rewrote: the k-th line with its text among the whole lines
 * the move took out is the k-th line with that text among the lines it put in. Null when the line
 * was not taken out whole, or its text is not among the new lines.
 */
function movedLineStart(tr: Transaction, lineStart: number): number | null {
    const old = tr.startState.doc.lineAt(lineStart)
    let rank = -1
    let seen = 0
    tr.changes.iterChangedRanges((fromA, toA) => {
        forWholeLines(tr.startState.doc, fromA, toA, (line) => {
            if (line.text !== old.text) return
            if (line.from === old.from) rank = seen
            seen++
        })
    })
    if (rank < 0) return null
    let found: number | null = null
    seen = 0
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
        forWholeLines(tr.newDoc, fromB, toB, (line) => {
            if (line.text !== old.text) return
            if (seen === rank) found = line.from
            seen++
        })
    })
    return found
}

/** Each line of `doc` lying wholly inside `from`..`to`. */
function forWholeLines(doc: Text, from: number, to: number, visit: (line: { from: number; to: number; text: string }) => void): void {
    if (to <= from) return
    for (let line = doc.lineAt(from); ; line = doc.line(line.number + 1)) {
        if (line.from >= from && line.to <= to) visit(line)
        if (line.to >= to || line.number === doc.lines) return
    }
}

/**
 * The block the panel last put in, read from the document: its first line and its last. The line
 * at `lineStart` is taken to be the block's first line while it has the block's indentation and is
 * neither blank nor an empty bullet. The block runs over as many outline branches from there as it
 * was put in as, so a line typed inside the block (a note beneath the answer) is the block's, and
 * a line after it at the block's own level is not.
 *
 * Null before a block is put in, and once the line is no longer the block's: an undo took the block
 * out, leaving the empty bullet it took or the line it went beneath. Read from the text rather than
 * kept in the history, because a synced graph undoes in Yjs, whose undo never carries the panel's
 * own changes.
 */
function lastBlock(state: EditorState, spot: InlinePanelSpot): { first: Line; last: Line } | null {
    if (spot.mode === 'end' || !spot.block) return null
    const first = state.doc.lineAt(Math.min(spot.lineStart, state.doc.length))
    if (blockTakesLine(first.text) || lineIndent(first.text) !== spot.block.indent) return null
    const { lines, fencedBlocks: blocks } = analysisFor(state)
    // After Mod+Z the spot is on the line the block went beneath, which can sit at the block's
    // indentation (a bullet's continuation line, a fence's closer): only a line of the block's kind is it.
    if (spot.block.kind === 'bullet' && !isBulletLine(first.text)) return null
    if (spot.block.kind === 'fence' && !blocks.some((block) => block.start === first.number - 1)) return null
    // branchRange reads the lines and never changes them.
    const all = lines as string[]
    const fences = blocks as FencedBlockRange[]
    let end = branchRange(all, first.number - 1, fences).end
    for (let branch = 1; branch < spot.block.branches; branch++) {
        let next = end + 1
        while (next < all.length && all[next].trim() === '') next++
        if (next >= all.length || lineIndent(all[next]) !== spot.block.indent) break
        end = branchRange(all, next, fences).end
    }
    return { first, last: state.doc.line(end + 1) }
}

/** The line a panel opened at, as it is now: where its first block goes while it has saved none. */
function openedLine(state: EditorState, spot: InlinePanelSpot): Line {
    return state.doc.lineAt(Math.min(spot.anchor ?? spot.lineStart, state.doc.length))
}

/** The start of the line a panel is drawn beneath: the last of its bullet's own lines, where its first block goes. */
function drawnLineStart(state: EditorState, spot: InlinePanelSpot): number {
    if (spot.mode === 'end') return state.doc.lineAt(state.doc.length).from
    const saved = lastBlock(state, spot)
    if (saved) return saved.last.from
    return state.doc.line(bodyEnd(state, openedLine(state, spot)) + 1).from
}

/**
 * The last of a bullet's own lines, 0-based (`blockBodyEnd`): its continuation lines and its own
 * code block, before its first child. A panel beneath a bullet with text goes after them, so it
 * never stands between the bullet's lines, and neither does its block. Any other line is its own.
 */
function bodyEnd(state: EditorState, line: Line): number {
    if (!isBulletLine(line.text) || isEmptyBullet(line.text)) return line.number - 1
    const { lines, fencedBlocks: fences } = analysisFor(state)
    // blockBodyEnd reads the lines and never changes them.
    return blockBodyEnd(lines as string[], line.number - 1, fences as FencedBlockRange[])
}

/** How one panel is drawn. */
export interface InlinePanelPlacement {
    id: number
    /** Where its widget goes: the end of the line it sits under or beside, or the document's end. */
    pos: number
    height: number
    /**
     * Beside an empty bullet's dot, in the bullet's own line, as a code block or an image opened on a
     * bullet is drawn: the empty bullet is where its first block goes. Otherwise beneath the line.
     */
    beside: boolean
    /**
     * Where a panel beneath its line starts: from the text of the line it opened under (its first
     * block goes beneath that line, as the line's own), from the start of a block it saved (where its
     * next block goes, beside that one), or at the editor's left edge (null) under the last line.
     */
    column: { line: number; edge: 'text' | 'start' } | null
    /** Under the last line: drawn a line's height clear of the text above, never touching it. */
    spaceAbove: boolean
}

/** Where and how each panel is drawn, in document order. */
export function inlinePanelWidgets(state: EditorState): InlinePanelPlacement[] {
    const spots = state.field(inlinePanelsField, false) ?? []
    return spots
        .map((spot): InlinePanelPlacement => {
            const height = spot.height ?? DEFAULT_HEIGHT
            const pos = state.doc.lineAt(drawnLineStart(state, spot)).to
            if (spot.mode === 'end') return { id: spot.id, pos, height, beside: false, column: null, spaceAbove: true }
            const saved = lastBlock(state, spot)
            if (saved) return { id: spot.id, pos, height, beside: false, column: { line: saved.first.from, edge: 'start' }, spaceAbove: false }
            const line = openedLine(state, spot)
            // Beside an empty bullet's dot, or beneath the bullet's own lines from its text.
            return { id: spot.id, pos, height, beside: isEmptyBullet(line.text), column: { line: line.from, edge: 'text' }, spaceAbove: false }
        })
        .sort((a, b) => a.pos - b.pos || a.id - b.id)
}

/**
 * The outline around a panel, as the document writes it: the panel's line's ancestors, each its own
 * lines without its other children, and the line's siblings with their branches. The line's own
 * branch is in it while the line has text. A block the panel saved is left out, since the chat that
 * saved it holds it. Null when the panel's line is not a bullet, under the last line, or for a
 * panel that is not open. An [[Agent Chat]] sends it under its narrowest Context Grant.
 */
export function panelOutline(state: EditorState, id: number): string | null {
    const spot = (state.field(inlinePanelsField, false) ?? []).find((candidate) => candidate.id === id)
    if (!spot || spot.mode === 'end' || !panelsAllowed(state)) return null
    const saved = lastBlock(state, spot)
    const anchor = saved?.first ?? openedLine(state, spot)
    if (!isBulletLine(anchor.text)) return null
    const { lines: analysed, fencedBlocks: analysedFences } = analysisFor(state)
    // The outliner reads the lines and never changes them.
    const lines = analysed as string[]
    const fences = analysedFences as FencedBlockRange[]
    const at = anchor.number - 1
    const ranges: { start: number; end: number }[] = []
    for (let parent = parentIndex(lines, at, fences); parent !== null; parent = parentIndex(lines, parent, fences)) {
        ranges.unshift({ start: parent, end: blockBodyEnd(lines, parent, fences) })
    }
    const before: { start: number; end: number }[] = []
    for (let sibling = prevSiblingRange(lines, at, fences); sibling; sibling = prevSiblingRange(lines, sibling.start, fences)) before.unshift(sibling)
    ranges.push(...before)
    if (!saved && !isEmptyBullet(anchor.text)) ranges.push(branchRange(lines, at, fences))
    for (let sibling = nextSiblingRange(lines, at, fences); sibling; sibling = nextSiblingRange(lines, sibling.start, fences)) ranges.push(sibling)
    return ranges.flatMap((range) => lines.slice(range.start, range.end + 1)).join('\n')
}

/**
 * The text of the bullet starting at `lineStart`: its content without the bullet marker or a task's
 * box, and its continuation lines without their indentation, joined with line breaks. Null for an
 * empty bullet or a line that is not a bullet.
 */
export function panelLineText(state: EditorState, lineStart: number): string | null {
    const line = state.doc.lineAt(Math.min(lineStart, state.doc.length))
    if (!isBulletLine(line.text) || isEmptyBullet(line.text)) return null
    const end = bodyEnd(state, line)
    // Each continuation line from the bullet's content column: the indentation of its own code stays.
    const column = contentColumn(line.text)
    const rest: string[] = []
    for (let n = line.number + 1; n <= end + 1; n++) {
        const text = state.doc.line(n).text
        rest.push(text.slice(Math.min(lineIndent(text), column)).trimEnd())
    }
    const text = [bulletContent(line.text), ...rest].join('\n').trim()
    return text === '' ? null : text
}

/**
 * The 0-based line the caret goes back to when a panel that had the keyboard closes: the line it was
 * opened on, so typing goes on where `/Agent` was typed, or the last line of the block it saved.
 * Under the last line, the last line. Null when no panel has the id.
 */
export function panelReturnLine(state: EditorState, id: number): number | null {
    const spot = (state.field(inlinePanelsField, false) ?? []).find((candidate) => candidate.id === id)
    if (!spot) return null
    if (spot.mode === 'end') return state.doc.lines - 1
    const saved = lastBlock(state, spot)
    return (saved ? state.doc.lineAt(saved.last.from) : openedLine(state, spot)).number - 1
}

/** The 0-based line a panel sits under, or null when no panel has the id. */
export function inlinePanelLine(state: EditorState, id: number): number | null {
    const spot = (state.field(inlinePanelsField, false) ?? []).find((candidate) => candidate.id === id)
    if (!spot) return null
    return state.doc.lineAt(drawnLineStart(state, spot)).number - 1
}

/** Whether a document's body can hold a panel at all: written to, and never a Protected Document. */
function panelsAllowed(state: EditorState): boolean {
    return !state.readOnly && !state.facet(isProtectedDocumentFacet)() && bodyWritable(state)
}

/**
 * Where a panel opens: at the caret's line, where a block could go at the caret, or under the last
 * line. Null in a Protected Document, a document that cannot be written, or a caret in the
 * frontmatter, a fenced block or a table.
 */
export function panelAnchorFor(state: EditorState, at: 'caret' | 'end'): Omit<InlinePanelSpot, 'id'> | null {
    if (!panelsAllowed(state)) return null
    if (at === 'end') return { lineStart: state.doc.lineAt(state.doc.length).from, mode: 'end' }
    if (!blockInsertableAt(state, state.selection.main.head)) return null
    return { lineStart: state.doc.lineAt(state.selection.main.head).from, mode: 'line' }
}

/**
 * Where a panel opens for `at`: `caret-or-end` is the caret while the editor has the keyboard
 * (`focused`), as a Command Bar button leaves it, and the end otherwise, or when no panel can go at
 * the caret. Pressed from outside the text, a button has no caret to mean.
 */
export function panelAnchorAt(state: EditorState, at: 'caret' | 'end' | 'caret-or-end', focused: boolean): Omit<InlinePanelSpot, 'id'> | null {
    if (at !== 'caret-or-end') return panelAnchorFor(state, at)
    return (focused ? panelAnchorFor(state, 'caret') : null) ?? panelAnchorFor(state, 'end')
}

type PanelChange = { from: number; to: number; insert: string }

/**
 * The change that puts `text` (lines without indentation) at a panel's line, and the effect that
 * moves the panel beneath what was put in. Null for a panel that is not open, a document that
 * cannot be written, or a line that is in the frontmatter, a fenced block or a table, as it can have
 * become since the panel opened.
 *
 * - The first block goes beneath a bullet with text as its first child, after its own lines, at
 *   its children's indentation where it has children (`firstChildSpot`). On an empty bullet an
 *   outline takes the bullet's place at its indentation, so an outline of several roots stays
 *   several roots. At any other line it goes by the rule `insertBlock` follows at the caret
 *   (block-insert.ts).
 * - A later block goes after the one before ({@link lastBlock}), at the indentation of that block's
 *   first line, so saving twice gives two siblings rather than a block inside the one before.
 * - A panel opened under the last line (`end`) puts every block on new top-level lines at the end.
 */
export function planPanelInsert(state: EditorState, id: number, text: string): { changes: PanelChange; effects: StateEffect<unknown>[] } | null {
    const spot = (state.field(inlinePanelsField, false) ?? []).find((candidate) => candidate.id === id)
    if (!spot || !panelsAllowed(state)) return null
    const lines = withoutEdgeBlankLines(text.replace(/\r\n?/g, '\n').split('\n'))
    if (lines.every((line) => line.trim() === '')) return null
    const before = lastBlock(state, spot)
    const change = spot.mode === 'end' ? atEnd(state, lines) : before ? afterBlock(state, before, lines) : atLine(state, openedLine(state, spot).from, lines)
    // Any extension can put a block in: one that would rearrange the outline around it is refused,
    // and the document stays as it was.
    if (!change || !changeKeepsOutline(state, change)) return null
    // A fence that took a line with no neighbours brings an empty line for the caret, not the block's.
    const block = change.insert.endsWith('\n') ? change.insert.slice(0, -1) : change.insert
    const firstLineStart = block.startsWith('\n') ? change.from + 1 : change.from
    const firstLine = (block.startsWith('\n') ? block.slice(1) : block).split('\n')[0]
    const kept = spot.height === undefined ? {} : { height: spot.height }
    const moved: InlinePanelSpot =
        spot.mode === 'end'
            ? { id, lineStart: change.from + block.lastIndexOf('\n') + 1, mode: 'end', ...kept }
            : {
                  id,
                  lineStart: firstLineStart,
                  mode: 'line',
                  // The line it opened at, in the new text: one the block took the place of is the block's first line.
                  anchor: mappedThrough(change, openedLine(state, spot).from),
                  block: { indent: lineIndent(firstLine), branches: outlineBranches(lines), kind: blockStart(lines) },
                  ...kept,
              }
    return { changes: change, effects: [addInlinePanel.of(moved)] }
}

/** Where `pos` is after `change`: a position inside what it replaced is where the new text starts. */
function mappedThrough(change: PanelChange, pos: number): number {
    if (pos < change.from) return pos
    if (pos > change.to) return pos + change.insert.length - (change.to - change.from)
    return change.from
}

/**
 * The first block, at the panel's line. Beneath a bullet with text it goes after the bullet's own
 * lines, as the bullet's first child: at its children's indentation where it has children, which can
 * sit deeper than its content column, else at the content column.
 */
function atLine(state: EditorState, lineStart: number, lines: readonly string[]): PanelChange | null {
    const line = state.doc.lineAt(Math.min(lineStart, state.doc.length))
    if (!blockInsertableAt(state, line.from)) return null
    if (isEmptyBullet(line.text) && isBulletLine(lines[0]) && lineIndent(lines[0]) === 0) {
        return { from: line.from, to: line.to, insert: indented(lines, line.text.slice(0, lineIndent(line.text))) }
    }
    if (isBulletLine(line.text) && !isEmptyBullet(line.text)) {
        const { lines: all, fencedBlocks: fences } = analysisFor(state)
        // The outliner reads the lines and never changes them.
        const child = firstChildSpot(all as string[], line.number - 1, fences as FencedBlockRange[])
        const end = state.doc.line(child.after + 1)
        if (!blockInsertableAfter(state, end.from)) return null
        return { from: end.to, to: end.to, insert: `\n${indented(lines, ' '.repeat(child.indent))}` }
    }
    const plan = planBlockInsert(line, insertContext(state, line.from), lines)
    return { from: plan.from, to: plan.to, insert: plan.insert }
}

/** A later block, after the one before, at the indentation of that block's first line. */
function afterBlock(state: EditorState, before: { first: Line; last: Line }, lines: readonly string[]): PanelChange | null {
    if (!blockInsertableAfter(state, before.last.from)) return null
    return { from: before.last.to, to: before.last.to, insert: `\n${indented(lines, before.first.text.slice(0, lineIndent(before.first.text)))}` }
}

/** Under the last line: an empty bullet or a blank last line takes the block, else new top-level lines. */
function atEnd(state: EditorState, lines: readonly string[]): PanelChange | null {
    const last = state.doc.line(state.doc.lines)
    if (isEmptyBullet(last.text)) return atLine(state, last.from, lines)
    if (last.text.trim() === '') return blockInsertableAt(state, last.from) ? { from: last.from, to: last.to, insert: indented(lines, '') } : null
    return blockInsertableAfter(state, last.from) ? { from: last.to, to: last.to, insert: `\n${indented(lines, '')}` } : null
}

/** What the first of `lines` is, for {@link lastBlock}. */
function blockStart(lines: readonly string[]): BlockStart {
    if (isBulletLine(lines[0])) return 'bullet'
    return fencedBlocks([...lines]).some((block) => block.start === 0) ? 'fence' : 'other'
}

/** How many outline branches `lines` make at their own top level (blank lines between them aside). */
function outlineBranches(lines: readonly string[]): number {
    const all = [...lines]
    const fences = fencedBlocks(all)
    let count = 0
    for (let i = 0; i < all.length; i++) {
        if (all[i].trim() === '') continue
        count++
        i = branchRange(all, i, fences).end
    }
    return Math.max(count, 1)
}

/** `lines` joined, with `indent` before each, a blank line kept in its block (`indentBlock`). */
function indented(lines: readonly string[], indent: string): string {
    return indentBlock(lines, indent).join('\n')
}

/** An empty bullet, which a block takes the place of (block-insert.ts). A task's is not empty. */
function isEmptyBullet(text: string): boolean {
    return isBulletLine(text) && taskDone(text) === undefined && bulletContent(text).trim() === ''
}

// ── The widget, and the panels' lives across editors ────────────────────────────────────────

/** A spot still to be placed in a rebuilt editor, in the coordinates of the editor it came from. */
interface WaitingSpot {
    spot: InlinePanelSpot
    from: EditorView
    /** Whether the editor it came from held text: a rebuilt editor still empty has not been filled yet. */
    hadText: boolean
    /** Set once the wait for the rebuilt editor's text is over. */
    expired: boolean
    timer: ReturnType<typeof setTimeout> | null
}

/** What the host keeps for each open panel. */
interface PanelEntry {
    readonly id: number
    /** The editor the panel is in now; it moves when that editor is rebuilt. */
    view: EditorView
    /**
     * The element the panel's content is drawn into, once. CodeMirror draws only the lines in view,
     * so the widget is taken down when it scrolls out of view and drawn again when it comes back: the
     * host moves into each new widget, and what the person typed in the panel stays.
     */
    readonly host: HTMLElement
    content: { destroy(): void } | null
    mount(host: HTMLElement): { destroy(): void }
    onClose(): void
    closed: boolean
    /** Set while the panel waits to be placed in the editor that replaced its own. */
    waiting: WaitingSpot | null
}

const entries = new Map<number, PanelEntry>()
let nextId = 1

/** The room a panel takes beyond its height, as last measured: its padding, beside a dot its drop, at the end its space above. */
const measuredExtra = { beneath: 0, beside: 0, end: 0 }

/** Which of `measuredExtra` a widget drawn so takes. */
const extraKind = (beside: boolean, spaceAbove: boolean) => (beside ? 'beside' : spaceAbove ? 'end' : 'beneath')

class InlinePanelWidget extends WidgetType {
    constructor(
        readonly id: number,
        readonly height: number,
        /** Beside an empty bullet's dot, inline in its line, rather than a block beneath the line. */
        readonly beside: boolean,
        /** Where a panel beneath its line starts (`InlinePanelPlacement.column`); null at column 0. */
        readonly indent: string | null,
        /** Under the last line, a line's height clear of the text above. */
        readonly spaceAbove: boolean,
    ) {
        super()
    }

    eq(other: InlinePanelWidget): boolean {
        return other.id === this.id && other.height === this.height && other.beside === this.beside && other.indent === this.indent && other.spaceAbove === this.spaceAbove
    }

    get estimatedHeight(): number {
        return this.height + measuredExtra[extraKind(this.beside, this.spaceAbove)]
    }

    toDOM(view: EditorView): HTMLElement {
        // Beside a dot, a span in the bullet's line, as an interactive fence's form-1 widget is.
        const root: HTMLElement = document.createElement(this.beside ? 'span' : 'div')
        root.className = this.beside ? 'gk-inline-panel gk-inline-panel--beside' : this.spaceAbove ? 'gk-inline-panel gk-inline-panel--end' : 'gk-inline-panel'
        root.setAttribute('data-inline-panel', String(this.id))
        root.contentEditable = 'false'
        if (!this.beside) root.style.paddingLeft = this.indent ?? ''
        // The editor ignores keys inside the panel, so after the panel's Save, Mod+Z would reach
        // nothing. Outside a field the person is typing in, the chord is the editor's undo or redo,
        // as it is beside an interactive fence.
        root.addEventListener('keydown', (event) => {
            if (!historyChord(event) || typingField(event.composedPath()[0] ?? event.target)) return
            if (runScopeHandlers(view, event, 'editor')) event.preventDefault()
        })
        const entry = entries.get(this.id)
        if (entry && !entry.closed) {
            // Moved, with its content, out of any widget that showed it before.
            entry.host.style.height = `${this.height}px`
            root.appendChild(entry.host)
            if (!entry.content) {
                try {
                    entry.content = entry.mount(entry.host)
                } catch (error) {
                    console.error('[inline-panels] a panel failed to draw', error)
                }
            }
            const kind = extraKind(this.beside, this.spaceAbove)
            requestAnimationFrame(() => {
                if (!root.isConnected || entry.host.parentNode !== root) return
                // Beside a dot, the drop is a margin, which the line measures but the box leaves out.
                const drop = this.beside ? parseFloat(getComputedStyle(root).marginTop) || 0 : 0
                const extra = root.getBoundingClientRect().height + drop - entry.host.getBoundingClientRect().height
                if (extra > 0) measuredExtra[kind] = extra
            })
        }
        return root
    }

    /** The same panel drawn the same way takes a new indent or height in place. */
    updateDOM(dom: HTMLElement): boolean {
        if (dom.getAttribute('data-inline-panel') !== String(this.id) || dom.classList.contains('gk-inline-panel--beside') !== this.beside || dom.classList.contains('gk-inline-panel--end') !== this.spaceAbove) return false
        if (!this.beside) dom.style.paddingLeft = this.indent ?? ''
        const entry = entries.get(this.id)
        if (entry && entry.host.parentNode === dom) entry.host.style.height = `${this.height}px`
        return true
    }

    /** Only the widget goes: its content stays mounted in the host until the panel closes. */
    destroy(dom: HTMLElement): void {
        const entry = entries.get(this.id)
        if (entry && entry.host.parentNode === dom) entry.host.remove()
    }

    /** Events inside the panel are the panel's: typing in its field never reaches the document. */
    ignoreEvent(): boolean {
        return true
    }
}

/** A panel's left edge, as `InlinePanelPlacement.column` says, as a CSS length. */
function panelIndent(state: EditorState, column: InlinePanelPlacement['column']): string | null {
    if (!column) return null
    return column.edge === 'start' ? blockWidgetLineStart(state, column.line) : blockWidgetIndent(state, column.line)
}

/**
 * The empty bullet each panel is drawn beside is the panel's place, where its first block goes, so
 * the caret is kept off it as it is kept off a drawn Extension Fence (`caretKeptOff`,
 * interactive-fence.ts): it passes over the line, and a panel opening there moves the caret past.
 * Closing the panel gives the line back (`closeEntry`).
 */
export const panelCaretBlocks = caretKeptOff.of((state): CaretBlock[] =>
    inlinePanelWidgets(state)
        .filter((placement) => placement.beside)
        .map((placement) => {
            const line = state.doc.lineAt(placement.pos)
            return { blockFrom: line.from, blockTo: line.to }
        }),
)

const panelDecorations = EditorView.decorations.compute(['doc', inlinePanelsField], (state) =>
    Decoration.set(
        inlinePanelWidgets(state).map((placement) => {
            const widget = new InlinePanelWidget(placement.id, placement.height, placement.beside, placement.beside ? null : panelIndent(state, placement.column), placement.spaceAbove)
            return (placement.beside ? Decoration.widget({ widget, side: 1 }) : Decoration.widget({ widget, block: true, side: 1 })).range(placement.pos)
        }),
        true,
    ),
)

/**
 * Close a panel: out of its editor, its content taken down, and its opener told, once. A panel that
 * had the keyboard gives it back to the editor, on the line the panel sat beneath, so typing goes on
 * where it was.
 */
function closeEntry(entry: PanelEntry, dispatch = true): void {
    if (entry.closed) return
    entry.closed = true
    entries.delete(entry.id)
    if (entry.waiting?.timer) clearTimeout(entry.waiting.timer)
    entry.waiting = null
    if (dispatch) {
        try {
            const hadFocus = entry.host.contains(document.activeElement)
            const line = panelReturnLine(entry.view.state, entry.id)
            entry.view.dispatch({ effects: removeInlinePanel.of(entry.id) })
            if (hadFocus && line !== null) {
                entry.view.focus()
                entry.view.dispatch({ selection: { anchor: entry.view.state.doc.line(Math.min(line + 1, entry.view.state.doc.lines)).to } })
            }
        } catch {
            // The editor closed in between: there is nothing left to take the panel out of.
        }
    }
    try {
        entry.content?.destroy()
    } catch (error) {
        console.error('[inline-panels] a panel failed to close', error)
    }
    entry.content = null
    entry.host.remove()
    try {
        entry.onClose()
    } catch (error) {
        console.error('[inline-panels] a panel failed to close', error)
    }
}

/** How long a panel waits for a rebuilt editor's text before it settles for where it can go. */
const PLACEMENT_WAIT_MS = 3000

/**
 * An editor is going: carry each of its panels to the editor that replaces it, or close it. That is
 * every panel drawn in it, and every panel still waiting to be placed in it, so a panel whose new
 * editor closes during the wait closes too. Asked on the next microtask, since a remount records its
 * successor straight after the teardown.
 */
function carryOrClose(view: EditorView): void {
    const spots = view.state.field(inlinePanelsField, false) ?? []
    const going: PanelEntry[] = []
    for (const entry of entries.values()) {
        if (entry.view !== view || entry.closed) continue
        if (!entry.waiting) {
            const spot = spots.find((candidate) => candidate.id === entry.id)
            if (!spot) {
                closeEntry(entry, false)
                continue
            }
            entry.waiting = { spot, from: view, hadText: view.state.doc.length > 0, expired: false, timer: null }
        }
        going.push(entry)
    }
    if (going.length > 0) queueMicrotask(() => going.forEach(place))
}

/**
 * Put a waiting panel into the editor now showing its document, or close it when none is (the tab
 * closed, or the new editor shows a Protected Document). A Filesystem document mounts over an empty
 * buffer and fills it when its read lands: placed then, the panel would land on line 1 and be carried
 * wherever the fill put it, so it waits for the text, or {@link PLACEMENT_WAIT_MS}.
 */
function place(entry: PanelEntry): void {
    const waiting = entry.waiting
    if (!waiting || entry.closed) return
    const live = liveEditorView(waiting.from)
    const next = live.view
    if (!live.alive || next === waiting.from || next.state.field(inlinePanelsField, false) === undefined || !panelsAllowed(next.state)) {
        closeEntry(entry, false)
        return
    }
    entry.view = next
    if (waiting.hadText && next.state.doc.length === 0 && !waiting.expired) {
        waiting.timer ??= setTimeout(() => {
            waiting.expired = true
            place(entry)
        }, PLACEMENT_WAIT_MS)
        return
    }
    if (waiting.timer) clearTimeout(waiting.timer)
    entry.waiting = null
    const lineAt = (pos: number) => next.state.doc.lineAt(Math.min(live.mapPos(pos), next.state.doc.length)).from
    const { spot } = waiting
    const carried: InlinePanelSpot = { ...spot, lineStart: lineAt(spot.lineStart), ...(spot.anchor === undefined ? {} : { anchor: lineAt(spot.anchor) }) }
    try {
        next.dispatch({ effects: addInlinePanel.of(carried) })
    } catch {
        closeEntry(entry, false)
    }
}

const panelLifecycle = ViewPlugin.fromClass(
    class {
        constructor(readonly view: EditorView) {}

        update(update: { docChanged: boolean }) {
            if (!update.docChanged || this.view.state.doc.length === 0) return
            const waiting = [...entries.values()].filter((entry) => entry.view === this.view && entry.waiting)
            // Out of the update: CodeMirror refuses a dispatch while it is drawing.
            if (waiting.length > 0) queueMicrotask(() => waiting.forEach(place))
        }

        destroy() {
            carryOrClose(this.view)
        }
    },
)

const panelTheme = EditorView.baseTheme({
    // Padding, never margin, so the height map sees the whole box (ADR 0022).
    '.gk-inline-panel': { padding: '6px 0', display: 'flow-root', textIndent: '0', whiteSpace: 'normal', cursor: 'auto' },
    // Beside an empty bullet's dot: dropped and as wide as the bullet's text, as an interactive
    // fence's form-1 widget is (interactive-fence.ts). A margin is height the line does measure.
    '.gk-inline-panel.gk-inline-panel--beside': {
        display: 'inline-block',
        verticalAlign: 'top',
        width: '100%',
        boxSizing: 'border-box',
        margin: `${BULLET_BLOCK_DROP} 0 0`,
        padding: `0 0 ${BLOCK_WIDGET_SPACING}`,
    },
    // Under the last line: a line's height of the editor's own text, and the usual 6px, clear of
    // the text above, so the panel never reads as part of the last block. Padding, as above.
    '.gk-inline-panel.gk-inline-panel--end': { paddingTop: 'calc(1lh + 6px)' },
    '.gk-inline-panel-host': { position: 'relative', overflow: 'hidden' },
    // The panel takes the focus from a press so its text can be selected; it draws no ring for it.
    '.gk-inline-panel-host:focus': { outline: 'none' },
})

/** The augmentation every document editor carries, so a panel can open in any of them. */
export function inlinePanelsAugmentation() {
    return [inlinePanelsField, panelCaretBlocks, panelDecorations, panelLifecycle, panelTheme]
}

/** A panel as its opener holds it. */
export interface InlinePanelHandle {
    readonly isOpen: boolean
    /** The document the panel is in, by its concept, or null outside a workspace. */
    document(): string | null
    insertBlock(text: string): boolean
    focus(): void
    /** A new height for the panel, which its content scrolls inside. */
    resize(height: number): void
    /** The outline around the panel's line ({@link panelOutline}), or null. */
    outline(): string | null
    /** The text of the bullet the panel opened on, read as it opened ({@link panelLineText}), or null. */
    lineText(): string | null
    close(): void
}

/**
 * Open a panel in `view`, at the caret's line or under the last line. Null where no panel can go,
 * or in an editor without the augmentation.
 */
export function openInlinePanel(
    view: EditorView,
    options: { at: 'caret' | 'end' | 'caret-or-end'; height?: number; mount(host: HTMLElement, handle: InlinePanelHandle): { destroy(): void }; onClose?(): void },
): InlinePanelHandle | null {
    if (view.state.field(inlinePanelsField, false) === undefined) return null
    const anchor = panelAnchorAt(view.state, options.at, view.hasFocus)
    if (!anchor) return null
    const id = nextId++
    const height = panelHeight(options.height)
    // Read now, before the person types on: what the line said when the panel was asked for.
    const lineText = anchor.mode === 'line' ? panelLineText(view.state, anchor.lineStart) : null
    const host = document.createElement('div')
    host.className = 'gk-inline-panel-host'
    // A press on the panel's text gives the panel the focus, not the editor around it. With the
    // editor focused, CodeMirror would draw its own caret over a selection made in the panel, and
    // Mod+C would copy the document's line rather than what was selected. Its own fields still
    // take the focus themselves.
    host.tabIndex = -1
    const handle: InlinePanelHandle = {
        get isOpen() {
            return !entry.closed
        },
        document: () => entry.view.state.facet(editorDocument)?.concept ?? null,
        insertBlock(text) {
            // Not into an editor that has gone, or one the panel has not been placed in yet: either
            // would take the change without a word and write nothing (editor-succession.ts).
            if (entry.closed || entry.waiting) return false
            const live = liveEditorView(entry.view)
            if (!live.alive || live.view !== entry.view) return false
            const plan = planPanelInsert(entry.view.state, id, text)
            if (!plan) return false
            entry.view.dispatch({ changes: plan.changes, effects: plan.effects, userEvent: 'input.complete' })
            return true
        },
        focus() {
            if (entry.closed) return
            const widget = inlinePanelWidgets(entry.view.state).find((candidate) => candidate.id === id)
            if (widget) entry.view.dispatch({ effects: EditorView.scrollIntoView(widget.pos, { y: 'nearest', yMargin: 48 }) })
        },
        resize(next) {
            if (entry.closed) return
            const resized = panelHeight(next)
            // A panel waiting for a rebuilt editor takes the height where it is placed.
            if (entry.waiting) {
                entry.waiting.spot = { ...entry.waiting.spot, height: resized }
                return
            }
            const live = liveEditorView(entry.view)
            if (!live.alive || live.view !== entry.view) return
            const spot = (entry.view.state.field(inlinePanelsField, false) ?? []).find((candidate) => candidate.id === id)
            if (spot && (spot.height ?? DEFAULT_HEIGHT) !== resized) entry.view.dispatch({ effects: resizeInlinePanel.of({ id, height: resized }) })
        },
        outline: () => (entry.closed || entry.waiting ? null : panelOutline(entry.view.state, id)),
        lineText: () => lineText,
        close: () => closeEntry(entry),
    }
    const entry: PanelEntry = {
        id,
        view,
        host,
        content: null,
        mount: (into) => options.mount(into, handle),
        onClose: () => options.onClose?.(),
        closed: false,
        waiting: null,
    }
    entries.set(id, entry)
    view.dispatch({ effects: [addInlinePanel.of({ id, ...anchor, height }), EditorView.scrollIntoView(anchor.mode === 'end' ? view.state.doc.length : anchor.lineStart, { y: 'nearest', yMargin: 48 })] })
    return handle
}
