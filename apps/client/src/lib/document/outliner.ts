/**
 * Pure, line-based outliner logic (ADR 0016, ADR 0021, Dual Mode Editor.md). The
 * keyboard layer (view/outliner-keymap.ts) translates these into CodeMirror
 * transactions; keeping the logic pure makes it node-testable and is exactly how AS
 * Notes' `OutlinerService` works — indent/outdent are text manipulation, not index reads.
 *
 * "Branch" = a bullet line plus everything more indented than it (its descendants and
 * continuation lines). All operations act on the whole branch, and are **confined to
 * the caret's [[Outliner Block Group]]** (ADR 0021): the maximal contiguous bullet/task
 * tree, bounded by a heading, prose, or a blank line above/below the group. A
 * [[Fenced Code Block]] is treated as **opaque** — its internal blank lines never end a
 * branch or bound a group.
 */

import { frontmatterLines } from '$lib/storage/fs/frontmatter-span'

import { type FencedBlockRange, fencedBlocks, fencedBlocksAtLine, fencedBlockTree } from './fenced-code'
import { INDENT_UNIT, type OutlineLine, outlineLines } from './indent-unit'

/**
 * Width of the bullet marker that sets the content column: `- ` is always 2 chars. It is a
 * different constant from the [[Indent Unit]] (the nesting step, `indent-unit.ts`) even though
 * both are 2 (ADR 0020, ADR 0067). The content column is the clamp anchor — "one space right
 * of the bullet".
 */
export const MARKER_WIDTH = 2

export function lineIndent(line: string): number {
    return line.length - line.trimStart().length
}

/**
 * The column to which a block's content (continuation lines, code, widgets) is clamped:
 * a bullet line's leading indent + {@link MARKER_WIDTH}; a non-bullet line's own leading
 * indent. Marker-based, *not* nesting-based — the same on text off the Indent Unit grid.
 */
export function contentColumn(line: string): number {
    return isBulletLine(line) ? lineIndent(line) + MARKER_WIDTH : lineIndent(line)
}

export function isBulletLine(line: string): boolean {
    return /^-\s/.test(line.trimStart())
}

/** A bullet whose content is `[ ]` / `[x]`; undefined if not a task. */
export function taskDone(line: string): boolean | undefined {
    const m = /^-\s+\[([ xX])\]/.exec(line.trimStart())
    return m ? m[1].toLowerCase() === 'x' : undefined
}

/** Length of the bullet marker incl. its trailing space: `- ` (2) or `- [ ] ` (6). */
export function markerLength(line: string): number {
    const indent = lineIndent(line)
    const rest = line.slice(indent)
    const task = /^-\s+\[[ xX]\]\s?/.exec(rest)
    if (task) return task[0].length
    const bullet = /^-\s/.exec(rest)
    return bullet ? bullet[0].length : 0
}

/** Offset of a line's content: past its indent and, on a bullet, past the `- ` / `- [ ] ` marker. */
export function contentStart(line: string): number {
    return lineIndent(line) + markerLength(line)
}

/** The bullet's content (everything after the marker). `""` for an empty bullet. */
export function bulletContent(line: string): string {
    return line.slice(contentStart(line))
}

/** The marker to start a *new* sibling of this line: `- ` for a bullet, `- [ ] ` for a task. */
export function newBulletMarker(line: string): string {
    return taskDone(line) === undefined ? '- ' : '- [ ] '
}

/** A heading line (`#`…`######` + space), tolerant of leading indent — matches the block model. */
export function isHeadingLine(line: string): boolean {
    return /^#{1,6}\s/.test(line.trimStart())
}

/**
 * Per-line flags: is line `k` **opaque** to the outliner - inside a complete fenced block
 * (opener…closer inclusive), or inside the document's [[Frontmatter]]? Both are verbatim text a
 * scan must never read structure from: a `- item` in code is code, and a `- item` in a YAML
 * list is metadata (Editor Content Rules → Fenced blocks are opaque; ADR 0061).
 */
export function opaqueLineFlags(lines: string[], blocks: FencedBlockRange[]): boolean[] {
    const flags = new Array<boolean>(lines.length).fill(false)
    for (const b of blocks) for (let k = b.start; k <= b.end; k++) flags[k] = true
    for (let k = frontmatterLines(lines) - 1; k >= 0; k--) flags[k] = true
    return flags
}

/**
 * The line indices of the form-1 openers (`- \`\`\`py`): a fence opening on a bullet line in the body,
 * outside any other block's code. The opener is that bullet, not fenced content, as the outline walk
 * reads it, so a scan that steps over opaque lines must stop at one. An opener inside another block's
 * code stays code, and one in the [[Frontmatter]] stays YAML: the walk reads no bullet there.
 */
export function formOneOpeners(lines: readonly string[], blocks: readonly FencedBlockRange[]): Set<number> {
    const body = frontmatterLines(lines)
    const { sorted, parent } = fencedBlockTree(blocks) // an outermost block has no block around it
    return new Set(sorted.filter((b, i) => parent[i] < 0 && b.start >= body && isBulletLine(lines[b.start])).map((b) => b.start))
}

/** Map from a fenced block's opener line index to the block, for O(1) "does a fence start here?". */
function fenceStartMap(blocks: FencedBlockRange[]): Map<number, FencedBlockRange> {
    const m = new Map<number, FencedBlockRange>()
    for (const b of blocks) m.set(b.start, b)
    return m
}

