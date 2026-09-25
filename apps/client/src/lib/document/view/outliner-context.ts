/**
 * Caret/line context classification from the `@lezer/markdown` syntax tree — shared by the
 * outliner keymap (context-aware Enter/Tab) and the fence source-guard (ADR 0019, ADR 0020).
 * Kept in one place so the tree queries don't sprawl across the keymap.
 */

import type { EditorState } from '@codemirror/state'

import { defangFence, type FencedBlockRange, fencedBlocks, fenceLineInfo, isUnterminatedOpener } from '../fenced-code'
import { isBulletLine, taskDone } from '../outliner'
import {
    analysisFor,
    editorAnalysisField,
    type EditorAnalysis,
} from './analysis/editor-analysis'

export type CaretContext = 'prose' | 'bullet' | 'task' | 'fenced-code' | 'frontmatter'

export interface FencedBlock {
    /** Document offset of the start of the opening fence. */
    from: number
    /** Document offset of the end of the block (end of the closing fence). */
    to: number
    /**
     * The column the fence and its content are clamped to. For a fence inside a bullet this equals
     * `contentColumn(openerLine)` (the Task 5.2 invariant) — derived from the same helper so the
     * guard and the visual clamp can't drift.
     */
    fenceColumn: number
    /** The opener's backtick/tilde run (used to rebalance the closer). */
    ticks: string
}

/**
 * The fenced code block enclosing `pos`, or null — the TRUE markdown structure, for the keymap and
 * source-guard. Driven by the **balanced** line-scan ({@link fencedBlocks}), NOT the Lezer tree: an
 * unterminated fence (no balancing closer yet) extends its `FencedCode` tree node to the end of the
 * document, which would wrongly classify everything below it as code (monospace, syntax highlighting,
 * code keymap). Requiring a real closer keeps "incomplete fence ⇒ plain text" until the block is
 * completed (the Enter handler auto-inserts the closer, so a lingering open fence is genuinely
 * unfinished). The VISUAL layer instead uses {@link visibleFencedBlockAt}, which additionally ignores a
 * half-typed fence under the caret.
 */
export function fencedBlockAt(state: EditorState, pos: number): FencedBlock | null {
    const analysis = state.field(editorAnalysisField, false) as EditorAnalysis | undefined
    return fencedBlockAtIn(
        state,
        pos,
        analysis?.fencedBlocks ?? fencedBlocks(state.doc.toString().split('\n')),
    )
}

/** Shared: the block in `blocks` enclosing `pos`, mapped to a {@link FencedBlock}. */
export function fencedBlockAtIn(
    state: EditorState,
    pos: number,
    blocks: readonly FencedBlockRange[],
): FencedBlock | null {
    const lineIndex = state.doc.lineAt(pos).number - 1
    let low = 0
    let high = blocks.length - 1
    while (low <= high) {
        const middle = (low + high) >>> 1
        const block = blocks[middle]
        if (lineIndex < block.start) {
            high = middle - 1
            continue
        }
        if (lineIndex > block.end) {
            low = middle + 1
            continue
        }
        const openerLine = state.doc.line(block.start + 1)
        const opener = fenceLineInfo(openerLine.text)
        return {
            from: openerLine.from,
            to: state.doc.line(block.end + 1).to,
            fenceColumn: block.fenceColumn,
            ticks: opener?.run ?? '```',
        }
    }
    return null
}

/**
 * Like {@link fencedBlocks} but for the VISUAL layer (shaded panel, monospace, clamp). A bare fence the
 * caret is sitting on may be a half-typed opener: on its own it would greedily pair with the next bare
 * fence below — stealing an existing block's opener and shading the prose in between — long before the
 * user has typed a closer (the Enter handler completes it). So we re-scan with that fence removed and
 * adopt the result, BUT only when removing it does not REDUCE the number of complete blocks. That guard
 * means clicking onto an existing block's own fence (which would orphan its partner) never un-styles it;
 * only a genuinely surplus fence (one that, dropped, leaves the same or more blocks) is treated as
 * in-progress. Caret-aware → callers must rebuild on selection changes.
 */
