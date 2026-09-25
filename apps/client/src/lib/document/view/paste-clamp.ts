/**
 * Paste and text drop: what a multi-line fragment becomes where it lands (Editor Content Rules →
 * *Pasting into a block* and *The source clamp*; ADR 0020, ADR 0067, ADR 0089).
 *
 * **Into an outliner block, a block per line** ({@link pastedTextAsBlocks}, ADR 0089). The first
 * line lands at the caret as typing would; every further non-blank line becomes a block of its own,
 * as if Enter had been pressed before it. A prose line lands where Enter would put the next block
 * (a sibling, or the first child at the end of a block that has children) with the kind Enter would
 * give it; a bullet line keeps its own marker and nests one level under the nearest prose line
 * before it in the fragment - the caret's block, until the fragment supplies one - plus its own
 * nesting. What belongs to a pasted bullet stays its own: its continuation lines, its soft blanks
 * and its fenced code move with it. A fenced block owned by no bullet is one block (a form-1 fence).
 * Blank lines separate blocks and are dropped. A pasted bullet line's marker merges with the
 * caret's: an empty bullet, or a selection that took the marker, is taken whole (task state and
 * all, so a copied block pastes as itself); a bullet that already has text takes the content only.
 *
 * Before the report of 2026-09-22 a paste into a bullet made continuation lines of everything after
 * the first line, and a fragment mixing prose and bullets left a paragraph below a sublist at the
 * parent's content column: a shape Enter and the tidy read as prose and dismantled.
 *
 * **Inside a fenced block, the clamp** ({@link clampPastedText}, ADR 0020): every line after the
 * first is indented to the fence column, the fragment's own common indentation stripped, so column 0
 * of the fragment reads as column 0 of the code and no pasted line can dissolve the block. The fence
 * guard (`fence-guard.ts`) cannot repair that after the fact because, once dissolved, there is no
 * block left for it to find, so the clamp is applied while the block is still intact, in the same
 * transaction as the paste (one undo step).
 *
 * **Into prose, as pasted** - except that a paste that STARTS a prose line (a clean line, or the
 * start of one) carries the indentation of wherever its lines were copied from: blocks copied at
 * depth three arrive at depth three, under nothing, and are orphans the moment they land
 * (2026-09-14). The fragment's common indentation is stripped so its first line starts a tree at the
 * top level, and the lines after it are healed from there ({@link healPastedTree}). Inside the
 * [[Frontmatter]] every indent is YAML and is never touched.
 *
 * In every structural case the fragment is first put on the [[Indent Unit]] grid by the same
 * normaliser an [[Import]] runs (ADR 0067): a tree copied out of a four-space vault or a
 * tab-indented Logseq page lands at two spaces a level. Paste is the import boundary in miniature.
 * Code and YAML are never normalised.
 */

import { EditorSelection, EditorState, type Extension, Transaction } from '@codemirror/state'

import { type FencedBlockRange, fencedBlocks } from '../fenced-code'
import { INDENT_UNIT, normaliseIndentUnit, outlineLines } from '../indent-unit'
import {
    blockBodyEnd,
    branchRange,
    bulletContent,
    contentColumn,
    contentStart,
    isBulletLine,
    lineIndent,
    MARKER_WIDTH,
    newBulletMarker,
    opaqueLineFlags,
    ownerBulletIndex,
} from '../outliner'
import { clampColumn } from './caret-clamp'

/** Re-indent a pasted fragment for a target whose clamp is `clamp` columns. */
export function clampPastedText(text: string, clamp: number): string {
    if (clamp === 0 || !text.includes('\n')) return text
    const lines = text.split('\n')
    const indents = lines.filter((line) => line.trim() !== '').map((line) => line.length - line.trimStart().length)
    const common = indents.length ? Math.min(...indents) : 0
    const pad = ' '.repeat(clamp)
    return lines.map((line, i) => (i === 0 ? line.slice(Math.min(common, line.length - line.trimStart().length)) : pad + line.slice(Math.min(common, line.length - line.trimStart().length)))).join('\n')
}

/**
 * Pull any pasted bullet that sits more than one level below the previous bullet up to one level,
 * walking from `previousIndent` (the indent of the bullet the paste joins). Non-bullet lines and the
 * first line (spliced into the target line) are left alone.
 */
export function healPastedBullets(text: string, previousIndent: number): string {
    const lines = text.split('\n')
    let previous = previousIndent
    for (let i = 1; i < lines.length; i++) {
        if (!isBulletLine(lines[i])) continue
        const indent = lineIndent(lines[i])
        const allowed = previous + INDENT_UNIT
        if (indent > allowed) lines[i] = ' '.repeat(allowed) + lines[i].slice(indent)
        previous = Math.min(indent, allowed)
    }
    return lines.join('\n')
}