/**
 * The branch rooted at line `i`: `i` plus all following lines more indented than it — its
 * descendants and continuation lines. **Fence-opaque** (ADR 0021): a fenced block deeper than the
 * root is swallowed whole, so its internal blank lines don't truncate the branch. **Indent decides
 * blankness** (ADR 0021): a whitespace-only line is judged by its indentation like any other line —
 * an indented soft line stays in the branch; a flush-left empty line (or one at/left of the root)
 * ends it, as do a heading and any same-or-shallower content line.
 */
export function branchRange(lines: string[], i: number, blocks: FencedBlockRange[] = fencedBlocks(lines)): { start: number; end: number } {
    const root = lineIndent(lines[i])
    const starts = fenceStartMap(blocks)
    const own = starts.get(i) // `i` itself may open a fence (a `- ``` ` form-1 bullet)
    let end = own ? own.end : i
    let j = end + 1
    while (j < lines.length) {
        const b = starts.get(j)
        if (b) {
            if (lineIndent(lines[b.start]) > root) {
                end = b.end
                j = b.end + 1
                continue // a fenced block indented deeper than the root belongs to the branch — jump it whole
            }
            break // a fence opener at (or left of) the root indent is a sibling/boundary (e.g. a `- ``` ` sibling)
        }
        const line = lines[j]
        if (isHeadingLine(line)) break
        if (lineIndent(line) <= root) break // covers a bare blank too: lineIndent('') is 0
        end = j
        j++
    }
    return { start: i, end }
}

/**
 * The roots of the branches within lines `[first, last]`: every bullet line in the span that is not
 * inside an earlier root's branch. A block selection's Tab and Shift-Tab act on these together. A
 * blank, prose or heading line in the span is nobody's root; a branch whose descendants run past
 * `last` is still whole — a branch is never split by where a selection stopped.
 */
export function branchRootsWithin(lines: string[], first: number, last: number): number[] {
    const roots: number[] = []
    for (let j = first; j <= last; ) {
        if (!isBulletLine(lines[j])) {
            j++
            continue
        }
        roots.push(j)
        j = branchRange(lines, j).end + 1
    }
    return roots
}

/**
 * A branch may indent only if it has a previous sibling within its [[Outliner Block Group]] to nest
 * under (ADR 0021). The first bullet at its level — whose predecessor is its own parent, a heading,
 * prose, or nothing — cannot indent.
 */
export function canIndent(lines: string[], i: number, blocks: FencedBlockRange[] = fencedBlocks(lines)): boolean {
    return prevSiblingRange(lines, i, blocks) !== null
}

/**
 * A bullet may outdent while it is indented at all: Shift+Tab lands it on its parent's indent
 * (or column 0 when it has no parent bullet), whatever grid it sits on — one press is one level
 * on foreign four-space text too (ADR 0067). At column 0 the outdent leaves the list instead.
 */
export function canOutdent(lines: string[], i: number): boolean {
    return lineIndent(lines[i]) > 0
}

/**
 * The indent Shift+Tab takes the bullet at `i` to: its parent bullet's indent, or column 0 for a
 * group's first bullet that sits indented after a blank line (the allowable orphan).
 */
export function outdentTarget(lines: string[], i: number, blocks: FencedBlockRange[] = fencedBlocks(lines)): number {
    const parent = parentIndex(lines, i, blocks)
    return parent === null ? 0 : lineIndent(lines[parent])
}

/** A number of leading characters to remove from one line. */
export interface LineCut {
    line: number
    count: number
}

/**
 * Leaving the list from the bullet at column 0 on line `root` (Shift+Tab past the root, and the bullet
 * toggle): how many leading characters each line of its branch loses. The root loses its marker and
 * any checkbox. Its own continuation lines and code block lose up to the marker's width, so they come
 * to column 0 with it. Each child loses its own indent, its subtree with it, so it comes up one level
 * and none is left under a prose line: a four-space child lands at column 0 too, and on a ragged grid
 * a later, shallower child keeps its own lines under it. A line after the children that is no deeper
 * than the child before it (a paragraph after the sublist) is the root's own, and goes to the margin
 * with it. A fenced block moves as a unit with the line it belongs to. No line is added or removed,
 * so every line keeps its index.
 */
export function leaveListCuts(lines: string[], root: number, blocks: FencedBlockRange[] = fencedBlocks(lines)): LineCut[] {
    const { end } = branchRange(lines, root, blocks)
    const bodyEnd = blockBodyEnd(lines, root, blocks)
    const starts = fenceStartMap(blocks)
    const cuts: LineCut[] = [{ line: root, count: lineIndent(lines[root]) + markerLength(lines[root]) }]
    const cut = (j: number, columns: number) => {
        const count = Math.min(lineIndent(lines[j]), columns)
        if (count > 0) cuts.push({ line: j, count })
    }
    for (let j = root + 1; j <= bodyEnd; j++) cut(j, MARKER_WIDTH)
    // One pass over the children, read as branchRange reads a branch: a bullet no deeper than the
    // current child starts the next child, a deeper line belongs to the current child, and a line no
    // deeper than it that is not a bullet is the root's own.
    let child = -1 // the indent of the child whose subtree is being cut, or -1 between children
    for (let j = bodyEnd + 1; j <= end; ) {
        const indent = lineIndent(lines[j])
        if (isBulletLine(lines[j]) && (child < 0 || indent <= child)) child = indent
        else if (indent <= child) child = -1
        const last = starts.get(j)?.end ?? j
        for (let k = j; k <= last; k++) cut(k, child < 0 ? MARKER_WIDTH : child)
        j = last + 1
    }
    return cuts
}