export function visibleFencedBlocks(state: EditorState): readonly FencedBlockRange[] {
    const analysis = state.field(editorAnalysisField, false) as EditorAnalysis | undefined
    const lines = analysis?.lines ?? state.doc.toString().split('\n')
    const blocks = analysis?.fencedBlocks ?? fencedBlocks(lines)
    const caretLine = state.doc.lineAt(state.selection.main.head).number - 1
    const pending = analysis?.pendingFence ?? -1
    const f = fenceLineInfo(lines[caretLine])
    // Only a BARE fence (no info-string) is ambiguous enough to be a half-typed opener; an info-bearing
    // fence is unambiguously an opener, so a completed block's fences are never second-guessed.
    if (!f || f.info !== '') return blocks
    // Only intervene when the doc is UNBALANCED — some fence line sits OUTSIDE every complete block (an
    // orphan), the tell-tale of an in-progress fence having knocked the pairing out of balance. When every
    // fence is already accounted for (a clean doc, or a nested ``` that is content of a ```` block) the
    // caret fence is legit and must not be second-guessed.
    const inBlock = (i: number) => blocks.some((b) => i >= b.start && i <= b.end)
    // The analysis's pending fence (a freshly typed, still unclosed opener) is text already.
    const balanced = lines.every((l, i) => i === pending || !fenceLineInfo(l) || inBlock(i))
    if (balanced) return blocks
    // Neutralise the caret fence (keep its indentation; just defang the backtick/tilde run) and re-pair;
    // adopt the result only if it doesn't lose blocks (never trade a real block away for the half-typed one).
    const without = fencedBlocks(lines.map((l, i) => (i === caretLine || i === pending ? defangFence(l) : l)))
    return without.length >= blocks.length ? without : blocks
}

/** Caret-aware {@link fencedBlockAt} for the visual layer (see {@link visibleFencedBlocks}). */
export function visibleFencedBlockAt(state: EditorState, pos: number): FencedBlock | null {
    return fencedBlockAtIn(state, pos, visibleFencedBlocks(state))
}

/**
 * Whether the fence line at `pos` is an unterminated opener — the one shape Enter completes — under
 * the analysis's pending-aware pairing ({@link isUnterminatedOpener}): the freshly typed fence the
 * analysis holds pending is set aside here exactly as it is for every other fence consumer.
 */
export function unterminatedFenceOpenerAt(state: EditorState, pos: number): boolean {
    const analysis = state.field(editorAnalysisField, false) as EditorAnalysis | undefined
    const lines = analysis?.lines ?? state.doc.toString().split('\n')
    return isUnterminatedOpener(lines, state.doc.lineAt(pos).number - 1, analysis?.pendingFence ?? null)
}

/**
 * Whether the line starting at `lineFrom` is INSIDE a complete fenced block: content or closer, not the
 * opener. Fenced content is opaque to every augmentation that recognises structure by line shape:
 * a `- item`, `# heading`, `![image](…)` or `[ ] task` inside a fence is code and gets no dot, guide,
 * checkbox, widget or clamp of its own (Editor Content Rules → Fenced blocks are opaque).
 */
export function insideFencedBlock(state: EditorState, lineFrom: number): boolean {
    const block = fencedBlockAt(state, lineFrom)
    return block !== null && block.from !== lineFrom
}

/** Whether the line holding `pos` is inside the [[Frontmatter]] block: verbatim metadata, opaque like a fence. */
export function lineInFrontmatter(state: EditorState, pos: number): boolean {
    return analysisFor(state).frontmatterEnd >= state.doc.lineAt(pos).from
}

/** Classify the caret's context (the main selection head). */
export function caretContext(state: EditorState): CaretContext {
    const pos = state.selection.main.head
    // [[Frontmatter]] before anything else: it is verbatim metadata, opaque like a fence, and
    // the structural commands must not restructure it. Moving `title:` below the closing
    // delimiter silently changes which [[Concept]] the document answers to.
    if (lineInFrontmatter(state, pos)) return 'frontmatter'
    if (fencedBlockAt(state, pos)) return 'fenced-code'
    const line = state.doc.lineAt(pos).text
    if (isBulletLine(line)) return taskDone(line) === undefined ? 'bullet' : 'task'
    return 'prose'
}
