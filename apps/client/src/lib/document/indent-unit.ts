/**
 * The **Indent Unit** (CONTEXT.md; ADR 0067): one level of [[Block]] nesting is two spaces in the
 * markdown source, for every knowledge graph. There is no per-graph setting - [[Import]] and paste
 * normalise foreign text onto the grid, the editor writes it, and text on any other grid (a
 * four-space vault, a tab-indented Logseq page, a file edited in another tool) is read
 * **structurally**: a bullet is a child of the nearest open bullet with a strictly smaller indent
 * and a sibling of one with an equal indent. That one walk is shared by the normaliser, the block
 * model and the editor's per-line depth, so import, index and rendering can never disagree about
 * what is a child of what.
 *
 * Only `-` bullets are nodes here, as everywhere in EtherPK. Fenced code and [[Frontmatter]] are
 * opaque: a `- item` inside them is code or YAML, and a fenced block travels whole with the bullet
 * that owns it.
 *
 * Two measures of leading whitespace, one per side of the boundary. The **normaliser** measures
 * **columns**, a tab advancing to the next multiple of four as CommonMark reads it — that is what
 * makes a tab-indented Logseq page or a mixed vault come out right. The **editor and the block
 * model** measure **characters**, because everything else in the editor does (the guides, the
 * keymap's branch and sibling primitives, the caret clamp, a fence's column): one measure inside
 * the editor is what keeps the clamp, the guides and the keys reading the same tree from the same
 * text, and text that has been through the boundary holds no tabs, so the two measures agree on
 * it. A tab-indented file that reaches the editor unnormalised is read as a consistent
 * one-character grid.
 */

import { frontmatterLines } from '$lib/storage/fs/frontmatter-span'

import { type FencedBlockRange, fencedBlocks } from './fenced-code'

/** Spaces per nesting level in the markdown source. */
export const INDENT_UNIT = 2

/** The Indent Unit as text - what Tab inserts. */
export const INDENT = ' '.repeat(INDENT_UNIT)

/** Width of the `- ` marker, which sets a bullet's content column (`indent + MARKER_WIDTH`). */
const MARKER_WIDTH = 2

/** A tab advances to the next multiple of this column, as CommonMark reads it. */
const TAB_STOP = 4

/** Whether the line is a `- ` bullet or task, tolerant of leading whitespace of either kind. */
function isBullet(line: string): boolean {
    return /^[ \t]*-\s/.test(line)
}

/** A heading line, tolerant of leading whitespace — a node in its own right, never a continuation. */
function isHeading(line: string): boolean {
    return /^[ \t]*#{1,6}\s/.test(line)
}

/** Whether the line is whitespace-only (an empty line included). */
function isBlank(line: string): boolean {
    return line.trim() === ''
}

/** The leading spaces and tabs of a line. */
function leading(line: string): string {
    return /^[ \t]*/.exec(line)![0]
}

/** The width of a line's leading whitespace in columns, tabs advancing to the next tab stop. */
export function indentColumns(line: string): number {
    let col = 0
    for (const ch of leading(line)) col = ch === '\t' ? col + TAB_STOP - (col % TAB_STOP) : col + 1
    return col
}

/** The width of a line's leading whitespace in characters — the editor's measure (module comment). */
function indentChars(line: string): number {
    return leading(line).length
}

/** How a walk measures leading whitespace. */
type Measure = (line: string) => number

/** One line's place in the outline, as the walk reads it. */
export interface OutlineLine {
    /**
     * Nesting depth of the line's node, or of the node that owns it. A top-level bullet or prose
     * line is 0; a continuation line, a fenced code line and an indented soft line take their
     * owner's depth. Lines outside any node (a bare blank line, frontmatter) are 0.
     */
    depth: number
    /** 0-based index of the **bullet** whose block this line belongs to (a bullet owns itself), or -1. */
    owner: number
}

interface Node {
    /** The raw indent this node was read at, in columns. */
    raw: number
    /** The indent it is written at once normalised. */
    written: number
    depth: number
    /** Line index of the node's bullet, or -1 for a prose node. */
    bullet: number
}

interface Visit {
    depth: number
    owner: number
    /** Columns to shift the line (and, for a fenced block, every line of it) onto the grid. */
    delta: number
    /** Lines this visit covers: a fenced block's whole extent from its opener, else 1. */
    span: number
}

/**
 * The structural walk under both {@link outlineLines} and {@link normaliseIndentUnit}: visits each
 * line in order with the node stack resolved, reporting the line's owner (the nearest open bullet
 * whose block the line is inside) and the delta that would put it on the grid.
 *
 * Nodes are bullets and **unowned** non-blank lines (prose, headings): a deeper plain line nests
 * under the plain line before it, as the block model has always read it, but a plain line never
 * owns a fenced block or a soft line - only a bullet does. A non-bullet, non-heading line that sits
 * at or past the nearest open bullet's content column is that bullet's [[Continuation Line]] and is
 * not a node; a heading is always a node, as the outliner's boundary rules read it.
 * A blank line pops what it is shallower than and belongs to what remains, so an indented soft line
 * stays inside its block while a flush-left empty line closes every open branch (indent decides,
 * ADR 0021). Fenced blocks are visited as one unit at the opener; frontmatter lines are visited as
 * depth-0 lines owned by nothing.
 */