/**
 * Whether the bullet at column 0 on line `root` may leave the list: whether every fenced block keeps
 * the pairing it has, and the frontmatter keeps its extent, once the lines move. The bullet's text can
 * be a fence or a `---`, and its own code block moves to the margin with it. At the margin a fence
 * pairs with another fence there and a `---` can close a frontmatter block, which would turn prose
 * into code, code into prose, or body text into metadata (Editor Content Rules → Shift+Tab past the
 * root). A form-1 bullet may leave, since its fences move to column 0 together and stay paired.
 * `blocks` is the pairing of `lines` when the caller already holds it, to spare a scan: the editor
 * analysis's, while it holds no pending fence. The lines after the cuts are always scanned afresh,
 * because a line can stop closing a fence anywhere above it (an empty root becomes a blank line).
 */
export function canLeaveList(lines: string[], root: number, blocks: FencedBlockRange[] = fencedBlocks(lines)): boolean {
    const after = lines.slice()
    for (const { line, count } of leaveListCuts(lines, root, blocks)) after[line] = after[line].slice(count)
    const pairs = (bs: readonly FencedBlockRange[]) => bs.map((b) => `${b.start}:${b.end}`).join(' ')
    return pairs(fencedBlocks(after)) === pairs(blocks) && frontmatterLines(after) === frontmatterLines(lines)
}

/**
 * The minimum indent a non-bullet line may outdent to: if it is a continuation line under a bullet
 * (the nearest shallower line above is a bullet), its owning bullet's content column
 * (`bulletIndent + MARKER_WIDTH`) — content can't cross left of the "bullet + space" boundary. For a
 * standalone prose line (no owning bullet) the floor is 0.
 */
export function continuationFloor(lines: string[], i: number): number {
    const myIndent = lineIndent(lines[i])
    for (let j = i - 1; j >= 0; j--) {
        if (lines[j].trim() === '') continue
        const ind = lineIndent(lines[j])
        if (ind >= myIndent) continue // a sibling/child above doesn't own this line
        return isBulletLine(lines[j]) ? ind + MARKER_WIDTH : 0 // shallower bullet → its content column; else prose
    }
    return 0
}

/** Toggle the task state of a bullet line, cycling plain → `[ ]` → `[x]` → plain. */
export function cycleTask(line: string): string {
    const indent = line.slice(0, lineIndent(line))
    const rest = line.slice(lineIndent(line))
    if (!/^-\s/.test(rest)) return line // not a bullet — leave it
    const done = taskDone(line)
    if (done === undefined) {
        // plain bullet → unchecked task
        return indent + rest.replace(/^-\s+/, '- [ ] ')
    }
    if (done === false) {
        // unchecked → checked
        return indent + rest.replace(/^(-\s+)\[ \]/, '$1[x]')
    }
    // checked → plain bullet
    return indent + rest.replace(/^(-\s+)\[[xX]\]\s?/, '$1')
}

/**
 * The previous **bullet** sibling's branch, or null. Siblings are bullets with the **same parent**
 * (ADR 0067: a bullet is a child of the nearest shallower bullet, so two children of one parent are
 * siblings whatever their own indents — over-nested text included), contiguous within the
 * [[Outliner Block Group]]. A heading, a bare blank line, the parent itself, or prose at the root's
 * indent all end the sibling list — they bound the group (ADR 0021). Fence-internal blanks are skipped.
 * On text on the grid this is exactly "the nearest earlier bullet at the same indent".
 *
 * A fenced block reads as one line at its opener's indent, as prose does: deeper than the root it is
 * inside a branch above, and at or left of the root it ends the list. A code block at the margin is
 * prose that ends the group, and a parent's own block between two children closes the one above, as
 * the outline walk reads both. Read across, Tab nested a bullet the boundary normaliser then took for
 * an orphan, and Alt+Up rebuilt the two branches without the block between them.
 */
export function prevSiblingRange(
    lines: string[],
    i: number,
    blocks: FencedBlockRange[] = fencedBlocks(lines),
): { start: number; end: number } | null {
    const root = lineIndent(lines[i])
    const inFence = opaqueLineFlags(lines, blocks)
    const bulletOpeners = formOneOpeners(lines, blocks)
    const parent = parentIndex(lines, i, blocks)
    for (let j = i - 1; j >= 0; j--) {
        if (parent !== null && j <= parent) return null // reached the parent — nothing above it is a sibling
        const line = lines[j]
        if (line.trim() === '') {
            if (inFence[j]) continue // a blank inside a fenced block is not a boundary
            if (lineIndent(line) > root) continue // an indented soft line — part of a block above (indent decides)
            return null // a bare blank at/left of the root bounds the group
        }
        // Fenced content is opaque: a `# comment` or `- item` in code is neither a heading nor a bullet.
        // A form-1 opener is a bullet, a sibling like any other, and its code block moves with it.
        if (inFence[j] && !bulletOpeners.has(j)) {
            // The block as a whole (the outermost, for a code sample) is a line at its opener's indent.
            // The frontmatter has no block: it bounds the group, as it always sits above the body.
            const around = fencedBlocksAtLine(blocks, j)
            if (!around) return null
            const opener = around.outer.start
            if (bulletOpeners.has(opener)) {
                j = opener + 1 // a form-1 block: its opener, next up, is the bullet itself
                continue
            }
            const ind = lineIndent(lines[opener])
            if (ind > root || (ind < root && isContinuationLine(lines, opener))) {
                j = opener // deeper, or a soft line of a bullet further up: step over the block
                continue
            }
            return null
        }
        if (isHeadingLine(line)) return null
        const ind = lineIndent(line)
        if (!isBulletLine(line)) {
            if (ind > root) continue // deeper prose — a continuation inside some branch above
            if (ind < root && isContinuationLine(lines, j)) continue // a soft line of a bullet further up (foreign grid)
            return null // prose at or left of the root's indent bounds the group
        }
        if (ind < root) return null // unreachable past the parent check; a shallower bullet is an ancestor
        if (parentIndex(lines, j, blocks) === parent) return branchRange(lines, j, blocks)
        // a deeper bullet inside an earlier sibling's branch; keep scanning up
    }
    return null
}

