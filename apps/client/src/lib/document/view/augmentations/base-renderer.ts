/**
 * The two shapes every source-hiding augmentation takes, written once.
 *
 * Before this module each augmentation carried its own ViewPlugin or StateField scaffold, its own
 * rebuild condition and its own reading of the reveal rule, so a new feature was mostly plumbing
 * and the plumbing drifted. An augmentation is now a *declaration*: which spans it decorates and
 * how, given the reveal state. The scaffold, the rebuild triggers and the reveal policy
 * (`reveal-policy.ts`) are shared. Zettlr's CodeMirror renderers use the same split.
 *
 * - {@link hiddenSyntaxPlugin} — inline marks and hidden syntax over the **visible** ranges, from a
 *   ViewPlugin. Right for anything that does not change vertical layout (links, emphasis marks).
 *   What a declaration returns is split at each later line's text and kept off the code blocks the
 *   editor shows before it is drawn ({@link hiddenSyntaxPieces}).
 * - {@link blockWidgetField} — replace-widgets over whole lines, from a StateField; a block that is
 *   a bullet's content keeps its marker as text and takes the widget inline after it. CodeMirror
 *   needs block widgets in state, not a view plugin, before it can measure heights; the field
 *   also lets the rest of the stack read "is this block collapsed" without a view.
 */

import { syntaxTree } from '@codemirror/language'
import { type EditorState, type Extension, type Line, type Range, StateField, type Transaction } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, type WidgetType } from '@codemirror/view'

import { contentStart } from '../../outliner'
import { visibleFencedBlocks } from '../outliner-context'
import { quoteMarkersLength } from './blockquote-core'
import { lineRevealed, linesAllHidden, rangeRevealed, revealInputsChanged, revealedLines } from './reveal-policy'

/** The reveal questions an augmentation may ask while building, already answered for this state. */
export interface RevealState {
    readonly state: EditorState
    /** Line-kind reveal for the line holding `pos`. */
    lineRevealedAt(pos: number): boolean
    /** Range-kind reveal for `[from, to]`, boundaries inclusive. */
    rangeRevealed(from: number, to: number): boolean
    /** Block-kind reveal: is any line from the one holding `from` to the one holding `to` revealed? */
    blockRevealedAt(from: number, to: number): boolean
}

/** The reveal state for `state`: what a builder passes its declaration, and what a Node test reads decorations with. */
export function revealStateOf(state: EditorState): RevealState {
    const active = revealedLines(state)
    return {
        state,
        lineRevealedAt: (pos) => lineRevealed(state, state.doc.lineAt(pos).number, active),
        rangeRevealed: (from, to) => rangeRevealed(state, from, to),
        blockRevealedAt: (from, to) => !linesAllHidden(state, state.doc.lineAt(from).number, state.doc.lineAt(to).number, active),
    }
}

// ── Inline syntax: marks plus hidden delimiters over the visible ranges ───────────────────────

export interface HiddenSyntaxSpec {
    /**
     * The decorations for `[from, to]` (one visible range) of `state`. Use `reveal` to decide
     * whether a span's syntax is hidden or shown raw; return marks and `Decoration.replace({})`
     * ranges in any order: they are clipped and sorted once, by {@link hiddenSyntaxPieces}.
     */
    pieces(state: EditorState, from: number, to: number, reveal: RevealState): Range<Decoration>[]
}

/** The empty replace decoration that hides syntax characters. */
export const hiddenSyntax = Decoration.replace({})

/**
 * Where the text of `line` starts: past the quote markers the parser reads on it
 * ({@link quoteMarkersLength}), then past the indent and bullet marker the content clamp lifts out
 * of the flow ({@link contentStart}).
 */
function lineTextStart(state: EditorState, line: Line): number {
    const quote = quoteMarkersLength(syntaxTree(state), line)
    return line.from + quote + contentStart(line.text.slice(quote))
}

/**
 * The pieces with every mark over a line break split per line, each later line's piece starting at
 * its text. The quote markers, indent and bullet marker before the text are the line's structure,
 * not the construct's content (CommonMark strips a paragraph line's leading whitespace), and the
 * content clamp lifts the indent out of the flow to the line's left edge: a mark over it would be
 * drawn there, over the start of the text. Replace, widget and line decorations come back whole,
 * and the order is kept. Reads the document and the syntax tree, never the caret, so an
 * augmentation that rebuilds only on edits can apply it too (asset-link.ts).
 */
export function splitMarksAtLineText(state: EditorState, pieces: readonly Range<Decoration>[]): Range<Decoration>[] {
    const { doc } = state
    const split: Range<Decoration>[] = []
    for (const piece of pieces) {
        const line = doc.lineAt(piece.from)
        if (piece.value.point || piece.to <= line.to) {
            split.push(piece)
            continue
        }
        for (let current = line; ; current = doc.line(current.number + 1)) {
            const from = current === line ? piece.from : lineTextStart(state, current)
            const to = Math.min(piece.to, current.to)
            if (from < to) split.push(piece.value.range(from, to))
            if (piece.to <= current.to) break
        }
    }
    return split
}

/**
 * The pieces less every one on a line of a code block the editor shows ({@link visibleFencedBlocks},
 * the reading the panel is drawn from), opener and closer included. The markdown parser reads
 * CommonMark, and on text off the Indent Unit grid the outline reads it otherwise (ADR 0067): a
 * child bullet four columns or more past its parent's content column is, to CommonMark, a lazy
 * continuation of the parent's paragraph and its fences the delimiters of a code span, whose marks
 * and hidden backticks would land inside the panel. Caret-aware, as the panel is.
 */