function walk(lines: readonly string[], blocks: readonly FencedBlockRange[], measure: Measure, visit: (index: number, info: Visit) => void): void {
    const starts = new Map<number, FencedBlockRange>()
    for (const b of blocks) starts.set(b.start, b)
    const stack: Node[] = []
    const top = (): Node | null => (stack.length ? stack[stack.length - 1] : null)
    const popTo = (indent: number) => {
        while (stack.length && stack[stack.length - 1].raw >= indent) stack.pop()
    }
    /** The nearest open bullet on the stack, or null when only prose nodes (or nothing) remain. */
    const owningBullet = (): Node | null => {
        for (let k = stack.length - 1; k >= 0; k--) if (stack[k].bullet >= 0) return stack[k]
        return null
    }
    const first = frontmatterLines(lines)
    for (let i = 0; i < first; i++) visit(i, { depth: 0, owner: -1, delta: 0, span: 1 })
    for (let i = first; i < lines.length; i++) {
        const line = lines[i]
        const block = starts.get(i)
        const span = block ? block.end - i + 1 : 1
        const indent = measure(line)
        popTo(indent)
        if (isBlank(line) && !block) {
            // Indent decides: what this blank is not shallower than owns it.
            const owner = owningBullet()
            visit(i, { depth: top()?.depth ?? 0, owner: owner ? owner.bullet : -1, delta: owner ? owner.written - owner.raw : 0, span })
            continue
        }
        if (isBullet(line)) {
            const parent = top()
            const node: Node = { raw: indent, written: parent ? parent.written + INDENT_UNIT : 0, depth: stack.length, bullet: i }
            stack.push(node)
            visit(i, { depth: node.depth, owner: i, delta: node.written - node.raw, span })
            i += span - 1 // a form-1 opener's fence lines travel with the bullet
            continue
        }
        const parent = top()
        if (parent && parent.bullet >= 0 && indent >= parent.raw + MARKER_WIDTH && !isHeading(line)) {
            // A continuation line (a soft line, a form-2 fenced block) inside the bullet's block. A heading
            // is never one: the outliner reads it as a boundary wherever it sits, and so does this walk.
            visit(i, { depth: parent.depth, owner: parent.bullet, delta: parent.written - parent.raw, span })
            i += span - 1
            continue
        }
        if (block) {
            // A fenced block owned by no bullet (top-level code, code under a prose line) is verbatim
            // text, not a node, and is never moved.
            visit(i, { depth: parent ? parent.depth + 1 : 0, owner: -1, delta: 0, span })
            i += span - 1
            continue
        }
        // A prose node: written where it was read - a plain line's indent is never rewritten, since
        // at four columns outside a list it is an indented code block in CommonMark.
        const node: Node = { raw: indent, written: indent, depth: stack.length, bullet: -1 }
        stack.push(node)
        visit(i, { depth: node.depth, owner: -1, delta: 0, span })
    }
}

/**
 * Per-line depth and owner for every line of the document ({@link OutlineLine}), measured in
 * characters as the editor and the block model measure (module comment).
 */
export function outlineLines(lines: readonly string[], blocks: readonly FencedBlockRange[] = fencedBlocks(lines)): OutlineLine[] {
    const out = new Array<OutlineLine>(lines.length)
    walk(lines, blocks, indentChars, (i, { depth, owner, span }) => {
        for (let k = i; k < i + span; k++) out[k] = { depth, owner }
    })
    return out
}

/**
 * Rewrite a line's leading whitespace: the part of it lying within the first `within` columns is
 * re-measured (a tab advancing to its stop) and written as spaces, shifted by `delta` and floored
 * at column 0; whatever leading whitespace lies beyond `within` is kept verbatim. Every line
 * outside a fence passes `Infinity`: its whole indent becomes columns. Inside a fenced block
 * `within` is the fence column, so the structural indent up to the fence is put in spaces (a
 * fence pairs only with a closer at its own column, and a moved block must keep pairing) while a
 * tab in the code itself, past the fence column, stays a tab.
 */
function relead(line: string, within: number, delta: number): string {
    let col = 0
    let chars = 0
    for (const ch of leading(line)) {
        if (col >= within) break
        col = ch === '\t' ? col + TAB_STOP - (col % TAB_STOP) : col + 1
        chars++
    }
    return ' '.repeat(Math.max(0, col + delta)) + line.slice(chars)
}

/**
 * The document with every bullet on the Indent Unit grid: each bullet one unit under its parent
 * (a top-level bullet at column 0, over-nesting collapsed), its continuation lines, soft lines and
 * fenced block moved by the same amount so their indentation beyond the content column is kept
 * (an indented code block inside a bullet stays code). Tabs in leading whitespace become columns
 * (inside a fenced block only up to the fence column: a tab in the code is code); a line owned
 * by no bullet keeps its indent otherwise. Frontmatter is never touched. A document already on
 * the grid comes back byte-identical, so callers may compare by reference.
 */
export function normaliseIndentUnit(text: string): string {
    const lines = text.split('\n')
    const out = lines.slice()
    const frontmatter = frontmatterLines(lines)
    let changed = false
    walk(lines, fencedBlocks(lines), indentColumns, (i, { delta, span }) => {
        if (i < frontmatter) return // YAML: every indent is metadata
        const within = span > 1 ? indentColumns(lines[i]) : Infinity
        for (let k = i; k < i + span; k++) {
            const next = relead(out[k], within, delta)
            if (next !== out[k]) {
                out[k] = next
                changed = true
            }
        }
    })
    return changed ? out.join('\n') : text
}