/**
 * The next **bullet** sibling's branch, or null: the bullet right after this branch when it has the
 * same parent (see {@link prevSiblingRange}). A heading, a bare blank line, or a prose line ends the
 * list; a bullet shallower than the parent is the parent's sibling, not this one's.
 */
export function nextSiblingRange(
    lines: string[],
    i: number,
    blocks: FencedBlockRange[] = fencedBlocks(lines),
): { start: number; end: number } | null {
    const { end } = branchRange(lines, i, blocks)
    const j = end + 1
    if (j >= lines.length) return null
    const line = lines[j]
    // A blank here is a boundary: in-branch soft lines (indent > root) were consumed by branchRange,
    // so any blank left over sits at/left of the root — a bare group separator (indent decides).
    if (line.trim() === '') return null
    if (isHeadingLine(line) || !isBulletLine(line)) return null
    return parentIndex(lines, j, blocks) === parentIndex(lines, i, blocks) ? branchRange(lines, j, blocks) : null
}

/**
 * Whether line `index` may merge its content up onto the line directly above (ADR 0021, Logseq-style):
 * true iff that line is a mergeable member of the same [[Outliner Block Group]] — a bullet or a
 * continuation line. A bare/fence-internal blank, a heading, fenced-code content, or standalone prose
 * are group boundaries and are refused (the merge never crosses them).
 */
export function mergeTargetAbove(lines: string[], index: number, blocks: FencedBlockRange[] = fencedBlocks(lines)): boolean {
    if (index < 1) return false
    const inFence = opaqueLineFlags(lines, blocks)
    const above = lines[index - 1]
    if (inFence[index - 1]) return false // fenced-code content/closer — never append onto it
    if (isHeadingLine(above)) return false
    if (isBulletLine(above)) return true
    // A continuation line. Indent decides for a blank one: an indented soft line is part of its block
    // and can take the merged text as its content; a bare empty line, or one short of the content
    // column, bounds the group.
    return continuationColumn(lines, index - 1, outlineLines(lines, blocks)) > 0
}

/**
 * Whether merging away the bullet at `removedIdx` — its line disappears and its content joins a line at
 * `targetIndent` — would **strand** its first child (ADR 0021): leave that child more than one Indent
 * Unit below the merge target, with no parent at the right depth (a level jump). Used to refuse
 * Backspace/Delete merges that would orphan a subtree. A block with no child never strands. Measured
 * on the grid, so on foreign text (a four-space child) a merge is refused that two-space text would
 * allow — the safe side, until the branch is touched (ADR 0067).
 */
export function mergeWouldStrand(lines: string[], removedIdx: number, targetIndent: number): boolean {
    const childIdx = removedIdx + 1
    if (childIdx >= lines.length) return false
    const child = lines[childIdx]
    if (child.trim() === '') return false
    const childIndent = lineIndent(child)
    if (childIndent <= lineIndent(lines[removedIdx])) return false // next line is a sibling/shallower, not a child
    return childIndent - targetIndent > INDENT_UNIT
}

/** Whether line `k` is a plain text line whose content can be pulled up by a forward (Delete) merge. */
export function isMergeableSource(lines: string[], k: number, blocks: FencedBlockRange[] = fencedBlocks(lines)): boolean {
    if (k < 0 || k >= lines.length) return false
    const inFence = opaqueLineFlags(lines, blocks)
    if (inFence[k] || isHeadingLine(lines[k])) return false
    if (isBulletLine(lines[k])) return true
    // A continuation line. An indented soft line can be pulled up (the join simply removes it); a bare
    // empty line, or one short of the content column, bounds.
    return continuationColumn(lines, k, outlineLines(lines, blocks)) > 0
}

/**
 * Re-indent lines `[start, end]` so no line sits more than one nesting level below its nearest shallower
 * ancestor — removing the orphan **level-jumps** a delete can leave (ADR 0021). A jumped line (and, via the
 * running stack, its descendants) is pulled left to exactly one level under its parent; well-formed lines
 * are untouched. Headings reset the ancestry; fenced-code interiors are left verbatim. `base` is the
 * deepest indent a line with no ancestor in the range may keep: 0, unless the range starts at a line
 * whose own ancestors sit above it, as a prose line just made a block does.
 */