export function dropPiecesOnCodeLines(state: EditorState, pieces: readonly Range<Decoration>[]): Range<Decoration>[] {
    if (pieces.length === 0) return []
    const { doc } = state
    let low = doc.length
    let high = 0
    for (const piece of pieces) {
        low = Math.min(low, piece.from)
        high = Math.max(high, piece.to)
    }
    // Only the blocks the pieces reach: they are built over the visible ranges.
    const first = doc.lineAt(low).number - 1
    const last = doc.lineAt(high).number - 1
    const blocks = visibleFencedBlocks(state).filter((b) => b.end >= first && b.start <= last)
    if (blocks.length === 0) return [...pieces]
    return pieces.filter((piece) => {
        const from = doc.lineAt(piece.from).number - 1
        const to = doc.lineAt(piece.to).number - 1
        return !blocks.some((b) => b.start <= to && b.end >= from)
    })
}

/**
 * What {@link hiddenSyntaxPlugin} draws for `spec` over `ranges` of `state`: the declaration's
 * pieces for every range, split at each later line's text and kept off the code blocks the editor
 * shows. Pure over the state, so a Node test reads exactly what the editor draws.
 */
export function hiddenSyntaxPieces(
    spec: HiddenSyntaxSpec,
    state: EditorState,
    ranges: readonly { from: number; to: number }[],
): Range<Decoration>[] {
    const reveal = revealStateOf(state)
    const pieces: Range<Decoration>[] = []
    for (const { from, to } of ranges) pieces.push(...spec.pieces(state, from, to, reveal))
    return dropPiecesOnCodeLines(state, splitMarksAtLineText(state, pieces))
}

/**
 * A ViewPlugin that rebuilds `spec.pieces` over the visible ranges whenever the document, the
 * viewport or the selection changes — the three inputs an inline reveal depends on — or the syntax
 * tree does: the markdown parser finishes a large document asynchronously, in a transaction that
 * changes none of the three, and pieces built over the partial tree would otherwise stay until the
 * next keystroke or scroll.
 */
export function hiddenSyntaxPlugin(spec: HiddenSyntaxSpec): Extension {
    const build = (view: EditorView): DecorationSet => Decoration.set(hiddenSyntaxPieces(spec, view.state, view.visibleRanges), true)
    return ViewPlugin.fromClass(
        class {
            decorations: DecorationSet
            constructor(view: EditorView) {
                this.decorations = build(view)
            }
            update(update: ViewUpdate) {
                if (update.docChanged || update.viewportChanged || update.selectionSet || treeChanged(update)) {
                    this.decorations = build(update.view)
                }
            }
        },
        { decorations: (v) => v.decorations },
    )
}

/** Whether the syntax tree advanced in this update (the parser finishing work asynchronously). */
export function treeChanged(update: ViewUpdate): boolean {
    return syntaxTree(update.state) !== syntaxTree(update.startState)
}

// ── Block widgets: a block's lines replaced (whole, or after a bullet marker) while none is revealed ──

export interface BlockWidgetSpec<T> {
    /** The candidate blocks in the document, from the shared analysis where possible. */
    blocks(state: EditorState): readonly T[]
    /** The 1-based first and last line of a block. */
    lines(block: T): { first: number; last: number }
    /** The widget that stands in for the block while it is collapsed. */
    widget(block: T, state: EditorState, from: number, to: number): WidgetType
    /**
     * How many characters of the block's first line stay real text in front of the widget: a
     * bullet's marker when the block is that bullet's content (`- | a | b |`). Past 0 the widget
     * is an **inline** replacement from there to the block's end (the lines join into the bullet
     * line), so the line keeps its dot and stays a foldable, indentable list item — the same shape
     * the bullet image takes (image-embed.ts), and the same multi-line inline replacement that
     * `@codemirror/language`'s code folding emits. 0 (or omitted) keeps a whole-line block widget.
     */
    markerLength?(block: T, state: EditorState, firstLine: Line): number
    /**
     * Any extra reason to rebuild beyond an edit, a selection change or a pin (a theme tick, a
     * render completing). The reveal inputs are always included.
     */
    rebuildOn?(tr: Transaction): boolean
}

/**
 * A StateField of replace-widgets, one per block. A block collapses to its widget while no selection
 * range touches any of its lines (line-kind reveal over the whole block) and no pin holds it open;
 * the widget covers the block's lines whole, or from past a bullet marker (`markerLength`).
 */
export function blockWidgetField<T>(spec: BlockWidgetSpec<T>): StateField<DecorationSet> {
    function build(state: EditorState): DecorationSet {
        const active = revealedLines(state)
        const decos: Range<Decoration>[] = []
        for (const block of spec.blocks(state)) {
            const { first, last } = spec.lines(block)
            if (!linesAllHidden(state, first, last, active)) continue
            const firstLine = state.doc.line(first)
            const marker = spec.markerLength?.(block, state, firstLine) ?? 0
            const from = firstLine.from + marker
            const to = state.doc.line(last).to
            decos.push(Decoration.replace({ widget: spec.widget(block, state, from, to), block: marker === 0 }).range(from, to))
        }
        return Decoration.set(decos, true)
    }
    return StateField.define<DecorationSet>({
        create: build,
        update(deco, tr) {
            if (revealInputsChanged(tr) || spec.rebuildOn?.(tr)) return build(tr.state)
            return deco
        },
        provide: (f) => EditorView.decorations.from(f),
    })
}
