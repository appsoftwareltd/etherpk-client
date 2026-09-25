/**
 * The reusable **content-column clamp** (ADR 0020): a line decoration that hang-indents wrapped
 * lines so every line of a block stays visually aligned to its content column — the bullet's
 * content (one space right of the marker), a continuation line's own indent, or a fenced-code
 * line's fence column. CodeMirror does not hang-indent wrapped lines by default.
 *
 * Two mechanisms, by line kind:
 *
 * - **Fence lines and form-1 openers** carry the classic `padding-left:Wch; text-indent:-Wch`
 *   pair: the first visual row renders at column 0 (its leading spaces already sit there) and
 *   every wrapped row at W.
 * - **Code body lines** carry the padding alone and publish it as `--gk-code-hang`. A body line
 *   never wraps: its text sits in a one-row clipped container (code-scroll.ts, ADR 0094) that
 *   reaches back across the padding to the line's padding edge, so the leading spaces render at
 *   column 0 inside it and every line's container starts at the same x, an unindented line of a
 *   prose fence included (its padding is the panel's own, `CODE_PANEL_PAD_LEFT`).
 * - **Bullets and prose continuation lines** instead have their structural prefix — the leading
 *   indent plus the `- ` / `- [ ] ` marker — LIFTED OUT OF THE FLOW: a `cm-line-prefix` mark
 *   positions it absolutely at the line's left edge, and the line's `padding-left` alone places
 *   the content at the column (no `text-indent`). The hanging pair is a trap for prose: the space
 *   after the marker is a soft-wrap opportunity, so a long unbreakable word (a URL, a token) that
 *   does not fit beside the dot moves WHOLE to the next row, leaving the dot alone on an empty
 *   first row, and `overflow-wrap: anywhere` never fires because a break opportunity existed. With
 *   the marker out of flow the content starts the line: there is nothing to break before the
 *   word, so the browser breaks INSIDE it at the edge and the first row stays beside the dot.
 *   Every lifted prefix keeps its real characters (ADR 0001) so `coordsAtPos`, the guides, and
 *   click mapping still resolve to them; the caret clamp already keeps the caret out of it.
 *
 * Units: `ch` is exact in monospace, so fenced-code lines (tagged `gk-code-line`, themed monospace
 * in code-highlight.ts) align precisely. Prose uses a proportional font where a space is far narrower
 * than 1ch, so a `ch` hang put every wrapped row too far right, by more the deeper the nesting (at
 * four levels, about 40px). Prose rows therefore hang by the MEASURED width of their leading
 * whitespace and marker in the prose font ({@link proseMetricsField}, measured off a canvas with the
 * content element's font and re-measured on zoom); `ch` remains the fallback until the first measure.
 *
 * The same content column is exported as {@link hangWidthForPos} for the image/table block widgets,
 * which pad their own DOM (a replace-widget has no text for `text-indent` to act on).
 */