/** The fragment with its common indentation stripped, so its shallowest line sits at column 0. */
export function stripCommonIndent(text: string): string {
    const lines = text.split('\n')
    const indents = lines.filter((line) => line.trim() !== '').map(lineIndent)
    const common = indents.length ? Math.min(...indents) : 0
    return lines.map((line) => line.slice(Math.min(common, lineIndent(line)))).join('\n')
}

/**
 * A fragment pasted at the start of a prose line, made a well-formed tree from the top level: its
 * common indentation stripped ({@link stripCommonIndent}) and every bullet after the first pulled up
 * to one level under the bullet before it ({@link healPastedBullets}). A fragment whose first line
 * is prose has no bullet to nest under, so its first bullet lands at the top level too.
 */
export function healPastedTree(text: string): string {
    const stripped = stripCommonIndent(text)
    const first = stripped.split('\n')[0]
    return healPastedBullets(stripped, isBulletLine(first) ? lineIndent(first) : -INDENT_UNIT)
}

/** The block a paste lands in, as {@link pastedTextAsBlocks} needs to see it. */
export interface PasteTarget {
    /** Indent of the block's bullet line. */
    indent: number
    /** The block's content column: where a fence pasted after the block's text starts (a form-2 fence). */
    contentColumn: number
    /** The indent a block made by Enter here takes: the block's own, or its children's at the end of a body that has children. */
    newIndent: number
    /** The marker Enter would give that block (`- ` or `- [ ] `). */
    marker: string
    /** The indent a bullet nested under the block takes: `newIndent` when Enter would make a first child, else one unit under. */
    nestIndent: number
    /** The paste is the bullet's whole content: nothing but the marker before it, nothing after it. */
    emptyBullet: boolean
    /** The replaced range holds the bullet's marker (a paste over selected blocks). */
    replacesMarker: boolean
    /** The marker a prose first line takes when it owns the line: the bullet's own, or a fresh one over a replaced marker. */
    lineMarker: string
    /** Text right of the replaced range on its line: it follows the last pasted line. */
    after: string
}

export interface PastedBlocks {
    /** The text to insert: the first line at the caret (or over the line's indent and marker when `replacesLine`), a block per line after it. */
    insert: string
    /** The change starts at the caret's line start, its indent and marker replaced by the first line. */
    replacesLine: boolean
}

/**
 * Move a line's leading spaces by `delta` columns, never below column 0. Only spaces move: a tab
 * inside pasted code (past the fence column, where the normaliser leaves it) stays a tab.
 */
function shiftLeading(line: string, delta: number): string {
    const spaces = /^ */.exec(line)![0].length
    return ' '.repeat(Math.max(0, spaces + delta)) + line.slice(spaces)
}

/**
 * A fragment pasted into an outliner block, a block per line (module comment; ADR 0089). Returns the
 * lines to insert at the caret, the first spliced into the caret's line, and whether that first line
 * takes the whole line over.
 */
