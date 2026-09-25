/**
 * Pure structural logic for the outline guide lines (see outline-guides.ts) — no CodeMirror imports,
 * so it is unit-testable in isolation.
 */

import { frontmatterLines } from '$lib/storage/fs/frontmatter-span'

import { type FencedBlockRange, fencedBlocks } from '../../fenced-code'
import type { OutlineLine } from '../../indent-unit'
import { isBulletLine, lineIndent } from '../../outliner'

/**
 * A guide thread's width in CSS pixels, shared by the editor's overlay (outline-guides.ts) and the
 * Backlinks panel's quoted outline, so a thread reads the same in both. Two, not a hairline: one CSS
 * pixel is a single device pixel on a standard screen, and too faint beside the text.
 */
export const GUIDE_WIDTH_PX = 2

/** One guide thread: it hangs from a bullet's dot and runs down beside the lines to `last`. */
export interface GuideThread {
    /** 0-based line of the bullet the thread hangs from. */
    parent: number
    /** 0-based line the thread runs down to. */
    last: number
    /**
     * Whether `last` is the final line of a quote, so the thread runs on to the bottom of the quote's
     * panel instead of stopping at the text. The panel pads its last line below the text, and a thread
     * that stopped at the text left the panel hanging past the end of the tree. A function because it
     * reads the syntax tree: the overlay asks only for the threads it draws.
     */
    toPanel: () => boolean
}

/**
 * Every guide thread, from {@link branchEnds}:
 *
 * - one per bullet that parents a sub-bullet, down to its branch's last line, and on to the panel's
 *   bottom when that line ends a quote;
 * - one for a bullet with no parent bullet and no child bullet whose block (its own line and its
 *   soft lines) ends in a quote, when it is the last bullet of its group. It has no parent thread to
 *   extend, so its own runs from its dot down beside the panel. Not when a sibling follows: the
 *   thread would run down to that sibling's dot and read as a parent. "No parent bullet" rather than
 *   outline depth 0: a bullet under a heading or a paragraph is deeper in the outline but has no
 *   thread above it either.
 *
 * `within` (0-based lines, inclusive) keeps only the threads that reach into it: the overlay passes
 * the rendered range. `quoteEndsAt` answers for a 0-based line (blockquote-core.ts) and reads the
 * syntax tree, so it is asked only about threads inside `within`: the second kind here, the first
 * only through `toPanel`.
 */
export function guideThreads(
    lines: readonly string[],
    ends: readonly number[],
    outline: readonly OutlineLine[],
    quoteEndsAt: (line: number) => boolean,
    within: { from: number; to: number } = { from: 0, to: lines.length - 1 },
): GuideThread[] {
    const threads: GuideThread[] = []
    const reaches = (parent: number, last: number) => parent <= within.to && last >= within.from
    // The last line covered by a thread already opened above: a bullet at or above it has a parent.
    let covered = -1
    for (let i = 0; i < lines.length && i <= within.to; i++) {
        const end = ends[i]
        if (end > i) {
            covered = Math.max(covered, end)
            if (reaches(i, end)) threads.push({ parent: i, last: end, toPanel: () => quoteEndsAt(end) })
            continue
        }
        // A childless bullet (`end === i`; prose, fence and frontmatter lines are -1) with no parent.
        if (end !== i || i <= covered) continue
        // Its block: the lines it owns below it, which are contiguous. The last non-blank one is where
        // a quote would end.
        let last = i
        let next = i + 1
        while (next < lines.length && outline[next]?.owner === i) {
            if (lines[next].trim() !== '') last = next
            next++
        }
        // A bullet right below the block is a sibling in the same group.
        if (next < lines.length && ends[next] >= 0) continue
        if (reaches(i, last) && quoteEndsAt(last)) threads.push({ parent: i, last, toPanel: () => true })
    }
    return threads
}

/**
 * For each line, the 0-based index of the last line in its branch — or `i` itself for a bullet that
 * has no **child bullet**, or -1 for a non-bullet line. Every bullet where this is `> i` hangs a guide
 * thread down to that last descendant line (which may be a continuation of the last child);
 * {@link guideThreads} adds the one other kind, beside a quote. Single O(n) stack pass: a line no more indented than an open bullet ends that bullet's
 * branch at the **last non-blank line** before it.
 *
 * Whitespace-only lines follow ADR 0021's **indent decides** rule: a blank inside a fenced block is
 * transparent (never a boundary), an indented soft line (Shift-Enter) bounds only branches deeper
 * than its own indent — so true multiline editing keeps its thread — and a bare column-0 empty line
 * (a Ctrl-Enter breakout split) ends every open branch, cutting the thread at the split.
 */
export function branchEnds(lines: string[], blocks: FencedBlockRange[] = fencedBlocks(lines)): number[] {
    const ends = new Array<number>(lines.length).fill(-1)
    const hasChildBullet: boolean[] = new Array<boolean>(lines.length).fill(false)
    const inFence = new Array<boolean>(lines.length).fill(false)
    for (const b of blocks) for (let k = b.start; k <= b.end; k++) inFence[k] = true
    const starts = new Set(blocks.map((b) => b.start))
    const open: number[] = [] // indices of bullets whose branch is still open
    let lastContent = -1 // last non-blank line seen
    // [[Frontmatter]] is opaque too, and it is not outline content either: a YAML list's `- `
    // items are metadata, so they open no branch and no thread reaches down to them.
    for (let i = frontmatterLines(lines); i < lines.length; i++) {
        if (inFence[i] && !starts.has(i)) {
            // Fenced content and the closer (a `- item` or `# heading` in code included) are opaque:
            // they never open or close a branch, but they are content, so the owning bullet's thread
            // reaches down to them. The opener line is handled below: a form-1 opener is a real bullet.
            if (lines[i].trim() !== '') lastContent = i
            continue
        }
        if (lines[i].trim() === '') {
            // Indent decides: this blank bounds every open branch at/deeper than its own indent. A bare
            // empty line ('' → indent 0) therefore ends ALL open branches (the breakout split); an
            // indented soft line leaves its own block's thread intact.
            const ind = lineIndent(lines[i])
            while (open.length && lineIndent(lines[open[open.length - 1]]) >= ind) ends[open.pop()!] = lastContent
            continue // not content: it neither extends a thread nor opens one
        }
        const ind = lineIndent(lines[i])
        while (open.length && lineIndent(lines[open[open.length - 1]]) >= ind) ends[open.pop()!] = lastContent
        if (isBulletLine(lines[i])) {
            if (open.length) hasChildBullet[open[open.length - 1]] = true // a sub-bullet of its parent
            open.push(i)
        }
        lastContent = i
    }
    while (open.length) ends[open.pop()!] = lastContent
    // Only bullets that actually parent a sub-bullet get a thread; collapse the rest to "no thread".
    for (let i = 0; i < lines.length; i++) if (ends[i] >= 0 && !hasChildBullet[i]) ends[i] = i
    return ends
}
