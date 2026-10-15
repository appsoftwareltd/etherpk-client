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
 * **A [[Plain Paste]] into a block, one block** ({@link pastedTextAsOneBlock}, the 2026-10-14
 * amendment to ADR 0089). The browser's paste-as-plain-text shortcut keeps the fragment in the
 * caret's block: the first line lands as above, and every line after it is a continuation line at
 * the block's content column, blank lines between them included. The fragment's bullets can only be
 * children at that column, so they nest under the block, and a line after them is the block's own
 * paragraph after its children, which `ownerBulletIndex` reads as the block's since ADR 0089. A
 * heading ends any block it sits in, so each pasted heading is a block of its own under the caret's
 * block, owning its section as a [[Rich Paste]] heading does.
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
    isHeadingLine,
    lineIndent,
    MARKER_WIDTH,
    newBulletMarker,
    opaqueLineFlags,
    ownerBulletIndex,
} from '../outliner'
import { clampColumn } from './caret-clamp'

/**
 * The user event of a [[Plain Paste]] (`augmentations/plain-paste.ts`): the browser's
 * paste-as-plain-text shortcut. `isUserEvent('input.paste')` still matches it, so every paste rule
 * reads it as a paste, and {@link pasteClamp} keeps its lines in one block.
 */
export const PLAIN_PASTE_USER_EVENT = 'input.paste.plain'

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
    /** The paste starts a line that is not the bullet's own: only indentation before it, so its first line opens the line. */
    startsLine: boolean
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

/** A fenced block's lines after its opener, moved by `delta` columns as the opener was. */
function fenceBody(lines: string[], unit: FencedBlockRange, delta: number): string[] {
    return lines.slice(unit.start + 1, unit.end + 1).map((line) => shiftLeading(line, delta))
}

/** What placing a fragment's first line wrote, and what the walk over the lines after it starts from. */
interface FirstLinePlaced {
    out: string[]
    /** The index of the last fragment line placed: the first line, or the closer of the fence it opens. */
    last: number
    /** The first line is a bullet merged into the caret's block: the columns its own lines move by. Else null. */
    rootShift: number | null
    /** Where the caret line's tail goes when it needs a line of its own. */
    tailColumn: number
    /** The lines placed end with a fence's closer. */
    endsWithFence: boolean
}

/**
 * A fragment's first line, placed at the caret the same way by every paste into a block. A bullet line
 * merges its marker with the caret's: whole when it owns the line, else its content only. A fence,
 * alone or on the first line's bullet, is never split across the caret's text: the bullet's own fence
 * on an empty bullet (form 1), else a fence on its own continuation line (form 2). Prose lands as
 * typed, or after the line's marker when it owns the line; an empty first line leaves the caret's
 * text alone.
 */