export function healOrphanIndent(lines: string[], start: number, end: number, blocks: FencedBlockRange[] = fencedBlocks(lines), base = 0): string[] {
    const out = lines.slice()
    const inFence = opaqueLineFlags(lines, blocks)
    const starts = fenceStartMap(blocks)
    const stack: { raw: number; corr: number; bullet: boolean }[] = [] // ancestry: raw (source) indent + corrected indent
    // A fenced block moves with the line it hangs under, as a unit, so its fences stay paired: the
    // whole block by the owner's correction (a form-2 fence under a bullet), or by the opener's own
    // correction when the opener is the bullet line (form-1).
    const shiftBlock = (b: FencedBlockRange, first: number, delta: number) => {
        if (delta === 0) return
        for (let k = first; k <= b.end && k <= end; k++) out[k] = ' '.repeat(Math.max(0, lineIndent(out[k]) + delta)) + out[k].trimStart()
    }
    let lastDelta = 0 // the correction applied to the most recent node line
    for (let i = start; i <= end && i < out.length; i++) {
        const line = out[i]
        const block = starts.get(i)
        if (block && !isBulletLine(line)) {
            // A form-2 block: content, not a node. It follows its owner.
            shiftBlock(block, i, lastDelta)
            i = block.end
            continue
        }
        if (line.trim() === '' || (inFence[i] && !block)) continue
        if (isHeadingLine(line)) {
            stack.length = 0
            continue
        }
        const ind = lineIndent(line)
        while (stack.length && stack[stack.length - 1].raw >= ind) stack.pop()
        const parent = stack.length ? stack[stack.length - 1] : null
        // A non-bullet line at or past the nearest bullet's content column is that bullet's continuation,
        // as the outline walk reads it: it moves with its bullet and is no parent a deeper line may hang
        // under (a soft line at the content column would otherwise let a child sit two levels down).
        if (parent?.bullet && !isBulletLine(line) && ind >= parent.raw + MARKER_WIDTH) {
            const delta = parent.corr - parent.raw
            if (delta !== 0) out[i] = ' '.repeat(Math.max(0, ind + delta)) + line.slice(ind)
            continue
        }
        const allowed = parent === null ? base : parent.corr + INDENT_UNIT // deepest valid indent for a child here
        const corr = Math.min(ind, allowed)
        if (corr !== ind) out[i] = ' '.repeat(corr) + line.slice(ind)
        lastDelta = corr - ind
        stack.push({ raw: ind, corr, bullet: isBulletLine(line) })
        if (block) {
            // A form-1 block: the bullet line is the node; its fence lines follow it.
            shiftBlock(block, i + 1, lastDelta)
            i = block.end
        }
    }
    return out
}

/**
 * The outline after a multi-line deletion, healed (ADR 0021): a whitespace-only artifact line left
 * at the join is removed, and every block in the caret's group that the deletion left more than one
 * level below its nearest surviving ancestor is pulled up to one level under it ({@link healOrphanIndent}),
 * its subtree and any fenced block moving with it. `caretLine` is the 0-based line the deletion
 * point sits on. Shared by the keymap's Backspace/Delete and the cut handler, so both leave the same
 * shape behind.
 */
export function healAfterRangeDelete(lines: string[], caretLine: number): { lines: string[]; caretLine: number } {
    let out = lines.slice()
    let at = Math.min(caretLine, out.length - 1)
    // A blank line against the [[Frontmatter]] is not an artifact. Inside the block it is YAML,
    // which the outline never edits; as the whole of the body it is where the caret belongs.
    // Removing either puts the caret at the start of the closing delimiter, where the next
    // keystroke unmakes the block and its `title:` becomes body text. Select all in either region
    // followed by Backspace, Delete or a cut is what leaves one.
    const body = frontmatterLines(out)
    const againstFrontmatter = at < body || (at === body && at === out.length - 1)
    if (!againstFrontmatter && out[at]?.trim() === '' && out.length > 1) {
        out.splice(at, 1)
        if (at >= out.length) at = out.length - 1
    }
    const blocks = fencedBlocks(out)
    const { start, end } = healSpan(out, at, blocks)
    out = healOrphanIndent(out, start, end, blocks)
    return { lines: out, caretLine: at }
}

/**
 * {@link healOrphanIndent} over `[start, end]` with line `masked` read as blank, so it is nobody's parent,
 * then put back as it was. A prose line is a node the walk lets a deeper line nest under (`Shopping:` over
 * `  - eggs`), so only the line a deletion just made prose is masked, never the prose around it.
 */
export function healAroundMasked(lines: string[], masked: number, start: number, end: number, blocks: FencedBlockRange[] = fencedBlocks(lines)): string[] {
    const input = lines.slice()
    input[masked] = ''
    const out = healOrphanIndent(input, start, end, blocks)
    out[masked] = lines[masked]
    return out
}

/**
 * Whether deleting from line `first` to column `toCol` of line `last` takes a bullet's marker into a
 * prose line: the range starts on a line that is neither a bullet nor a continuation, and ends on a
 * bullet past its indent. The bullet's text joins that line, so the bullet leaves the list as the bullet
 * button makes one prose ({@link cutsAfterBulletIntoProse}). A range starting in another bullet's text
 * merges the two blocks instead, and is not one of these.
 */
export function joinsBulletIntoProse(lines: string[], first: number, last: number, toCol: number, blocks: FencedBlockRange[] = fencedBlocks(lines)): boolean {
    if (last <= first) return false
    const inFence = opaqueLineFlags(lines, blocks)
    if (inFence[first] || (inFence[last] && !formOneOpeners(lines, blocks).has(last))) return false
    if (!isBulletLine(lines[last]) || toCol <= lineIndent(lines[last])) return false
    return !isBulletLine(lines[first]) && !isContinuationLine(lines, first)
}