import { syntaxTree } from '@codemirror/language'
import { type EditorState, type Extension, type Range, StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

import type { FencedBlockRange } from '../../fenced-code'
import { INDENT_UNIT } from '../../indent-unit'
import { contentColumn, continuationFloor, isBulletLine, lineIndent, markerLength, MARKER_WIDTH } from '../../outliner'
import { fencedBlockAtIn, visibleFencedBlocks } from '../outliner-context'
import { treeChanged } from './base-renderer'
import { blockquoteLines } from './blockquote-core'
import { CODE_FONT_SCALE, CODE_PANEL_PAD_LEFT } from './code-highlight'
import { renderCompleted, rendererCollapsedStarts, themeTick } from './rendered-common'
import { CHECKBOX_SLOT } from './task-checkbox'
import { analysisFor } from '../analysis/editor-analysis'

/** Extra visual indent (px) added per nesting level, on top of the source indentation, so the
 *  outline indents read closer to Logseq's spacing. Applied as a uniform `margin-left` (see below). */
export const INDENT_STEP_PX = 12

/** How far a block that is a bullet's content (an inline image or table grid) is dropped below the row
 *  top, so the dot reads as the block's top-left corner and the block is not flush against the row above
 *  — matching the form-1 fenced-code block's feel. The image's reveal placeholder uses the same offset. */
export const BULLET_BLOCK_DROP = '0.35em'

/**
 * The gap a block widget (a block image, a block table, a rendered fence) keeps from the lines above
 * and below it, carried as PADDING on the widget's root, never as margin: CodeMirror measures a block
 * widget by its border box, so a margin is height its map never sees, and every line below the widget
 * maps clicks that much too low, per widget, down the document (ADR 0022;
 * tests-client/block-widget-height-map.test.ts). A root with padding also stops a child's margin
 * collapsing through it (KaTeX's `.katex-display` carries one).
 */
export const BLOCK_WIDGET_SPACING = '0.4em'

/** Left breathing room (in the code font) between the code-block panel's left edge and the code text.
 *  The panel's left edge is aligned to the content column (a sibling bullet's text start), so this is
 *  also how far the code text sits inside the panel. A form-1 opener's fence run is nudged right by the
 *  same amount (`OPENER_FENCE_INSET` in code-highlight.ts) so it lines up with the padded body. */
export const PANEL_PAD = '0.6em'

/**
 * Left breathing room (in the prose font) between a blockquote panel's left rule and the quoted
 * text (markdown-format.ts draws the panel). The panel's left edge is the line's content column —
 * where the line's text would otherwise start — so this is also how far the text sits inside it,
 * on every wrapped row: it is folded into the line's `padding-left`, and the column itself is
 * published as `--gk-quote-inset` for the panel to start at.
 */
const QUOTE_PAD = '0.9em'

/**
 * Extra gap (in the **base** font) inserted between a bullet's dot and its content — and between a
 * continuation line's structural indent and its text — so a plain bullet's text sits the same distance
 * from its dot as a code block's shaded CONTAINER edge sits from its dot. A code block's container edge
 * already starts one {@link PANEL_PAD} left of its code, so without this a plain bullet would read closer
 * to the dot than the code container. Sized to equal `PANEL_PAD` in absolute px: `PANEL_PAD` is `0.6em`
 * of the code font (which is {@link CODE_FONT_SCALE}× the base), so `0.6em × CODE_FONT_SCALE` of the base
 * font is the same width. On a plain bullet the clamp folds it into the line's `padding-left` (the
 * lifted prefix takes no space, so the padding alone places the content); on a form-1 opener, whose
 * `- ` stays in flow, the bullet dot carries it as `margin-right` (bullet-marker.ts).
 */
export const CONTENT_GUTTER = `calc(0.6em * ${CODE_FONT_SCALE})`

/**
 * The structural prefix of a bullet or continuation line, lifted out of the flow (see the module
 * comment). A bullet's covers its indent and marker (`- ` / `- [ ] `, so a task's checkbox rides in
 * it); a continuation line's covers its leading indent. Emitted by THIS augmentation rather than
 * bullet-marker.ts because CodeMirror nests overlapping marks by extension order (a later
 * extension's mark wraps an earlier one's): the clamp is registered after bullet-marker and
 * task-checkbox (editor-extensions.ts), so the prefix is the OUTER span and the dot / checkbox marks
 * sit inside it as one absolutely positioned box. Emitted from an earlier extension it would be
 * split around them into several boxes, each positioned at the line's left.
 */
const bulletPrefix = Decoration.mark({ class: 'cm-line-prefix cm-line-prefix--bullet' })
const proseIndentPrefix = Decoration.mark({ class: 'cm-line-prefix cm-line-prefix--indent' })

/**
 * Px to pull a fenced code block LEFT, keyed by its nesting depth. A code line sits `fenceColumn`
 * monospace source-spaces in; rendered in mono those are wider than a sibling bullet's proportional
 * prefix, so without correction the block lands further right (the gap growing with depth). The shift
 * is MEASURED directly — the rendered gap between a code block's PANEL LEFT EDGE and its owning bullet's
 * content — so the grey background starts exactly where a sibling's text starts, the code padded inside.
 * It needs no font modelling and tracks zoom. Held in state so the synchronous clamp build can read it;
 * empty until the first measure. The gap is identical for every block at a depth (same fence column,
 * same owning-bullet column), so one measurement per depth suffices.
 */
const setCodeShifts = StateEffect.define<ReadonlyMap<number, number>>()
/** Exported for the code-scroll bars, which sit on the shifted lines and re-measure when a shift lands. */
export const codeShiftsField = StateField.define<ReadonlyMap<number, number>>({
    create: () => new Map(),
    update(value, tr) {
        for (const e of tr.effects) if (e.is(setCodeShifts)) value = e.value
        return value
    },
})

/**
 * The key a code block's measured shift is cached under. The gap between a block's panel edge and its
 * owner's text column is fixed by the fence column (mono) and the owner's indent (proportional) alone —
 * the pair rather than a nesting depth, so text off the Indent Unit grid (a fence six columns in under
 * a bullet at four, say) measures its own gap instead of borrowing a two-space block's (ADR 0067).
 */
const shiftKey = (fenceColumn: number, ownerIndent: number) => fenceColumn * 1024 + ownerIndent

/** The x (viewport px) of the glyph boundary at `pos`. `side` (-1 = bias to the char before `pos`,
 *  1 = the char after) picks which side's coords to read at a boundary — used to read a form-1 opener's
 *  content column from BEFORE its fence nudge. Null if not laid out. */
function glyphX(view: EditorView, pos: number, side: -1 | 1 = 1): number | null {
    const c = view.coordsAtPos(pos, side)
    return c ? c.left : null
}

/** The `.cm-line` element containing `pos`, or null. */
function lineElAt(view: EditorView, pos: number): HTMLElement | null {
    let el: Node | null = view.domAtPos(pos).node
    if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement
    while (el && !(el as HTMLElement).classList?.contains('cm-line')) el = (el as HTMLElement).parentElement
    return (el as HTMLElement) ?? null
}

/**
 * The x (viewport px) of a code line's shaded PANEL left edge — the `::after` rectangle's left, which is
 * `--code-inset` from the line's (margin-excluded) box. This is what we align to a sibling bullet's
 * content column, so the grey background starts exactly where the sibling's text does (the code itself
 * then sits PANEL_PAD inside). Null if the line isn't laid out yet.
 */
function panelEdgeX(view: EditorView, pos: number): number | null {
    const el = lineElAt(view, pos)
    if (!el) return null
    const inset = parseFloat(getComputedStyle(el, '::after').left) || 0
    return el.getBoundingClientRect().left + inset
}

/**
 * Measure, per depth, how far a code block's PANEL LEFT EDGE sits to the right of its owning bullet's
 * TEXT column, and fold that into the existing shifts — so the grey container's left edge lands exactly
 * where a sibling bullet's text starts (the code itself then sits PANEL_PAD further inside). One pass
 * over the complete fenced blocks; for each new depth we find the nearest bullet above the block (its
 * owner) and compare rendered x's. Because the shift is already applied when we measure, the residual gap
 * is exactly the remaining correction, so it converges in a single step.
 */
function measureCodeShifts(view: EditorView, current: ReadonlyMap<number, number>): ReadonlyMap<number, number> | null {
    const { state } = view
    const { lines, outline } = analysisFor(state)
    const next = new Map(current)
    const done = new Set<number>()
    let changed = false
    for (const block of visibleFencedBlocks(state)) {
        // Skip top-level code (no correction needed there) and code owned by no bullet (under a prose
        // line: nothing to align to). The alignment owner: for a form-1 block (`- ``` `) the opener IS
        // the bullet, so its own content column — the fence run, sitting on the proportional column
        // thanks to the prose-prefix mark — is the target (minus the fence's panel nudge; see below).
        // Otherwise it is the bullet whose block the fence is inside, as the outline walk reads it.
        const owner = outline[block.start]?.owner ?? -1
        if (block.fenceColumn === 0 || owner < 0) continue
        // Both forms align to the same content column under one owner indent, so one measurement per
        // (fence column, owner indent) pair suffices.
        const key = shiftKey(block.fenceColumn, lineIndent(lines[owner]))
        if (done.has(key)) continue
        const contentLine = state.doc.line(block.start + 2) // first line after the opener fence
        const codeX = panelEdgeX(view, contentLine.from)
        const ownerLine = state.doc.line(owner + 1)
        // The owner bullet's TEXT column (it carries the CONTENT_GUTTER, so it sits a gutter right of the
        // marker). For a form-2 owner that's the glyph right at the marker end. For a form-1 owner the
        // marker end coincides with the opener's own fence run, which is ALSO nudged right (PANEL_PAD) to
        // pad it inside the panel — so read it LEFT-biased to get the column the gutter has pushed it to,
        // before that fence nudge. Both land on the same "where a sibling bullet's text starts" column.
        const ownerAnchor = ownerLine.from + lineIndent(lines[owner]) + markerLength(lines[owner])
        const ownerX = glyphX(view, ownerAnchor, owner === block.start ? -1 : 1)
        if (codeX === null || ownerX === null) continue
        done.add(key)
        const shift = (current.get(key) ?? 0) + (codeX - ownerX)
        if (Math.abs(shift - (current.get(key) ?? 0)) > 0.5) changed = true
        next.set(key, shift)
    }
    return changed ? next : null
}

/** Widths (px) of a space and of the bullet dash in the prose font, or null before the first measure. */
export interface ProseMetrics {
    space: number
    dash: number
}

const setProseMetrics = StateEffect.define<ProseMetrics | null>()

/** The measured prose metrics; `null` until the measurer has read the content font. */
export const proseMetricsField = StateField.define<ProseMetrics | null>({
    create: () => null,
    update(value, tr) {
        for (const e of tr.effects) if (e.is(setProseMetrics)) return e.value
        return value
    },
})

/**
 * Measure a space and a dash in the content element's font. A canvas shapes text with the same font
 * the DOM uses, so this costs no layout and no foreign nodes in CodeMirror's content DOM. Returns null
 * when nothing can be measured (no canvas, a font that has not resolved yet).
 */
function measureProseMetrics(view: EditorView): ProseMetrics | null {
    const cs = getComputedStyle(view.contentDOM)
    const font = cs.font || `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx || !font.trim()) return null
    ctx.font = font
    const space = ctx.measureText(' ').width
    const dash = ctx.measureText('-').width
    if (!(space > 0) || !(dash > 0)) return null
    return { space, dash }
}

/**
 * How far right of the text area's left edge (`.cm-content`'s content box) a bullet's dot is
 * centred, by this module's layout: the line's `margin-left` for its outline depth, then its prefix,
 * which starts at the line's left edge (lifted to `left: 0`, or a form-1 opener's first row, where
 * `text-indent` cancels the padding), across the leading spaces to the middle of the dash the dot is
 * painted over (bullet-marker.ts). The outline guides place a bullet that is not rendered with it.
 */
export function bulletDotOffset(depth: number, indent: number, metrics: ProseMetrics): number {
    return depth * INDENT_STEP_PX + indent * metrics.space + metrics.dash / 2
}

function metricsEqual(a: ProseMetrics | null, b: ProseMetrics | null): boolean {
    if (a === null || b === null) return a === b
    return Math.abs(a.space - b.space) < 0.05 && Math.abs(a.dash - b.dash) < 0.05
}

/** The content column (in characters) for the line containing `pos` — the clamp anchor. */
export function hangWidthForPos(state: EditorState, pos: number): number {
    const line = state.doc.lineAt(pos)
    return isBulletLine(line.text) ? contentColumn(line.text) : lineIndent(line.text)
}

interface LineClamp {
    cols: number
    code: boolean
    /** A code line between the fences: the one kind that carries a scroll container (code-scroll.ts). */
    body: boolean
    /** This line carries the code-block panel: a code line, OR a form-1 opener (`- ``` `, a bullet line
     *  that opens a block). The panel's left inset is set here so opener and shifted body lines align. */
    panel: boolean
    /** The block's fence column, when this line carries a panel (the panel-inset anchor). */
    fenceCol: number
    /** This panel line is a form-1 opener (a bullet line). It is NOT shifted (it anchors the block via
     *  its prose-rendered `- ` marker), so its panel inset compensates for the body lines' left shift. */
    opener: boolean
    /** A plain bullet line (NOT a form-1 opener): its content carries the {@link CONTENT_GUTTER} so its
     *  text sits the same distance from the dot as a code block's text from its panel. */
    bullet: boolean
}