export function pastedTextAsBlocks(text: string, target: PasteTarget): PastedBlocks {
    // The first line owns the whole caret line: the change then starts at the line's start and the
    // first line supplies the indent and a marker.
    const takesLine = target.emptyBullet || target.replacesMarker
    const lines = stripCommonIndent(normaliseIndentUnit(text)).split('\n')
    const blocks = fencedBlocks(lines)
    const fenceAt = new Map<number, FencedBlockRange>(blocks.map((b) => [b.start, b]))
    const outline = outlineLines(lines, blocks)
    const out: string[] = []
    let replacesLine = false
    /** Indents of the fragment's open bullets, innermost last: a bullet's nesting is how many are shallower than it. */
    const open: number[] = []
    /** The indent of the block the fragment's bullets currently nest under. */
    let base = target.indent
    /** Columns each placed fragment bullet moved by, so its continuation lines and fence move with it. */
    const shift = new Map<number, number>()
    /** The fragment's root is a bullet merged into the caret's block and its subtree is still open. */
    let rootOpen = false
    /** The content column of the last block emitted: where the caret line's tail goes when it needs a line of its own. */
    let tailColumn = target.contentColumn
    /** The last lines emitted are a fenced block, closer last. */
    let endsWithFence = false
    /** Emit a fenced block's lines after its opener, moved with the opener. */
    const pushFenceBody = (unit: FencedBlockRange, delta: number) => {
        for (let j = unit.start + 1; j <= unit.end; j++) out.push(shiftLeading(lines[j], delta))
        endsWithFence = true
    }

    for (let k = 0; k < lines.length; k++) {
        const line = lines[k]
        const unit = fenceAt.get(k)
        const owner = outline[k].owner
        if (isBulletLine(line)) {
            const indent = lineIndent(line)
            while (open.length && open[open.length - 1] >= indent) open.pop()
            if (rootOpen && open.length === 0) rootOpen = false // a sibling of the merged root closes its subtree
            let at: number
            if (k === 0) {
                // The fragment's root joins the caret's block: whole when it owns the line, else content only.
                at = target.indent
                if (takesLine) {
                    replacesLine = true
                    out.push(' '.repeat(at) + line.trimStart())
                } else out.push(bulletContent(line))
                rootOpen = true
                // Its siblings in the fragment land where Enter would put the next block.
                base = target.newIndent - INDENT_UNIT
            } else {
                // The merged root's descendants hang from where a bullet nested under the caret's block goes
                // (its children's indent when it has children, so they cannot land two levels down); every
                // other bullet one level under its base.
                at = rootOpen ? target.nestIndent + INDENT_UNIT * (open.length - 1) : base + INDENT_UNIT * (open.length + 1)
                out.push(' '.repeat(at) + line.trimStart())
                tailColumn = at + MARKER_WIDTH
            }
            open.push(indent)
            shift.set(k, at - indent)
            endsWithFence = false
            if (unit) {
                // A form-1 fence: the bullet is the opener and the code travels with it.
                pushFenceBody(unit, at - indent)
                k = unit.end
            }
            continue
        }
        if (owner >= 0) {
            // A continuation of a fragment bullet (a soft line, a soft blank, a form-2 fence): stays its own.
            const delta = shift.get(owner) ?? 0
            out.push(shiftLeading(line, delta))
            endsWithFence = false
            if (unit) {
                pushFenceBody(unit, delta)
                k = unit.end
            }
            continue
        }
        // Owned by no bullet: prose, a heading, a bare blank line, or a fenced block of its own.
        if (k === 0) {
            // The first line is the caret's, blank or not: an empty first line leaves the caret's text alone.
            if (unit) {
                // A fence at the caret is never split across the caret's text: the bullet's own fence on an
                // empty bullet (form 1), else a fence on its own continuation line (form 2).
                let column: number
                if (takesLine) {
                    replacesLine = true
                    out.push(' '.repeat(target.indent) + '- ' + line.trimStart())
                    column = target.indent + MARKER_WIDTH
                } else {
                    out.push('', ' '.repeat(target.contentColumn) + line.trimStart())
                    column = target.contentColumn
                }
                tailColumn = column
                pushFenceBody(unit, column - lineIndent(line))
                k = unit.end
            } else if (takesLine) {
                replacesLine = true
                out.push(' '.repeat(target.indent) + target.lineMarker + line.trimStart())
            } else out.push(line.trimStart())
            // The caret's block is the prose line the fragment's first bullets nest under.
            base = target.nestIndent - INDENT_UNIT
            continue
        }
        if (!unit && line.trim() === '') continue // a blank line separates blocks; there is nothing to keep
        if (unit) {
            out.push(' '.repeat(target.newIndent) + '- ' + line.trimStart())
            pushFenceBody(unit, target.newIndent + MARKER_WIDTH - lineIndent(line))
            k = unit.end
        } else {
            out.push(' '.repeat(target.newIndent) + target.marker + line.trimStart())
            endsWithFence = false
        }
        tailColumn = target.newIndent + MARKER_WIDTH
        // Bullets after a prose line nest under it, from the top.
        base = target.newIndent
        open.length = 0
        rootOpen = false
    }
    // The caret line's tail follows the last pasted line; after a closing fence it takes a soft line of
    // its own, or it would become the closer's info string and dissolve the block.
    if (endsWithFence && target.after !== '') out.push(' '.repeat(tailColumn))
    return { insert: out.join('\n'), replacesLine }
}

/**
 * The block a paste replacing `[from, to)` lands in, or null when the line is not a block's (prose,
 * a fenced block, the frontmatter). Shared with the [[Rich Paste]] plan (`rich-paste.ts`).
 */
export function blockPasteTarget(state: EditorState, from: number, to: number, multiLine: boolean): PasteTarget | null {
    const lines = state.doc.toString().split('\n')
    const index = state.doc.lineAt(from).number - 1
    const blocks = fencedBlocks(lines)
    if (opaqueLineFlags(lines, blocks)[index]) return null
    const owner = isBulletLine(lines[index]) ? index : ownerBulletIndex(lines, index, blocks)
    return owner === null ? null : pasteTargetAt(state, lines, blocks, owner, from, to, multiLine)
}