/**
 * What a deletion that takes a bullet at column 0 into a prose line ({@link joinsBulletIntoProse}) does
 * to the lines after it, read on the text before the deletion: the bullet leaves the list as the bullet
 * button makes it prose, so its own continuation lines and code block come to the margin with its text,
 * and its children come up a level ({@link leaveListCuts}) rather than hang under the prose line. The
 * deletion itself takes the marker, so the bullet's own line is not cut here. Empty for any other
 * deletion, and where the lines at the margin would pair a fence differently ({@link canLeaveList}).
 */
export function cutsAfterBulletIntoProse(lines: string[], first: number, last: number, toCol: number, blocks: FencedBlockRange[] = fencedBlocks(lines)): LineCut[] {
    if (!joinsBulletIntoProse(lines, first, last, toCol, blocks) || lineIndent(lines[last]) > 0) return []
    if (!canLeaveList(lines, last, blocks)) return []
    return leaveListCuts(lines, last, blocks).filter((cut) => cut.line > last)
}

/** `lines` with each cut applied `shift` lines from where it was read (lines before it removed or added). */
export function applyLineCuts(lines: string[], cuts: readonly LineCut[], shift: number): string[] {
    const out = lines.slice()
    for (const { line, count } of cuts) out[line + shift] = out[line + shift].slice(count)
    return out
}

/** The span a delete heal covers around line `at`: the run of lines bounded by a blank line or a
 *  heading outside any fence (a fence's own blank or `# comment` line is opaque). Prose lines stay
 *  inside it, unlike {@link groupBounds}: bullets after a prose line are measured across it. */
export function healSpan(lines: string[], at: number, blocks: FencedBlockRange[] = fencedBlocks(lines)): { start: number; end: number } {
    const inFence = opaqueLineFlags(lines, blocks)
    const bounds = (j: number) => !inFence[j] && (lines[j].trim() === '' || isHeadingLine(lines[j]))
    let start = at
    let end = at
    while (start > 0 && !bounds(start - 1)) start--
    while (end < lines.length - 1 && !bounds(end + 1)) end++
    return { start, end }
}

/**
 * The last index of a block's own lines: its bullet line plus its [[Continuation Line]]s, stopping
 * before its first child bullet. A bullet-looking line inside a fenced block is code, not a child;
 * an unterminated opener yields no block, so a bullet after it is a child (incomplete fence ⇒ text).
 */
export function blockBodyEnd(lines: string[], owner: number, blocks: FencedBlockRange[] = fencedBlocks(lines)): number {
    const { end } = branchRange(lines, owner, blocks)
    let last = owner
    for (let j = owner + 1; j <= end; j++) {
        if (isBulletLine(lines[j]) && !blocks.some((b) => j > b.start && j <= b.end)) break
        last = j
    }
    return last
}

/** Shift lines by `delta` columns, never below column 0; blank lines keep only their (shifted) indent. */
export function shiftLines(lines: string[], delta: number): string[] {
    return lines.map((line) => ' '.repeat(Math.max(0, lineIndent(line) + delta)) + line.trimStart())
}

/** The root of the tree bullet `i` belongs to: its topmost ancestor within the group, or `i` itself. */
export function treeRootIndex(lines: string[], i: number, blocks: FencedBlockRange[] = fencedBlocks(lines)): number {
    let root = i
    for (let parent = parentIndex(lines, root, blocks); parent !== null; parent = parentIndex(lines, root, blocks)) root = parent
    return root
}

/**
 * The nearest shallower **bullet** above `i` within the group — the branch's parent — or null. Read
 * the way the outline walk reads it (indent-unit.ts, ADR 0067), so the keys and the rendering agree
 * on every grid: scanning up, a line shallower than the bullet closes every bullet at or below its
 * own indent — an indented soft line and a shallower continuation line included (indent decides,
 * ADR 0021) — so a bullet above such a line is the parent only if it is shallower than the line too.
 * A bare empty line, a heading, or standalone prose bounds the group: no parent.
 */
export function parentIndex(lines: string[], i: number, blocks: FencedBlockRange[] = fencedBlocks(lines)): number | null {
    const inFence = opaqueLineFlags(lines, blocks)
    const starts = fenceStartMap(blocks)
    const bulletOpeners = formOneOpeners(lines, blocks)
    let limit = lineIndent(lines[i]) // a parent must be shallower than this
    for (let j = i - 1; j >= 0; j--) {
        const line = lines[j]
        if (inFence[j] && !bulletOpeners.has(j)) {
            // Fenced content is opaque (a `# comment` in code is not a heading). The block as a whole
            // is a continuation of its owner though, and closes the bullets at or below its fence
            // column like any continuation line: a form-2 fence at a bullet's content column ends a
            // deeper sibling's branch above it. A form-1 opener is the bullet itself, read below.
            const block = starts.get(j)
            if (block && !isBulletLine(line)) limit = Math.min(limit, lineIndent(line))
            continue
        }
        const ind = lineIndent(line)
        if (line.trim() === '') {
            if (ind === 0) return null // a bare empty line bounds the group — no parent above it
            limit = Math.min(limit, ind) // an indented soft line closes the bullets at or below its indent
            continue
        }
        if (isHeadingLine(line)) return null
        if (ind >= limit) continue // a sibling, a descendant, or a bullet already closed — keep looking up
        if (isBulletLine(line)) return j // the nearest bullet still open and shallower: the parent
        // Shallower prose bounds the group — unless it is a continuation line of a bullet further up
        // (a four-space child sits deeper than its parent's two-column soft line): the bullets it closed
        // are not the parent; the one it belongs to, shallower still, may be.
        if (!isContinuationLine(lines, j)) return null
        limit = ind
    }
    return null
}