function classifyLine(
    state: EditorState,
    lineFrom: number,
    lineText: string,
    collapsedStarts: Set<number>,
    visibleBlocks: readonly FencedBlockRange[],
    frontmatterEnd: number,
): LineClamp {
    // A line of [[Frontmatter]] is neither a bullet nor prose to clamp: it is verbatim YAML in a
    // panel the frontmatter augmentation draws, and a `- item` there is a list entry (ADR 0061).
    if (lineFrom <= frontmatterEnd) {
        return { cols: 0, code: false, body: false, panel: false, fenceCol: 0, opener: false, bullet: false }
    }
    // A `- item` INSIDE a fence (content or closer, not the opener) is code, whatever it looks like.
    const enclosing = fencedBlockAtIn(state, lineFrom, visibleBlocks)
    const insideFence = enclosing !== null && enclosing.from !== lineFrom
    if (isBulletLine(lineText) && !insideFence) {
        // A form-1 opener is a bullet line that also opens a code block — it carries the panel too.
        // UNLESS the block is collapsed to a rendered widget (ADR 0022): then the visible part of
        // the line is just `[indent]- ` + the widget, and it must read as a plain bullet (no code
        // panel, no mono font) — the interior lines are hidden entirely.
        const block = fencedBlockAtIn(state, lineFrom, visibleBlocks)
        const collapsed = block !== null && collapsedStarts.has(state.doc.lineAt(block.from).number - 1)
        const opener = block !== null && block.from === lineFrom && !collapsed
        return {
            cols: contentColumn(lineText),
            code: false,
            body: false,
            panel: opener,
            fenceCol: opener ? block.fenceColumn : 0,
            opener,
            bullet: !opener,
        }
    }
    // A non-bullet line: code line (inside a fence) gets the monospace class; otherwise plain prose.
    const block = fencedBlockAtIn(state, lineFrom, visibleBlocks)
    const cols = lineIndent(lineText)
    // Prose masks its whole indent; code masks only up to the fence column (the panel covers the rest).
    return {
        cols,
        code: block !== null,
        body: block !== null && lineFrom !== block.from && lineFrom !== state.doc.lineAt(block.to).from,
        panel: block !== null,
        fenceCol: block ? block.fenceColumn : 0,
        opener: false,
        bullet: false,
    }
}

