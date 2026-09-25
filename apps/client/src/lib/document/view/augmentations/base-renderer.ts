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
 * - {@link blockWidgetField} — replace-widgets over whole lines, from a StateField; a block that is
 *   a bullet's content keeps its marker as text and takes the widget inline after it. CodeMirror
 *   needs block widgets in state, not a view plugin, before it can measure heights; the field
 *   also lets the rest of the stack read "is this block collapsed" without a view.
 */

import { syntaxTree } from '@codemirror/language'
import { type EditorState, type Extension, type Line, type Range, StateField, type Transaction } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, type WidgetType } from '@codemirror/view'

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
     * The decorations for `[from, to]` (one visible range). Use `reveal` to decide whether a
     * span's syntax is hidden or shown raw; return marks and `Decoration.replace({})` ranges
     * in any order — they are sorted once here.
     */
    pieces(view: EditorView, from: number, to: number, reveal: RevealState): Range<Decoration>[]
}

/** The empty replace decoration that hides syntax characters. */
export const hiddenSyntax = Decoration.replace({})

/**
 * A ViewPlugin that rebuilds `spec.pieces` over the visible ranges whenever the document, the
 * viewport or the selection changes — the three inputs an inline reveal depends on — or the syntax
 * tree does: the markdown parser finishes a large document asynchronously, in a transaction that
 * changes none of the three, and pieces built over the partial tree would otherwise stay until the
 * next keystroke or scroll.
 */
export function hiddenSyntaxPlugin(spec: HiddenSyntaxSpec): Extension {
    function build(view: EditorView): DecorationSet {
        const reveal = revealStateOf(view.state)
        const decos: Range<Decoration>[] = []
        for (const { from, to } of view.visibleRanges) decos.push(...spec.pieces(view, from, to, reveal))
        return Decoration.set(decos, true)
    }
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