/**
 * Non-bullet line `j`'s continuation column: the content column of the bullet it continues, once
 * its indent reaches that column, and 0 when the line is prose (a line short of the column is
 * prose, however close). The bullet is the one the outline walk gives the line (ADR 0067), or the
 * one directly above it (`continuationFloor`), since each reaches lines the other does not: the
 * walk looks past a soft line, a `*` item or a closer to the bullet above them, and the floor looks
 * past a blank line. The caret clamp, the selection highlight and the content clamp read a line by
 * it alone. The joining, outdenting, splitting and moving keys ask it too, and take the bullet to
 * measure against from `ownerBulletIndex`, which finds the same bullet for the lines this reads as
 * continuations with two exceptions: a line after a blank line in a list, which is drawn and clamped
 * as a continuation but belongs to no block, so the keys treat it as prose; and a line after a
 * heading indented inside the block, where `ownerBulletIndex` stops. `outline` is the walk over
 * `lines`; pass the editor analysis's to spare the walk.
 */
export function continuationColumn(lines: string[], j: number, outline: readonly OutlineLine[] = outlineLines(lines)): number {
    const indent = lineIndent(lines[j])
    const info = outline[j]
    const owner = info?.owner ?? -1
    // The walk's bullet counts only for a line directly in its block, at its depth. A blank line takes
    // the nearest bullet on the walk's stack even when a prose line (one short of the column, or a
    // heading) sits nested under that bullet above it; text typed there would nest under the prose
    // line instead, and that line's depth, not the bullet's, is the blank line's. So a blank line
    // reads as the line it becomes, and typing on it never changes how it is drawn or clamped.
    if (owner >= 0 && owner !== j && !isBulletLine(lines[j]) && info.depth === outline[owner].depth) {
        const column = lineIndent(lines[owner]) + MARKER_WIDTH
        if (indent >= column) return column
    }
    const floor = continuationFloor(lines, j)
    return floor > 0 && indent >= floor ? floor : 0
}

/**
 * Whether non-bullet line `j` is a [[Continuation Line]] by the bullet directly above it: at or past
 * that bullet's content column. The tree's own parent and sibling scans ask this, not the outline
 * walk, which they are part of computing.
 */
function isContinuationLine(lines: string[], j: number): boolean {
    const floor = continuationFloor(lines, j)
    return floor > 0 && lineIndent(lines[j]) >= floor
}

/** Whether line `k` is part of an [[Outliner Block Group]] tree (a bullet, a fence line, or a continuation).
 *  A whitespace-only line counts by its indentation (indent decides): an indented soft line is a
 *  continuation of its block; a flush-left empty line is not in any tree. */
function isTreeLine(lines: string[], k: number, inFence: boolean[]): boolean {
    const line = lines[k]
    if (inFence[k]) return true // fenced content (incl. its internal blanks)
    if (line.trim() === '' && lineIndent(line) === 0) return false // a bare empty line bounds trees
    if (isHeadingLine(line)) return false
    if (isBulletLine(line)) return true
    const floor = continuationFloor(lines, k) // a non-bullet line is a continuation iff it sits at/right of its owner's content column
    return floor > 0 && lineIndent(line) >= floor
}

/**
 * The [[Outliner Block Group]] containing line `i`: the maximal contiguous run of tree lines around it
 * (ADR 0021). Bounded by a heading, prose, or a bare blank line; a fenced block's internal blanks stay
 * in the group. Assumes `i` is itself a tree line (a bullet or its continuation/fence content).
 */
export function groupBounds(lines: string[], i: number, blocks: FencedBlockRange[] = fencedBlocks(lines)): { start: number; end: number } {
    const inFence = opaqueLineFlags(lines, blocks)
    let start = i
    let end = i
    while (start - 1 >= 0 && isTreeLine(lines, start - 1, inFence)) start--
    while (end + 1 < lines.length && isTreeLine(lines, end + 1, inFence)) end++
    return { start, end }
}

/**
 * The bullet line whose branch owns line `i` — `i` itself if it is a bullet, else the nearest bullet
 * above whose branch reaches `i` and whose content column `i` sits at or past, as the outline walk
 * reads a [[Continuation Line]] (indent-unit.ts, ADR 0067). The nearest bullet above may be a closed
 * child: a paragraph after a sublist, as CommonMark and other tools write it, sits at the parent's
 * content column, and stopping at the child read it as prose (its indent stripped the moment the
 * caret left, 2026-09-22), so the scan keeps looking up past bullets that do not reach the line.
 */
