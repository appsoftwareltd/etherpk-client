/**
 * The unified derived-block model (ADR 0016): blocks inferred from the markdown
 * source, never stored. One tree from three interlocking signals —
 *
 *  1. **Heading level** (`#` > `##` > `###`) is the outer spine: everything between
 *     a heading and the next equal-or-higher heading nests beneath it.
 *  2. **Bullet / plain-line indentation** nests further within a section: a line
 *     is one deeper than the nearest open line with a smaller indent (the Indent
 *     Unit walk, ADR 0067), so a four-space or tab-indented file reads the same
 *     tree as a two-space one.
 *  3. **Continuation lines** — non-bullet lines indented to a bullet's content
 *     column belong to the *same* block (the soft-newline-within-a-block).
 *
 * A complete [[Fenced Code Block]] is opaque to all three: it belongs whole to the block its
 * opener sits in, so a blank line, a `# comment` or a `- item` inside it is code, never a block
 * boundary, a heading or a bullet. "Complete" is the editor's pairing (`fencedBlocks`), the same
 * one the outline walk (`indent-unit.ts`) takes fences whole by.
 *
 * A block has a kind (heading / paragraph / bullet / task). Blocks have no
 * persistent identity: a block is its source range in the current parse.
 *
 * Pure and DOM-free; the derived index (`index-derive.ts`) and the publisher's navigation
 * (`publish/nav.ts`) consume it. The editor reads the same outline through `indent-unit.ts`.
 * See Dual Mode Editor.md.
 */

import { codeLineText, fencedBlocks, type FencedBlockRange } from './fenced-code'
import { outlineLines } from './indent-unit'

export type BlockKind = 'heading' | 'paragraph' | 'bullet' | 'task'

export interface Block {
    type: BlockKind
    /**
     * Structural nesting depth (0 = top level), read from the indentation by the
     * Indent Unit walk. Headings are recorded at their depth too (usually 0); their
     * *hierarchy* comes from {@link level}, not this.
     */
    depth: number
    /** Heading rank: the `#` count (1–6). Only set for `heading` blocks. */
    level?: number
    /** Completion state. Only set for `task` blocks. */
    done?: boolean
    /**
     * Source text — own lines (incl. continuation lines and fenced code), joined by `\n`. Structural
     * indentation is trimmed; a fenced block's lines keep the indentation past their fence's column,
     * because in code it is content.
     */
    text: string
    /** 0-based inclusive source line range of this block's *own* lines (incl. continuations). */
    startLine: number
    endLine: number
    children: Block[]
}

function indentOf(line: string): number {
    return line.length - line.trimStart().length
}

function headingLevel(line: string): number | undefined {
    const m = /^(#{1,6})\s/.exec(line.trimStart())
    return m ? m[1].length : undefined
}

function isBullet(line: string): boolean {
    return /^-\s/.test(line.trimStart())
}

/** A bullet whose content is `[ ]` / `[x]` is a task; returns its done state. */
function taskDone(line: string): boolean | undefined {
    const m = /^-\s+\[([ xX])\]/.exec(line.trimStart())
    if (!m) return undefined
    return m[1].toLowerCase() === 'x'
}

type Flat = Omit<Block, 'children'>

/**
 * Parse markdown into a tree of derived blocks (ADR 0016).
 *
 * {@link Block.depth} is **structural** (ADR 0067): a line is one deeper than the nearest open
 * line with a strictly smaller indent, whatever grid the text is on — the same walk the editor
 * renders from (`indent-unit.ts`), so the index and the editor never disagree about a four-space
 * or tab-indented document. The content column for continuation lines stays marker-based
 * (`indent + 2`).
 */
export function parseBlocks(markdown: string): Block[] {
    const lines = markdown.split('\n')
    const fences = fencedBlocks(lines)
    const outline = outlineLines(lines, fences)
    const fenceAt = new Map<number, FencedBlockRange>(fences.map((f) => [f.start, f]))

    /**
     * Add line `k` to a block's `buf` and return the line after it. A line that opens a complete
     * fenced block brings the whole block with it, so nothing inside the fence is read as structure.
     * A fence nested inside it starts within the range taken, so only outermost fences reach here.
     */
    const take = (k: number, buf: string[]): number => {
        buf.push(lines[k].trimStart())
        const fence = fenceAt.get(k)
        if (!fence) return k + 1
        for (let n = k + 1; n <= fence.end; n++) buf.push(codeLineText(lines[n], fence.fenceColumn))
        return fence.end + 1
    }

    // 1) Flat blocks in document order.
    const flat: Flat[] = []
    let i = 0
    while (i < lines.length) {
        if (lines[i].trim() === '') {
            i++
            continue
        }
        const depth = outline[i].depth
        const level = headingLevel(lines[i])

        if (level !== undefined) {
            flat.push({
                type: 'heading',
                depth,
                level,
                text: lines[i].trimStart(),
                startLine: i,
                endLine: i,
            })
            i++
            continue
        }

        if (isBullet(lines[i])) {
            // A bullet/task: gather continuation lines — non-blank, non-heading,
            // non-bullet lines indented to (or past) the marker's content column.
            const contentCol = indentOf(lines[i]) + 2 // `- `
            const done = taskDone(lines[i])
            const start = i
            const buf: string[] = []
            i = take(i, buf) // a bullet line that opens a fence (form-1) brings it whole
            while (
                i < lines.length &&
                lines[i].trim() !== '' &&
                headingLevel(lines[i]) === undefined &&
                !isBullet(lines[i]) &&
                indentOf(lines[i]) >= contentCol
            ) {
                i = take(i, buf)
            }
            flat.push({
                type: done === undefined ? 'bullet' : 'task',
                depth,
                ...(done === undefined ? {} : { done }),
                text: buf.join('\n'),
                startLine: start,
                endLine: i - 1,
            })
            continue
        }

        // A paragraph: contiguous non-blank, non-heading, non-bullet lines at the
        // same indentation.
        const start = i
        const buf: string[] = []
        i = take(i, buf)
        while (
            i < lines.length &&
            lines[i].trim() !== '' &&
            headingLevel(lines[i]) === undefined &&
            !isBullet(lines[i]) &&
            indentOf(lines[i]) === indentOf(lines[start])
        ) {
            i = take(i, buf)
        }
        flat.push({ type: 'paragraph', depth, text: buf.join('\n'), startLine: start, endLine: i - 1 })
    }

    // 2) Build the tree (ADR 0016 stack rule):
    //  - a heading pops every open non-heading block and every heading of >= its level;
    //  - a non-heading pops every open non-heading block of >= its indentation depth
    //    (never a heading — it nests under the enclosing section).
    const roots: Block[] = []
    const stack: Block[] = []
    for (const f of flat) {
        const block: Block = { ...f, children: [] }
        if (block.type === 'heading') {
            const level = block.level!
            while (
                stack.length > 0 &&
                (stack[stack.length - 1].type !== 'heading' || stack[stack.length - 1].level! >= level)
            ) {
                stack.pop()
            }
        } else {
            while (
                stack.length > 0 &&
                stack[stack.length - 1].type !== 'heading' &&
                stack[stack.length - 1].depth >= block.depth
            ) {
                stack.pop()
            }
        }
        if (stack.length === 0) roots.push(block)
        else stack[stack.length - 1].children.push(block)
        stack.push(block)
    }
    return roots
}
