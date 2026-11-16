/**
 * Augmentation: render an outliner bullet's `-` marker as a small round dot (Logseq-style), instead
 * of the literal hyphen. A pure decoration over unaltered markdown (ADR 0001) — the source stays
 * `- ` / `- [ ] `, so every outliner operation (indent, branch ops, content column) is unaffected;
 * only the glyph is restyled. The dot is sized off the editor's BASE font (`--editor-font-size`), not
 * the line's font, so it stays a uniform size even on a smaller-font line (e.g. a code-block opener).
 */

import { foldedRanges } from '@codemirror/language'
import { type Extension, type Range } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

import { isBulletLine, lineIndent } from '../../outliner'
import { analysisFor } from '../analysis/editor-analysis'
import { insideFencedBlock } from '../outliner-context'
import { CONTENT_GUTTER } from './content-clamp'
import { foldedBulletLines } from './outline-folds'

/** Marks the single `-` of a bullet marker; CSS hides the glyph and paints a dot over it. The dot also
 *  carries the CONTENT_GUTTER as `margin-right`. On a form-1 opener, whose `- ` stays in flow, that is
 *  what pushes the fence right so it sits padded inside the panel, level with the body code. On a plain
 *  bullet the whole marker is lifted out of the flow by the clamp's `cm-line-prefix` (content-clamp.ts),
 *  which wraps this mark; there the margin only widens the lifted box, and the line's padding carries the
 *  gutter instead. */
const dot = Decoration.mark({ class: 'cm-bullet-dot' })
/** A bullet with children: its dot is a fold control (fold-controls.ts). */
const foldableDot = Decoration.mark({ class: 'cm-bullet-dot cm-bullet-dot--foldable' })
/** A folded bullet: its disc stays drawn, in place of CodeMirror's `…` box. */
const foldedDot = Decoration.mark({ class: 'cm-bullet-dot cm-bullet-dot--foldable cm-bullet-dot--folded' })

/** The dot for 1-based bullet `line`: folded, with children to fold, or neither. */
function dotFor(line: number, folded: ReadonlySet<number>, branchEnds: readonly number[]): Decoration {
    if (folded.has(line)) return foldedDot
    return branchEnds[line - 1] > line - 1 ? foldableDot : dot
}

function buildBulletMarkers(view: EditorView): DecorationSet {
    const { state } = view
    const decos: Range<Decoration>[] = []
    // A `- item` inside the [[Frontmatter]] is a YAML list entry, not a bullet (ADR 0061): the
    // block is opaque to every line-shaped augmentation, exactly as a fence is.
    const frontmatterEnd = analysisFor(state).frontmatterEnd
    // A line carrying an inline widget (e.g. a `- ![…]` image) splits `visibleRanges`, so a line straddling
    // that gap is reached from BOTH ranges. Dedupe by line start, or the bullet would get two stacked dots.
    const seen = new Set<number>()
    const { branchEnds } = analysisFor(state)
    const folded = new Set(foldedBulletLines(state))
    for (const { from, to } of view.visibleRanges) {
        let pos = from
        while (pos <= to) {
            const line = state.doc.lineAt(pos)
            // A `- item` inside a fenced block is code, not a bullet (a form-1 opener keeps its dot).
            if (
                !seen.has(line.from) &&
                line.from > frontmatterEnd &&
                isBulletLine(line.text) &&
                !insideFencedBlock(state, line.from)
            ) {
                seen.add(line.from)
                const hyphen = line.from + lineIndent(line.text) // the `-` is the first non-space char
                decos.push(dotFor(line.number, folded, branchEnds).range(hyphen, hyphen + 1))
            }
            pos = line.to + 1
        }
    }
    return Decoration.set(decos, true)
}