export function ownerBulletIndex(lines: string[], i: number, blocks: FencedBlockRange[] = fencedBlocks(lines)): number | null {
    if (isBulletLine(lines[i])) return i
    const inFence = opaqueLineFlags(lines, blocks)
    // A form-1 opener is the bullet the block belongs to, and owns the lines after its closer.
    const bulletOpeners = formOneOpeners(lines, blocks)
    for (let j = i - 1; j >= 0; j--) {
        if (lines[j].trim() === '') {
            if (inFence[j]) continue
            if (lineIndent(lines[j]) > 0) continue // an indented soft line — inside some block (indent decides)
            return null // a bare empty line bounds the group
        }
        if (inFence[j] && !bulletOpeners.has(j)) continue // fenced content is opaque
        if (isHeadingLine(lines[j])) return null
        if (!isBulletLine(lines[j])) continue
        if (branchRange(lines, j, blocks).end < i) continue // a closed child or sibling above: not the owner
        return lineIndent(lines[i]) >= contentColumn(lines[j]) ? j : null // inside the branch, but a line shallower than the content column is prose
    }
    return null
}

function reindent(arr: string[], delta: number): string[] {
    if (delta === 0) return arr.slice()
    if (delta > 0) return arr.map((l) => ' '.repeat(delta) + l)
    return arr.map((l) => l.slice(Math.min(-delta, lineIndent(l))))
}

/** A structural move: replace source lines `[fromLine, toLine]` with `text`, landing the caret at `caretOffset` within it. */
export interface MoveEdit {
    fromLine: number
    toLine: number
    text: string
    /** Caret offset within {@link text} (0-based character offset). */
    caretOffset: number
}

/**
 * Logseq-style move (ADR 0021), confined to the caret's [[Outliner Block Group]]. `bulletIndex` is the
 * branch root; `caretLine`/`caretCol` locate the caret within that branch (which may be a continuation
 * line). One press moves the whole branch by one position:
 *
 * - a sibling that way → **jump over** its whole subtree, staying at the same depth (never dive in);
 * - no sibling that way but a parent exists → **promote** one level (out above/after the parent);
 * - no sibling and no parent (group edge) → returns null (the caller consumes the key, no motion).
 *
 * It cannot orphan: a jump only reorders whole branches at one depth; a promote outdents the branch as a
 * unit onto its parent's indent (one level on any grid, ADR 0067). Depth changes only at a parent
 * edge, and never past the group boundary.
 */
export function computeMove(
    lines: string[],
    bulletIndex: number,
    caretLine: number,
    caretCol: number,
    dir: 'up' | 'down',
    blocks: FencedBlockRange[] = fencedBlocks(lines),
): MoveEdit | null {
    if (!isBulletLine(lines[bulletIndex])) return null
    const br = branchRange(lines, bulletIndex, blocks)
    const E = lines.slice(br.start, br.end + 1)
    const caretInBranch = caretLine - br.start
    /** The shift a move applies to the branch: onto the target line's indent (the parent's for a promote,
     *  the sibling's for a jump — on over-nested text two siblings can sit at different indents, and a
     *  jumped branch takes the indent of the place it lands so the tree keeps its shape), the descendants
     *  keeping their own offsets. Zero on text on the grid. */
    const onto = (target: number) => lineIndent(lines[target]) - lineIndent(lines[bulletIndex])

    let out: string[]
    let eStartInOut: number
    let indentDelta: number
    let fromLine: number
    let toLine: number

    if (dir === 'down') {
        const sib = nextSiblingRange(lines, bulletIndex, blocks)
        if (sib) {
            // Jump the branch over the next sibling's whole subtree, same depth.
            indentDelta = onto(sib.start)
            out = [...lines.slice(sib.start, sib.end + 1), ...reindent(E, indentDelta)]
            eStartInOut = sib.end - sib.start + 1
            fromLine = br.start
            toLine = sib.end
        } else {
            const p = parentIndex(lines, bulletIndex, blocks)
            if (p === null) return null // top of group, no sibling below → consume
            indentDelta = onto(p)
            out = reindent(E, indentDelta) // promote: outdent in place → the parent's next sibling
            eStartInOut = 0
            fromLine = br.start
            toLine = br.end
        }
    } else {
        const sib = prevSiblingRange(lines, bulletIndex, blocks)
        // The jump rebuilds the two branches, so a line between them would be lost. Siblings are
        // adjacent; where a scan ever finds one that is not, the key moves nothing.
        if (sib && sib.end + 1 !== br.start) return null
        if (sib) {
            // Jump the branch over the previous sibling's whole subtree, same depth.
            indentDelta = onto(sib.start)
            out = [...reindent(E, indentDelta), ...lines.slice(sib.start, sib.end + 1)]
            eStartInOut = 0
            fromLine = sib.start
            toLine = br.end
        } else {
            const p = parentIndex(lines, bulletIndex, blocks)
            if (p === null) return null
            const par = branchRange(lines, p, blocks)
            // promote: outdent and lift above the parent → the parent's previous sibling.
            indentDelta = onto(p)
            out = [...reindent(E, indentDelta), ...lines.slice(par.start, br.start), ...lines.slice(br.end + 1, par.end + 1)]
            eStartInOut = 0
            fromLine = par.start
            toLine = par.end
        }
    }

    const caretLineInOut = eStartInOut + caretInBranch
    const removed = indentDelta < 0 ? Math.min(-indentDelta, lineIndent(lines[caretLine])) : 0
    const newCaretCol = indentDelta > 0 ? caretCol + indentDelta : Math.max(0, caretCol - removed)
    let caretOffset = 0
    for (let k = 0; k < caretLineInOut; k++) caretOffset += out[k].length + 1
    caretOffset += Math.min(newCaretCol, out[caretLineInOut].length)
    return { fromLine, toLine, text: out.join('\n'), caretOffset }
}