function buildClamp(view: EditorView): DecorationSet {
    const { state } = view
    const codeShifts = state.field(codeShiftsField)
    const metrics = state.field(proseMetricsField)
    const collapsedStarts = rendererCollapsedStarts(state)
    const visibleBlocks = visibleFencedBlocks(state)
    const { frontmatterEnd, outline } = analysisFor(state)
    const docLines = analysisFor(state).lines as string[] // the shared analysis lines; read only
    const decos: Range<Decoration>[] = []
    // A line with an inline widget (e.g. a `- ![…]` image) splits `visibleRanges`; dedupe by line start so
    // a line straddling that gap isn't decorated twice (it's reached from both ranges — see bullet-marker).
    const seen = new Set<number>()
    for (const { from, to } of view.visibleRanges) {
        // The blockquote lines in this range: their text is padded inside the quote panel (below).
        const quoteLines = blockquoteLines(syntaxTree(state), state.doc, from, to)
        let pos = from
        while (pos <= to) {
            const line = state.doc.lineAt(pos)
            if (seen.has(line.from)) {
                pos = line.to + 1
                continue
            }
            seen.add(line.from)
            const { cols, code, body, panel, fenceCol, opener, bullet } = classifyLine(
                state,
                line.from,
                line.text,
                collapsedStarts,
                visibleBlocks,
                frontmatterEnd,
            )
            // A quoted line's text sits QUOTE_PAD inside the panel markdown-format.ts draws from its content
            // column. A code line is never quoted here: its panel is the code block's (fence lines inside a
            // quote are an edge the parser and the fence scan already disagree on; the code panel wins).
            const quote = quoteLines.has(line.number) && !code && !panel && line.from > frontmatterEnd
            if (cols > 0 || code || panel || quote) {
                const classes: string[] = []
                if (code) classes.push('gk-code-line')
                // Bullets and prose continuation lines: the prefix is lifted out of the flow (module
                // comment), so `padding-left` alone places the content — the prefix's own measured width
                // (leading whitespace and, for a bullet, its `- ` marker, in the prose font; `ch` only
                // until the first measure lands) plus the CONTENT_GUTTER that widens the dot→text gap to
                // match a code block's. A task's padding also spans its checkbox slot and the space after
                // it, so its wrapped rows hang under its text, not under the box. Code lines and form-1
                // openers keep the classic hang-indent pair (their text is positioned by the panel
                // machinery, and an opener's `- ` stays in flow, the dot carrying the gutter).
                const proseHang = (indentCols: number, marker: boolean): string =>
                    metrics
                        ? `${(indentCols * metrics.space + (marker ? metrics.dash + metrics.space : 0)).toFixed(2)}px`
                        : `${indentCols + (marker ? 2 : 0)}ch`
                let style = ''
                // The quote panel's left edge — the line's content column, where its text starts when it is not
                // quoted — published for the panel; a quoted line's padding then carries the text QUOTE_PAD past it.
                const quotePad = quote ? ` + ${QUOTE_PAD}` : ''
                let contentEdge = '0px'
                if (bullet) {
                    const hang = proseHang(cols - 2, true)
                    const marker = markerLength(line.text)
                    const task = marker > MARKER_WIDTH
                    const space = metrics ? `${metrics.space.toFixed(2)}px` : '1ch'
                    const checkbox = task ? ` + ${CHECKBOX_SLOT} + ${space}` : ''
                    contentEdge = `calc(${hang} + ${CONTENT_GUTTER}${checkbox})`
                    style = `padding-left:calc(${hang} + ${CONTENT_GUTTER}${checkbox}${quotePad})`
                    classes.push('gk-prefixed')
                    decos.push(bulletPrefix.range(line.from, line.from + lineIndent(line.text) + marker))
                } else if (!code && !panel && cols > 0) {
                    // A bullet's continuation line: two of its indent columns stand in for the owner's `- `,
                    // so it hangs at the marker's measured width, not two spaces' — a space is narrower than
                    // a dash, and at two spaces its text (and a quote panel's edge) sat left of the owner's,
                    // a visible stagger on a quoted bullet's soft lines (2026-09-14). Other indented prose
                    // hangs at its own spaces.
                    const soft = cols >= MARKER_WIDTH && continuationFloor(docLines, line.number - 1) > 0
                    const hang = soft ? proseHang(cols - MARKER_WIDTH, true) : proseHang(cols, false)
                    contentEdge = `calc(${hang} + ${CONTENT_GUTTER})`
                    style = `padding-left:calc(${hang} + ${CONTENT_GUTTER}${quotePad})`
                    classes.push('gk-prefixed')
                    decos.push(proseIndentPrefix.range(line.from, line.from + cols))
                } else if (body) {
                    // Padding only, published as `--gk-code-hang` (module comment): the scroll container
                    // reaches back across it, so no negative text-indent is needed to place the leading
                    // spaces, and an unindented line's reach is the theme's panel padding. A fence line
                    // has no container and keeps the pair below.
                    // An unindented line has no leading spaces to fill its reach, so the container pads
                    // itself by the same amount (`--gk-code-inner`) and the text stays on the code column.
                    style = cols > 0
                        ? `padding-left:${cols}ch;--gk-code-hang:${cols}ch`
                        : `--gk-code-hang:${CODE_PANEL_PAD_LEFT};--gk-code-inner:${CODE_PANEL_PAD_LEFT}`
                } else if (cols > 0) {
                    style = `padding-left:${cols}ch;text-indent:-${cols}ch`
                } else if (quote) {
                    style = `padding-left:${QUOTE_PAD}` // top-level prose: the panel starts at the line's edge
                }
                if (quote) style += `;--gk-quote-inset:${contentEdge}`
                // Widen each nesting level visually (Logseq-like). `margin-left` shifts the whole line —
                // marker, content, mask and any code panel together — so every internal alignment is
                // preserved while the indent grows. For every line a bullet owns, depth is the line's
                // STRUCTURAL depth from the outline walk (ADR 0067): a bullet's own level, and for a
                // continuation line, a code line or a BLANK row inside a code block the owning bullet's
                // level, so a whole block shares one margin (a blank row shifting left would notch the
                // panel) and a four-space child sits at the same depth as a two-space one. Prose owned by
                // no bullet is on no grid; its margin stays what its own columns always gave it.
                const info = outline[line.number - 1]
                const depth = info && info.owner >= 0 ? info.depth : Math.max(0, Math.floor(((panel ? fenceCol : cols) - MARKER_WIDTH) / INDENT_UNIT))
                const ownerIndent = info && info.owner >= 0 ? lineIndent(docLines[info.owner]) : -1
                const shift = ownerIndent >= 0 ? (codeShifts.get(shiftKey(fenceCol, ownerIndent)) ?? 0) : 0
                // Code body/closer lines shift LEFT by the measured per-depth amount, to land the block's
                // shaded PANEL LEFT EDGE on the proportional content column of their sibling bullets — so
                // the grey background starts where a sibling's text starts, with the code padded PANEL_PAD
                // inside it (the margin can go slightly negative — that's the correction). A form-1 opener
                // is NOT shifted: its prose-rendered `- ` marker already anchors it, so it stays put and
                // its panel inset (below) absorbs the difference.
                const margin = depth * INDENT_STEP_PX - (code && fenceCol > 0 ? shift : 0)
                if (Math.round(margin) !== 0) style += `;margin-left:${Math.round(margin)}px`
                // The panel's left edge: `PANEL_PAD` left of the code text. Code body/closer lines sit
                // `fenceCol` mono-spaces in (then the line is shifted by `margin`); the opener is unshifted
                // but its body lines were pulled left by `shift`, so its inset adds `shift` back to keep the
                // one panel rectangle straight across opener and body.
                if (panel) {
                    const openerComp = opener ? ` - ${Math.round(shift)}px` : ''
                    // A prose-owned block (fence column 0) anchors its panel AT the content edge — the same
                    // x as a top-level bullet's dot and plain prose text — rather than PANEL_PAD left of it
                    // (the negative inset only makes sense inside a bullet, where the panel edge marks the
                    // content column and the code is padded within it).
                    const inset = fenceCol > 0 ? `calc(${fenceCol}ch - ${PANEL_PAD}${openerComp})` : '0px'
                    style += `;--code-inset:${inset}`
                }
                const spec: { class?: string; attributes?: Record<string, string> } = {}
                if (classes.length) spec.class = classes.join(' ')
                if (style) spec.attributes = { style }
                decos.push(Decoration.line(spec).range(line.from))
            }
            pos = line.to + 1
        }
    }
    // Line decorations sort before marks at the same position; `sort: true` orders the rest.
    return Decoration.set(decos, true)
}