function placeFirstLine(lines: string[], unit: FencedBlockRange | undefined, target: PasteTarget, takesLine: boolean): FirstLinePlaced {
    const line = lines[0]
    const indent = ' '.repeat(target.indent)
    if (isBulletLine(line)) {
        const shift = target.indent - lineIndent(line)
        if (unit && !takesLine) {
            // The bullet's own fence after the caret's text: the opener on a line of its own, at the content column.
            const out = ['', ' '.repeat(target.contentColumn) + bulletContent(line), ...fenceBody(lines, unit, target.contentColumn - contentColumn(line))]
            return { out, last: unit.end, rootShift: shift, tailColumn: target.contentColumn, endsWithFence: true }
        }
        const out = [takesLine ? indent + line.trimStart() : bulletContent(line)]
        if (unit) out.push(...fenceBody(lines, unit, shift))
        return { out, last: unit ? unit.end : 0, rootShift: shift, tailColumn: target.contentColumn, endsWithFence: unit !== undefined }
    }
    if (unit) {
        const column = takesLine ? target.indent + MARKER_WIDTH : target.contentColumn
        const opener = takesLine ? [indent + '- ' + line.trimStart()] : ['', ' '.repeat(column) + line.trimStart()]
        const out = [...opener, ...fenceBody(lines, unit, column - lineIndent(line))]
        return { out, last: unit.end, rootShift: null, tailColumn: column, endsWithFence: true }
    }
    const out = [takesLine ? indent + target.lineMarker + line.trimStart() : line.trimStart()]
    return { out, last: 0, rootShift: null, tailColumn: target.contentColumn, endsWithFence: false }
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
    const first = placeFirstLine(lines, fenceAt.get(0), target, takesLine)
    const out = first.out
    /** Indents of the fragment's open bullets, innermost last: a bullet's nesting is how many are shallower than it. */
    const open: number[] = []
    /** Columns each placed fragment bullet moved by, so its continuation lines and fence move with it. */
    const shift = new Map<number, number>()
    /** The fragment's root is a bullet merged into the caret's block and its subtree is still open. */
    let rootOpen = false
    /** The indent of the block the fragment's bullets currently nest under. */
    let base: number
    if (first.rootShift !== null) {
        // The root joined the caret's block; its siblings in the fragment land where Enter would put the next block.
        rootOpen = true
        open.push(lineIndent(lines[0]))
        shift.set(0, first.rootShift)
        base = target.newIndent - INDENT_UNIT
    } else {
        // The caret's block is the prose line the fragment's first bullets nest under.
        base = target.nestIndent - INDENT_UNIT
    }
    /** The content column of the last block emitted: where the caret line's tail goes when it needs a line of its own. */
    let tailColumn = first.tailColumn
    /** The last lines emitted are a fenced block, closer last. */
    let endsWithFence = first.endsWithFence
    /** Emit a fenced block's lines after its opener, moved with the opener. */
    const pushFenceBody = (unit: FencedBlockRange, delta: number) => {
        out.push(...fenceBody(lines, unit, delta))
        endsWithFence = true
    }

    for (let k = first.last + 1; k < lines.length; k++) {
        const line = lines[k]
        const unit = fenceAt.get(k)
        const owner = outline[k].owner
        if (isBulletLine(line)) {
            const indent = lineIndent(line)
            while (open.length && open[open.length - 1] >= indent) open.pop()
            if (rootOpen && open.length === 0) rootOpen = false // a sibling of the merged root closes its subtree
            // The merged root's descendants hang from where a bullet nested under the caret's block goes
            // (its children's indent when it has children, so they cannot land two levels down); every
            // other bullet one level under its base.
            const at = rootOpen ? target.nestIndent + INDENT_UNIT * (open.length - 1) : base + INDENT_UNIT * (open.length + 1)
            out.push(' '.repeat(at) + line.trimStart())
            tailColumn = at + MARKER_WIDTH
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
    return { insert: out.join('\n'), replacesLine: takesLine }
}

/** The lines without the blank lines at their start and their end: the trailing newline of a line-wise copy, say. */
function withoutEdgeBlankLines(lines: string[]): string[] {
    let start = 0
    let end = lines.length
    while (start < end && lines[start].trim() === '') start++
    while (end > start && lines[end - 1].trim() === '') end--
    return start === end ? [''] : lines.slice(start, end)
}

/** A heading line's level: how many `#` open it. */
function headingLevel(line: string): number {
    return /^#+/.exec(line.trimStart())![0].length
}

/**
 * A [[Plain Paste]] into an outliner block: the whole fragment stays in the caret's block (module
 * comment; the 2026-10-14 amendment to ADR 0089). The first line lands as {@link pastedTextAsBlocks}
 * puts it, and every line after it is the block's own, at its content column plus the line's own
 * indentation, a blank line at the content column. A bullet line can only be a child at that column,
 * so the fragment's bullets nest under the block with their own nesting, and what belongs to each
 * moves with it; a line after them that belongs to none of them is the block's paragraph after its
 * children, at its content column exactly, since any deeper it would sit inside a child's branch short
 * of the child's text, where nothing owns it.
 *
 * A heading line ends a block wherever it sits, so it cannot be one of the block's lines either. Each
 * is a block of its own under the caret's block that owns its section, through to the next heading of
 * its level or higher, as a [[Rich Paste]] nests one: the lines after it are that block's lines and
 * the bullets after it its children, by the rules above. Blank lines before a heading separate
 * sections, which the nesting now does, and are dropped. No heading ever leaves the caret's block.
 */
export function pastedTextAsOneBlock(text: string, target: PasteTarget): PastedBlocks {
    const takesLine = target.emptyBullet || target.replacesMarker
    const fragment = withoutEdgeBlankLines(stripCommonIndent(normaliseIndentUnit(text)).split('\n'))
    // A heading first line that would open a continuation line would end the block there: it goes on a
    // line of its own as the first section instead, and the caret's line, holding nothing else, gives way.
    const headingOpens = target.startsLine && !takesLine && isHeadingLine(fragment[0])
    const lines = headingOpens ? ['', ...fragment] : fragment
    const blocks = fencedBlocks(lines)
    const fenceAt = new Map<number, FencedBlockRange>(blocks.map((b) => [b.start, b]))
    const code = (k: number) => blocks.some((b) => k > b.start && k <= b.end)
    const heading = lines.map((line, k) => k > 0 && !code(k) && isHeadingLine(line))
    /** Blank lines whose next non-blank line is a heading: they separate sections and are dropped. */
    const beforeHeading = lines.map(() => false)
    for (let k = lines.length - 1, next = false; k > 0; k--) {
        const blank = !code(k) && lines[k].trim() === ''
        beforeHeading[k] = blank && next
        if (!blank) next = heading[k]
    }
    const outline = outlineLines(lines, blocks)
    const first = placeFirstLine(lines, fenceAt.get(0), target, takesLine)
    const out = first.out
    const replacesLine = takesLine || (headingOpens && target.after.trim() === '')
    if (replacesLine && !takesLine) out.shift() // the empty caret line is the first section's line
    /**
     * Where each placed fragment bullet went: the columns its own lines move by, and its content
     * column. A merged first bullet is the caret's block, so it is never one of the open bullets.
     */
    const placed = new Map<number, { shift: number; column: number }>()
    if (first.rootShift !== null) placed.set(0, { shift: first.rootShift, column: target.contentColumn })
    /** The open sections, innermost last: each heading block's level and bullet indent. */
    const sections: { level: number; indent: number }[] = []
    /** The fragment's open bullets in the innermost section, innermost last: a bullet's nesting is how many are shallower than it. */
    const open: { indent: number; index: number }[] = []
    let tailColumn = first.tailColumn
    let endsWithFence = first.endsWithFence

    for (let k = first.last + 1; k < lines.length; k++) {
        if (beforeHeading[k]) continue
        const line = lines[k]
        const unit = fenceAt.get(k)
        const owner = outline[k].owner
        const blank = !unit && line.trim() === ''
        // The block the fragment's lines currently belong to: the innermost section, else the caret's block.
        const section = sections.at(-1)
        const container = section ? { column: section.indent + MARKER_WIDTH, nest: section.indent + INDENT_UNIT } : { column: target.contentColumn, nest: target.nestIndent }
        let delta: number
        if (heading[k]) {
            // A section of its own, under the innermost open one of a lower level, else under the caret's block.
            const level = headingLevel(line)
            while (sections.length && sections[sections.length - 1].level >= level) sections.pop()
            const parent = sections.at(-1)
            const at = parent ? parent.indent + INDENT_UNIT : target.nestIndent
            sections.push({ level, indent: at })
            open.length = 0
            out.push(' '.repeat(at) + '- ' + line.trimStart())
            tailColumn = at + MARKER_WIDTH
            endsWithFence = false
            continue
        }
        if (isBulletLine(line)) {
            // A child of the container, nested as deep as the fragment nests it.
            const indent = lineIndent(line)
            while (open.length && open[open.length - 1].indent >= indent) open.pop()
            const at = container.nest + INDENT_UNIT * open.length
            open.push({ indent, index: k })
            delta = at - indent
            placed.set(k, { shift: delta, column: at + MARKER_WIDTH })
            tailColumn = at + MARKER_WIDTH
        } else {
            // The line of a fragment bullet still open (a soft line, a soft blank, a form-2 fence), or the
            // container's own line (prose, a bare blank line, a fenced block of its own).
            const at = owner >= 0 ? open.findIndex((entry) => entry.index === owner) : -1
            const bullet = at >= 0 || (owner === 0 && sections.length === 0) ? placed.get(owner) : undefined
            const column = bullet?.column ?? container.column
            // How many open bullets are the owner and its ancestors: none for the container. Any open past
            // them are the owner's children, which this line follows, so it sits at the owner's content
            // column exactly, as its paragraph after them: any deeper is inside the last child's branch
            // short of that child's text, where nothing owns it.
            const depth = bullet ? at + 1 : 0
            const afterChildren = open.length > depth
            open.length = depth
            tailColumn = column
            if (blank) {
                // A blank line has no text to keep in place: it sits at its block's content column, since
                // one short of it is in no block.
                out.push(' '.repeat(column))
                endsWithFence = false
                continue
            }
            // A line whose bullet a heading closed is the section's own: its indentation was that
            // bullet's, so it sits at the section's content column exactly, as one after children does.
            const ownerClosed = owner >= 0 && !bullet
            if (afterChildren || ownerClosed) delta = column - lineIndent(line)
            else delta = bullet ? bullet.shift : container.column
        }
        out.push(shiftLeading(line, delta))
        endsWithFence = unit !== undefined
        if (unit) {
            out.push(...fenceBody(lines, unit, delta))
            k = unit.end
        }
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
        startsLine: !onBullet && before.trim() === '',
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
                // A Plain Paste keeps its lines in the caret's block; any other paste makes a block of each.
                const place = tr.isUserEvent(PLAIN_PASTE_USER_EVENT) ? pastedTextAsOneBlock : pastedTextAsBlocks
                const { insert, replacesLine } = place(text, target)
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
        const block = blocks.find((b) => index > b.start && index < b.end)
        // A code line short of its fence column (an empty line another tool wrote without the column's
        // spaces) takes the fragment, one line or several, as a padded line would: the spaces it lacks go
        // before the first line. Padded by the fence guard after the paste instead, the fragment's own
        // indentation would fill the gap to the column and the code would lose it.
        // Only a short line lacks spaces: inside a block a line left of the column is always blank (a
        // non-blank one would have ended the block), so the caret on it is short of the column too.
        const pad = block && text !== '' && lineIndent(line.text) < block.fenceColumn ? ' '.repeat(block.fenceColumn - (from - line.from)) : ''
        if (!multiLine && !pad) return tr
        // Inside a fence the clamp is the fence column (a code line's, not where the caret can rest: on
        // an empty line that is column 0), whatever the code line looks like; on a bullet-shaped line
        // outside one (a form-1 opener) the content column; in prose and the frontmatter, 0.
        const clamp = block ? block.fenceColumn : isBulletLine(line.text) ? contentColumn(line.text) : clampColumn(lines, index)
        let insert = pad + clampPastedText(text, clamp)
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