const theme = EditorView.baseTheme({
    // The `-` glyph is made transparent (it keeps its box, so the content column is unchanged) and a
    // dot is painted centred over it. The dot tracks the editor zoom (`--editor-font-size`) but not a
    // line's own font-size, so it's identical on prose and on a smaller code-block opener line. The
    // `margin-right` opens the gutter between the dot and an in-flow opener's fence (the `::before` is
    // centred on the glyph box and unaffected, so the dot itself does not move — only what follows shifts).
    '.cm-bullet-dot': { color: 'transparent', position: 'relative', marginRight: CONTENT_GUTTER },
    '.cm-bullet-dot::before': {
        content: '""',
        position: 'absolute',
        left: '50%',
        top: '50%',
        width: 'calc(var(--editor-font-size, 1rem) * 0.36)',
        height: 'calc(var(--editor-font-size, 1rem) * 0.36)',
        borderRadius: '50%',
        background: 'var(--gk-text-subtle, #a3a3a3)',
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'none',
    },
    // The disc behind a dot: drawn while the mouse is over it, and kept on a folded bullet. Its
    // transparent border widens the box that takes the dot's clicks to 1.5em (fold-controls.ts)
    // while the disc drawn inside it stays 1em, about Logseq's.
    '.cm-bullet-dot::after': {
        content: '""',
        position: 'absolute',
        left: '50%',
        top: '50%',
        width: 'var(--editor-font-size, 1rem)',
        height: 'var(--editor-font-size, 1rem)',
        border: 'calc(var(--editor-font-size, 1rem) * 0.25) solid transparent',
        // The app's reset sizes every box by its border; the disc is the content box inside it.
        boxSizing: 'content-box',
        backgroundClip: 'padding-box',
        borderRadius: '50%',
        transform: 'translate(-50%, -50%)',
        backgroundColor: 'transparent',
        transition: 'background-color 120ms ease-out',
        cursor: 'pointer',
    },
    '.cm-bullet-dot--folded::after': { backgroundColor: 'color-mix(in srgb, var(--gk-text-subtle, #a3a3a3) 22%, transparent)' },
    '@media (hover: hover)': {
        '.cm-bullet-dot:hover::after': { backgroundColor: 'color-mix(in srgb, var(--gk-text-subtle, #a3a3a3) 36%, transparent)' },
    },
    '@media (prefers-reduced-motion: reduce)': { '.cm-bullet-dot::after': { transition: 'none' } },
    // A whole-pixel dot (5.76px at 16px would blur to a different shape on every line); together with
    // the whole-pixel line pitch in cm-document.ts this is what keeps every dot identical.
    '@supports (width: round(1px, 1px))': {
        '.cm-bullet-dot::before': {
            width: 'round(calc(var(--editor-font-size, 1rem) * 0.36), 1px)',
            height: 'round(calc(var(--editor-font-size, 1rem) * 0.36), 1px)',
        },
    },
    // On a form-1 code-block opener (`- ``` `) the dot shares the line with the (padded) opening fence.
    // Lift the dot to the panel's top-left corner — just inside the container's top edge — so the fence
    // keeps its top padding while the bullet still reads as the block's marker (rather than sitting a
    // padding's-worth down beside the fence). Form-1 only; every other bullet keeps the centred dot.
    // The dot keeps its true (prose-parity) size; only its position changes. Jammed hard into the panel's
    // top-left corner (the old 0.45em lift) it read visibly small — a disc crammed against a big shape looks
    // shrunken. Lift it only to the OPENING FENCE ROW instead: it aligns with the block's first line the way
    // a prose bullet aligns with its text, with breathing room off the top edge, so it reads at its real size.
    '.cm-line.gk-code-block-first-bullet .cm-bullet-dot::before, .cm-line.gk-code-block-first-bullet .cm-bullet-dot::after': { top: 'calc(50% - 0.15em)' },
})

/** The bullet-dot augmentation (Dual Mode Editor.md). Mounted in DocumentView alongside the others. */
export function bulletMarkerAugmentation(): Extension {
    const plugin = ViewPlugin.fromClass(
        class {
            decorations: DecorationSet
            constructor(view: EditorView) {
                this.decorations = buildBulletMarkers(view)
            }
            update(update: ViewUpdate) {
                if (update.docChanged || update.viewportChanged || foldedRanges(update.startState) !== foldedRanges(update.state)) {
                    this.decorations = buildBulletMarkers(update.view)
                }
            }
        },
        { decorations: (v) => v.decorations },
    )
    return [plugin, theme]
}