/** How the block owning the line at `from` receives a paste replacing `[from, to)`. */
function pasteTargetAt(state: EditorState, lines: string[], blocks: FencedBlockRange[], owner: number, from: number, to: number, multiLine: boolean): PasteTarget {
    const doc = state.doc
    const line = doc.lineAt(from)
    const ownerLine = lines[owner]
    const indent = lineIndent(ownerLine)
    const onBullet = isBulletLine(line.text)
    const start = contentStart(line.text)
    const before = line.text.slice(0, from - line.from)
    const toLine = doc.lineAt(to)
    const tail = toLine.text.slice(to - toLine.from)
    // The paste is the bullet's whole content: nothing but the marker before it, nothing after it.
    const emptyBullet = onBullet && before === line.text.slice(0, start) && tail.trim() === ''
    // The replaced range holds the marker: a block selection replaced by a paste, or a margin drag over
    // the marker and the line's content. A single line over a margin drag that leaves content behind is
    // typed text, as typing it would be (delete-heal.ts reads what remains).
    const replacesMarker = onBullet && from - line.from <= lineIndent(line.text) && to >= line.from + start && (multiLine || to >= line.to)
    const bodyEnd = blockBodyEnd(lines, owner, blocks)
    const hasChildren = branchRange(lines, owner, blocks).end > bodyEnd
    // As Enter reads it: at the end of the block's own lines, with children, the next block is a first child.
    const firstChild = hasChildren && to === doc.line(bodyEnd + 1).to
    const next = firstChild ? lines[bodyEnd + 1] : ownerLine
    const newIndent = firstChild ? lineIndent(next) : indent
    return {
        indent,
        contentColumn: contentColumn(ownerLine),
        newIndent,
        marker: newBulletMarker(next),
        nestIndent: firstChild ? newIndent : indent + INDENT_UNIT,
        emptyBullet,
        replacesMarker,
        lineMarker: emptyBullet ? line.text.slice(lineIndent(line.text), start) : newBulletMarker(line.text),
        after: tail,
    }
}

export function pasteClamp(): Extension {
    return EditorState.transactionFilter.of((tr) => {
        if (!tr.docChanged || !(tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop'))) return tr
        let single: { from: number; to: number; text: string } | null = null
        let count = 0
        tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            count += 1
            single = { from: fromA, to: toA, text: inserted.toString() }
        })
        if (count !== 1 || !single) return tr
        const { from, to, text } = single as { from: number; to: number; text: string }
        const doc = tr.startState.doc
        const line = doc.lineAt(from)
        const index = line.number - 1
        const lines = doc.toString().split('\n')
        const blocks = fencedBlocks(lines)
        const opaque = opaqueLineFlags(lines, blocks)
        // The reshaped transaction keeps the user event it was given: a Rich Paste's names it (editor-history.ts).
        const userEvent = tr.annotation(Transaction.userEvent) ?? 'input.paste'
        const multiLine = text.includes('\n')
        if (!opaque[index]) {
            const owner = isBulletLine(line.text) ? index : ownerBulletIndex(lines, index, blocks)
            if (owner !== null) {
                const target = pasteTargetAt(tr.startState, lines, blocks, owner, from, to, multiLine)
                // A single line is typed text, unless it is a bullet line taking over an empty bullet or a
                // paste over selected blocks, which are blocks either way.
                if (!multiLine && !target.replacesMarker && !(target.emptyBullet && isBulletLine(text))) return tr
                const { insert, replacesLine } = pastedTextAsBlocks(text, target)
                const start = replacesLine ? line.from : from
                if (start === from && insert === text) return tr
                return {
                    changes: { from: start, to, insert },
                    selection: EditorSelection.cursor(start + insert.length),
                    userEvent,
                    scrollIntoView: true,
                }
            }
        }
        if (!multiLine) return tr
        // Inside a fence the clamp is the fence column; on a bullet-shaped line (a form-1 opener) the
        // content column; in prose and the frontmatter, 0.
        const clamp = isBulletLine(line.text) ? contentColumn(line.text) : clampColumn(lines, index)
        let insert = clampPastedText(text, clamp)
        if (clamp === 0 && !opaque[index] && line.text.slice(0, from - line.from).trim() === '') {
            // Starting a prose line (a clean line, or the start of one): the fragment's indentation is
            // where it was copied from, not where it lands. Code and YAML keep theirs.
            insert = healPastedTree(normaliseIndentUnit(text))
        }
        if (insert === text) return tr
        return {
            changes: { from, to, insert },
            selection: EditorSelection.cursor(from + insert.length),
            userEvent,
            scrollIntoView: true,
        }
    })
}