const theme = EditorView.baseTheme({
    // A line whose prefix is lifted (module comment): the containing block for the prefix, and at
    // least one row tall — an EMPTY bullet (`- `) has nothing left in the flow once its marker is
    // lifted, and without the strut its box would collapse to nothing. `--gk-line-pitch` is the
    // content's line height (cm-document.ts), so the strut is exactly one row.
    '.cm-line.gk-prefixed': { position: 'relative', minHeight: 'var(--gk-line-pitch)' },
    // The lifted prefix: out of the flow, at the line's left padding edge — the same x the in-flow
    // marker used to occupy — and on the first row (no `top`: the static position keeps it on the
    // row its characters would have started). `pre` keeps its leading spaces from collapsing or
    // wrapping; `text-indent: 0` because the property inherits into the positioned box.
    '.cm-line-prefix': { position: 'absolute', left: '0', whiteSpace: 'pre', textIndent: '0' },
    // A continuation line's indent sits one gutter in, where its in-flow spaces used to start, so a
    // caret resolved against the prefix's right edge lands on the content column.
    '.cm-line-prefix--indent': { left: CONTENT_GUTTER },
})

/** The content-column clamp augmentation (ADR 0020). Mounted in DocumentView alongside the others. */
export function contentClampAugmentation(): Extension {
    const plugin = ViewPlugin.fromClass(
        class {
            decorations: DecorationSet
            constructor(view: EditorView) {
                this.decorations = buildClamp(view)
            }
            update(update: ViewUpdate) {
                const shiftsChanged =
                    update.startState.field(codeShiftsField) !== update.state.field(codeShiftsField) ||
                    update.startState.field(proseMetricsField) !== update.state.field(proseMetricsField)
                // themeTick / renderCompleted change the rendered-fence collapse state without a doc
                // or selection change — the opener declassification must follow (rendered-common.ts).
                const ticked = update.transactions.some((tr) =>
                    tr.effects.some((e) => e.is(themeTick) || e.is(renderCompleted)),
                )
                // The quote inset reads the syntax tree, which the parser can advance in a transaction that
                // changes nothing else (base-renderer.ts → hiddenSyntaxPlugin).
                if (
                    update.docChanged ||
                    update.viewportChanged ||
                    update.selectionSet ||
                    shiftsChanged ||
                    ticked ||
                    treeChanged(update)
                ) {
                    this.decorations = buildClamp(update.view)
                }
            }
        },
        { decorations: (v) => v.decorations },
    )

    // Measures the code-vs-bullet alignment gap per depth (after layout, on edits, and on zoom) and
    // publishes it to the field, which triggers the clamp to rebuild with the correction. The dispatch
    // is deferred out of the measure phase (you can't dispatch mid-update).
    const measurer = ViewPlugin.fromClass(
        class {
            private raf = 0
            private warmup: ReturnType<typeof setTimeout>
            constructor(view: EditorView) {
                this.schedule(view)
                this.warmup = setTimeout(() => this.schedule(view), 250) // cold-start insurance
            }
            update(update: ViewUpdate) {
                if (update.docChanged || update.geometryChanged) this.schedule(update.view)
            }
            schedule(view: EditorView) {
                view.requestMeasure({
                    key: 'code-indent-shifts',
                    read: () => ({
                        shifts: measureCodeShifts(view, view.state.field(codeShiftsField)),
                        metrics: measureProseMetrics(view),
                    }),
                    write: ({ shifts, metrics }) => {
                        const metricsChanged = !metricsEqual(metrics, view.state.field(proseMetricsField))
                        if (!shifts && !metricsChanged) return
                        if (this.raf) cancelAnimationFrame(this.raf)
                        this.raf = requestAnimationFrame(() => {
                            this.raf = 0
                            const effects: StateEffect<unknown>[] = []
                            if (shifts && shifts !== view.state.field(codeShiftsField)) effects.push(setCodeShifts.of(shifts))
                            if (!metricsEqual(metrics, view.state.field(proseMetricsField))) effects.push(setProseMetrics.of(metrics))
                            if (effects.length) view.dispatch({ effects })
                        })
                    },
                })
            }
            destroy() {
                if (this.raf) cancelAnimationFrame(this.raf)
                clearTimeout(this.warmup)
            }
        },
    )

    return [codeShiftsField, proseMetricsField, plugin, measurer, theme]
}
