/**
 * Code never soft-wraps (ADR 0094; Editor Content Rules → Fenced Code Blocks → Presentation).
 *
 * Every body line of a complete [[Fenced Code Block]] is wrapped in one mark span: an inline-block
 * spanning the line's content column that clips what does not fit. The block's lines scroll
 * sideways TOGETHER. One CSS custom property per block on the editor's scroller
 * (`--gk-code-scroll-<opener>`, the opener line's document offset) carries the offset, and each
 * span's `text-indent` reads it, so a short `}` line slides out of view under the clip exactly as
 * it would in a `<pre>`, and a line CodeMirror renders later (a block taller than the viewport)
 * picks the offset up on arrival. A bar below the last body line is the affordance, present only
 * while the widest laid-out line overflows the panel. The bar is a block widget from a state
 * field (a view plugin may not supply block decorations), and the set of
 * overflowing blocks reaches that field through an effect dispatched after the measure, the same
 * route the content clamp's per-depth shift takes.
 *
 * Why not a real scroll container per line: `scrollLeft` cannot exceed a line's own width, so a
 * short line would stay put while the body scrolled past it; and CodeMirror re-applies a mark's
 * attributes whenever a mutation touches its span, so an inline style on the span is wiped on
 * the next update. The scroller is outside the observed subtree, CodeMirror never writes its
 * style attribute, and one property moves every line of the block.
 *
 * The caret is kept in view here rather than by CodeMirror: its reveal walks ancestor SCROLL
 * containers, and a clipped span is none. After any transaction that asks for the caret to be
 * scrolled into view, the measure phase nudges the block so the caret's rect sits inside its span.
 * That nudge is written during the measure's READ phase, from a plugin at the highest precedence:
 * CodeMirror runs every plugin's read before any write, in plugin order, and the caret layer
 * (`drawSelection`) reads the caret's position in its own read, so a shift written in a write
 * phase left the caret drawn where the text used to be until the next selection change. The
 * marks live in a second, default-precedence plugin: a plugin's decorations take its precedence,
 * and the container must nest OUTSIDE the highlight tokens, which a highest-precedence mark would not.
 *
 * The arithmetic (body range, the overflow set, thumb geometry, wheel routing) is pure in
 * `code-scroll-core.ts`; the browser rows are in `tests-client/fenced-code-scroll.test.ts`.
 */

import { type EditorState, type Extension, Prec, type Range, StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view'

import { visibleFencedBlocks } from '../outliner-context'
import { CODE_FONT_SCALE, CODE_PANEL_PAD_RIGHT } from './code-highlight'
import { codeShiftsField, PANEL_PAD } from './content-clamp'
import {
    clampScroll,
    fenceBodyRange,
    mapOverflowing,
    mergeOverflowing,
    scrollForThumbDelta,
    scrollForTrackClick,
    thumbGeometry,
    wheelHorizontalDelta,
} from './code-scroll-core'
import { renderCompleted, rendererCollapsedStarts, themeTick } from './rendered-common'

/** The thumb never shrinks below this, so a very long line still leaves something to grab. */
const MIN_THUMB_PX = 24
/** How far inside the span's visible edge the caret is kept when it is revealed. */
const REVEAL_MARGIN_PX = 6

/** The scroller's custom property carrying a block's offset. Keyed by the opener line's start offset. */
const shiftProperty = (opener: number) => `--gk-code-scroll-${opener}`
const SHIFT_PROPERTY_PREFIX = '--gk-code-scroll-'

/** A complete, revealed block with at least one body line: what scrolls. */
interface ScrollableBlock {
    /** The opener line's start offset: the block's key across a transaction. */
    opener: number
    /** Offsets of the first body line's start and the last body line's end (the bar's anchor and the marks' range). */
    bodyFrom: number
    bodyTo: number
    /** 1-based line numbers of the body. */
    firstLine: number
    lastLine: number
}

function scrollableBlocks(state: EditorState): ScrollableBlock[] {
    const collapsed = rendererCollapsedStarts(state)
    const out: ScrollableBlock[] = []
    for (const block of visibleFencedBlocks(state)) {
        // A block collapsed to its rendered widget shows no lines to scroll (ADR 0022).
        if (collapsed.has(block.start)) continue
        const body = fenceBodyRange(block)
        if (!body) continue
        out.push({
            opener: state.doc.line(block.start + 1).from,
            bodyFrom: state.doc.line(body.first + 1).from,
            bodyTo: state.doc.line(body.last + 1).to,
            firstLine: body.first + 1,
            lastLine: body.last + 1,
        })
    }
    return out
}

// ── The overflowing set: which blocks show a bar ──────────────────────────────────────────────

/**
 * An opener's key carried through a change: mapped forward, then snapped to its line's start. A
 * newline typed at the opener's start moves the opener down with it (forward mapping); an indent
 * inserted there (Tab on the fence line) must leave the key AT the line's start, or the bar and
 * the scroll position of the block are lost until the next measure. A key that no longer starts
 * an opener is dropped at the next merge.
 */
function mapOpener(state: EditorState, changes: { mapPos(pos: number, assoc: number): number }, opener: number): number {
    return state.doc.lineAt(changes.mapPos(opener, 1)).from
}

const setOverflowing = StateEffect.define<ReadonlySet<number>>()

/** Opener offsets of the blocks whose widest laid-out line overflows the panel (the measure's verdict). */
const overflowingField = StateField.define<ReadonlySet<number>>({
    create: () => new Set(),
    update(value, tr) {
        let next = value
        if (tr.docChanged && next.size) next = mapOverflowing(next, (pos) => mapOpener(tr.state, tr.changes, pos))
        for (const e of tr.effects) if (e.is(setOverflowing)) next = e.value
        return next
    },
})

// ── The bar ──────────────────────────────────────────────────────────────────────────────────

/**
 * The block's scrollbar: a track with a thumb, drawn on the panel background so the strip reads
 * as part of the block. Equal to another of the same block, and updated in place when only the
 * block's offset moved (a keystroke above it), so the DOM survives every rebuild.
 */
class ScrollbarWidget extends WidgetType {
    constructor(readonly opener: number) {
        super()
    }

    eq(other: ScrollbarWidget): boolean {
        return other.opener === this.opener
    }

    updateDOM(dom: HTMLElement): boolean {
        if (!dom.classList.contains('gk-code-scrollbar')) return false
        dom.dataset.gkCodeBlock = String(this.opener)
        return true
    }

    toDOM(view: EditorView): HTMLElement {
        const bar = document.createElement('div')
        bar.className = 'gk-code-scrollbar'
        bar.setAttribute('data-augmentation', 'code-scroll')
        bar.dataset.gkCodeBlock = String(this.opener)
        // Where the panel starts, from the block's last measure, so the first paint is already
        // aligned: the measure that follows this mount lands a frame later.
        const margin = view.plugin(codeScrollPlugin)?.barMarginOf(this.opener)
        if (margin !== undefined) bar.style.marginLeft = `${margin}px`
        // A pointer affordance only: the caret keeps the keyboard path, and the reveal follows it.
        bar.setAttribute('aria-hidden', 'true')
        const track = bar.appendChild(document.createElement('div'))
        track.className = 'gk-code-scrollbar-track'
        const thumb = track.appendChild(document.createElement('div'))
        thumb.className = 'gk-code-scrollbar-thumb'

        // The block is read from the dataset at event time: `updateDOM` moves it when the opener does.
        const opener = () => Number(bar.dataset.gkCodeBlock)
        const controller = () => view.plugin(codeScrollPlugin)
        // Keep the editor's focus and selection where they are: the bar is not a place to put a caret.
        bar.addEventListener('mousedown', (e) => e.preventDefault())
        let drag: { startX: number; startScroll: number; trackPx: number; thumbPx: number } | null = null
        thumb.addEventListener('pointerdown', (e) => {
            const c = controller()
            if (!c || e.button !== 0) return
            e.preventDefault()
            e.stopPropagation()
            drag = { startX: e.clientX, startScroll: c.scrollOf(opener()), trackPx: track.clientWidth, thumbPx: thumb.offsetWidth }
            thumb.setPointerCapture(e.pointerId)
            bar.classList.add('gk-code-scrollbar--dragging')
        })
        thumb.addEventListener('pointermove', (e) => {
            const c = controller()
            if (!drag || !c) return
            const key = opener()
            c.scrollTo(key, scrollForThumbDelta(drag.startScroll, e.clientX - drag.startX, drag.trackPx, drag.thumbPx, c.overflowOf(key)))
        })
        const endDrag = (e: PointerEvent) => {
            if (!drag) return
            drag = null
            bar.classList.remove('gk-code-scrollbar--dragging')
            if (thumb.hasPointerCapture(e.pointerId)) thumb.releasePointerCapture(e.pointerId)
        }
        thumb.addEventListener('pointerup', endDrag)
        thumb.addEventListener('pointercancel', endDrag)
        // A click on the track (not the thumb) centres the thumb under the pointer.
        track.addEventListener('pointerdown', (e) => {
            const c = controller()
            if (!c || e.button !== 0 || e.target === thumb) return
            e.preventDefault()
            const key = opener()
            const x = e.clientX - track.getBoundingClientRect().left
            c.scrollTo(key, scrollForTrackClick(x, track.clientWidth, thumb.offsetWidth, c.overflowOf(key)))
        })
        return bar
    }

    ignoreEvent(event: Event): boolean {
        // The bar handles its own pointer events, and CodeMirror must not start a selection from
        // them. A wheel is the exception: CodeMirror routes plugin event handlers only for events
        // it owns, and the wheel over a bar must reach the handler that scrolls the block.
        return event.type !== 'wheel'
    }
}

function buildBars(state: EditorState): DecorationSet {
    const overflowing = state.field(overflowingField)
    if (overflowing.size === 0) return Decoration.none
    const decos: Range<Decoration>[] = []
    for (const b of scrollableBlocks(state)) {
        if (!overflowing.has(b.opener)) continue
        decos.push(Decoration.widget({ widget: new ScrollbarWidget(b.opener), block: true, side: 1 }).range(b.bodyTo))
    }
    return Decoration.set(decos, true)
}

/** The bar, a block widget: a plugin may not provide those, so it comes from a field. */
const barsField = StateField.define<DecorationSet>({
    create: buildBars,
    update(decos, tr) {
        const overflowChanged = tr.startState.field(overflowingField) !== tr.state.field(overflowingField)
        // themeTick / renderCompleted change which blocks are collapsed to a rendered widget, and
        // the block scan is caret-aware (a half-typed fence), so a selection change can move a bar.
        const ticked = tr.effects.some((e) => e.is(themeTick) || e.is(renderCompleted))
        if (tr.docChanged || tr.selection || overflowChanged || ticked) return buildBars(tr.state)
        return decos
    },
    provide: (f) => EditorView.decorations.from(f),
})

// ── The scroll containers and the controller ─────────────────────────────────────────────────

/**
 * The mark over a body line. Per block, because the span's `text-indent` reads that block's
 * offset property; two marks with equal attributes compare equal, so a rebuild reuses the span.
 */
function containerMark(opener: number): Decoration {
    return Decoration.mark({
        class: 'gk-code-scroll',
        attributes: { style: `--gk-code-shift:var(${shiftProperty(opener)},0px)` },
    })
}

function buildContainers(view: EditorView): DecorationSet {
    const { state, viewport } = view
    const decos: Range<Decoration>[] = []
    for (const b of scrollableBlocks(state)) {
        if (b.bodyTo < viewport.from || b.bodyFrom > viewport.to) continue
        const mark = containerMark(b.opener)
        for (let n = b.firstLine; n <= b.lastLine; n++) {
            const line = state.doc.line(n)
            if (line.to < viewport.from) continue
            if (line.from > viewport.to) break
            if (line.length > 0) decos.push(mark.range(line.from, line.to)) // an empty line has nothing to clip
        }
    }
    return Decoration.set(decos, true)
}

/** What the last measure knew about a block, and where it is scrolled to. */
interface BlockMetrics {
    scroll: number
    /** The bar's `margin-left` (px): the line's box left plus the panel inset, from the content's padding edge. */
    barMarginLeft: number
    /** The span's visible width (px): the same for every line of the block. */
    visible: number
    /** How far (px) the widest laid-out line extends past `visible`; 0 when the block fits. */
    overflow: number
    /** The bar's track width (px), for the thumb's grab minimum. */
    trackPx: number
}

interface MeasuredBlock {
    opener: number
    visible: number
    overflow: number
    trackPx: number
    /** The bar's `margin-left` (px): the line's box left plus the panel inset, from the content's padding edge. */
    barMarginLeft: number
    bars: HTMLElement[]
    /**
     * The offset a reveal must set to bring the caret inside its span, or null when no reveal was
     * asked for or the caret is in view. Computed from the offset the DOM was painted with when
     * the caret was measured, not the stored one: the two differ for a frame when the block's key
     * moved (its property is unset until this measure) and the sum would overshoot.
     */
    revealTarget: number | null
}

interface Measurement {
    blocks: MeasuredBlock[]
    /** Opener offsets of every scrollable block in the document, laid out or not. */
    live: Set<number>
}

/** The `.cm-line` element containing `pos`, or null when CodeMirror has not rendered it. */
function lineElementAt(view: EditorView, pos: number): HTMLElement | null {
    let el: Node | null = view.domAtPos(pos).node
    if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement
    while (el && !(el as HTMLElement).classList?.contains('cm-line')) el = (el as HTMLElement).parentElement
    return (el as HTMLElement | null) ?? null
}

/**
 * How far (px) a span's text reaches from the span's left edge, independent of the current
 * offset: the union of its text rects plus the span's own left padding (an unindented line's).
 */
function textReach(span: HTMLElement): number {
    const range = document.createRange()
    range.selectNodeContents(span)
    return range.getBoundingClientRect().width + (parseFloat(getComputedStyle(span).paddingLeft) || 0)
}


function measureBlocks(view: EditorView, reveal: boolean): Measurement {
    const { state, viewport } = view
    const blocks = scrollableBlocks(state)
    const live = new Set(blocks.map((b) => b.opener))
    const head = state.selection.main.head
    const headLine = state.doc.lineAt(head).number
    const contentRect = view.contentDOM.getBoundingClientRect()
    const contentPadLeft = parseFloat(getComputedStyle(view.contentDOM).paddingLeft) || 0
    const measured: MeasuredBlock[] = []
    for (const b of blocks) {
        if (b.bodyTo < viewport.from || b.bodyFrom > viewport.to) continue
        let firstLineEl: HTMLElement | null = null
        let visible = 0
        let extent = 0
        let revealTarget: number | null = null
        for (let n = b.firstLine; n <= b.lastLine; n++) {
            const line = state.doc.line(n)
            if (line.to < viewport.from) continue
            if (line.from > viewport.to) break
            const lineEl = lineElementAt(view, line.from)
            if (!lineEl) continue
            firstLineEl ??= lineEl
            const span = lineEl.querySelector<HTMLElement>('.gk-code-scroll')
            if (!span) continue
            visible ||= span.getBoundingClientRect().width
            extent = Math.max(extent, textReach(span))
            if (reveal && n === headLine) {
                const caret = view.coordsAtPos(head)
                if (caret) {
                    const x = caret.left
                    const s = span.getBoundingClientRect()
                    const inset = parseFloat(getComputedStyle(lineEl, '::after').left) || 0
                    const lo = s.left + inset + REVEAL_MARGIN_PX
                    const hi = s.right - REVEAL_MARGIN_PX
                    const delta = x < lo ? x - lo : x > hi ? x - hi : 0
                    if (delta !== 0) {
                        const painted = -parseFloat(getComputedStyle(span).textIndent) || 0
                        revealTarget = painted + delta
                    }
                }
            }
        }
        if (!firstLineEl) continue
        const lineRect = firstLineEl.getBoundingClientRect()
        const inset = parseFloat(getComputedStyle(firstLineEl, '::after').left) || 0
        const fontPx = parseFloat(getComputedStyle(firstLineEl).fontSize) || 0
        const padEm = parseFloat(PANEL_PAD) + parseFloat(CODE_PANEL_PAD_RIGHT)
        const overflow = Math.max(0, Math.ceil(extent - visible))
        // A reveal that lands within the panel's padding of the start goes to the start: the margin
        // it keeps the caret from the edge is smaller than the padding the text sits inside, so a
        // Home would otherwise leave the block a few px short of fully scrolled back.
        if (revealTarget !== null && revealTarget < REVEAL_MARGIN_PX + parseFloat(PANEL_PAD) * fontPx) revealTarget = 0
        measured.push({
            opener: b.opener,
            visible,
            overflow,
            trackPx: Math.max(0, lineRect.width - inset - padEm * fontPx),
            barMarginLeft: lineRect.left - contentRect.left - contentPadLeft + inset,
            bars: [...view.contentDOM.querySelectorAll<HTMLElement>(`.gk-code-scrollbar[data-gk-code-block="${b.opener}"]`)],
            revealTarget: revealTarget === null ? null : clampScroll(revealTarget, overflow),
        })
    }
    return { blocks: measured, live }
}

function layThumb(bar: HTMLElement, m: BlockMetrics): void {
    const thumb = bar.querySelector<HTMLElement>('.gk-code-scrollbar-thumb')
    if (!thumb) return
    const g = thumbGeometry(m.visible, m.overflow, m.scroll, m.trackPx, MIN_THUMB_PX)
    thumb.style.width = `${g.widthPct}%`
    thumb.style.left = `${g.leftPct}%`
}

/** The container marks: a plugin of their own so they take the default precedence (module comment). */
const containersPlugin = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet
        constructor(view: EditorView) {
            this.decorations = buildContainers(view)
        }
        update(update: ViewUpdate) {
            const ticked = update.transactions.some((tr) => tr.effects.some((e) => e.is(themeTick) || e.is(renderCompleted)))
            if (update.docChanged || update.viewportChanged || update.selectionSet || ticked) {
                this.decorations = buildContainers(update.view)
            }
        }
    },
    { decorations: (v) => v.decorations },
)

class CodeScrollController {
    private readonly blocks = new Map<number, BlockMetrics>()
    private revealPending = false
    private destroyed = false

    constructor(private readonly view: EditorView) {
        this.requestMeasure()
    }

    update(update: ViewUpdate): void {
        if (update.docChanged) {
            const moved = new Map<number, BlockMetrics>()
            for (const [opener, metrics] of this.blocks) {
                const mapped = mapOpener(update.state, update.changes, opener)
                if (!moved.has(mapped)) moved.set(mapped, metrics)
            }
            this.blocks.clear()
            for (const [opener, metrics] of moved) this.blocks.set(opener, metrics)
        }
        const ticked = update.transactions.some((tr) => tr.effects.some((e) => e.is(themeTick) || e.is(renderCompleted)))
        // Typing and the cursor commands ask for the caret to be shown; a click never needs it.
        if (update.transactions.some((tr) => tr.scrollIntoView)) this.revealPending = true
        const overflowChanged = update.startState.field(overflowingField) !== update.state.field(overflowingField)
        // The clamp's measured per-depth shift moves the code lines sideways without changing any
        // height, so it flips no geometry flag; the bar sits on those lines and must follow it.
        const shifted = update.startState.field(codeShiftsField) !== update.state.field(codeShiftsField)
        if (update.docChanged || update.viewportChanged || update.geometryChanged || ticked || overflowChanged || shifted || this.revealPending) {
            this.requestMeasure()
        }
    }

    destroy(): void {
        this.destroyed = true
        for (const name of this.shiftProperties()) this.view.scrollDOM.style.removeProperty(name)
    }

    scrollOf(opener: number): number {
        return this.blocks.get(opener)?.scroll ?? 0
    }

    overflowOf(opener: number): number {
        return this.blocks.get(opener)?.overflow ?? 0
    }

    /** The bar's `margin-left` (px) from the block's last measure, for a bar created before the next one. */
    barMarginOf(opener: number): number | undefined {
        return this.blocks.get(opener)?.barMarginLeft
    }

    /** Scroll a block (the bar and the wheel come here); the lines follow through the property. */
    scrollTo(opener: number, x: number): void {
        const metrics = this.blocks.get(opener)
        if (!metrics) return
        const scroll = clampScroll(x, metrics.overflow)
        if (scroll === metrics.scroll) return
        metrics.scroll = scroll
        this.applyShift(opener, metrics)
    }

    private applyShift(opener: number, metrics: BlockMetrics): void {
        const name = shiftProperty(opener)
        const value = `${metrics.scroll}px`
        const style = this.view.scrollDOM.style
        if (style.getPropertyValue(name) !== value) style.setProperty(name, value)
        for (const bar of this.view.contentDOM.querySelectorAll<HTMLElement>(`.gk-code-scrollbar[data-gk-code-block="${opener}"]`)) {
            layThumb(bar, metrics)
        }
    }

    private shiftProperties(): string[] {
        const style = this.view.scrollDOM.style
        const names: string[] = []
        for (let i = 0; i < style.length; i++) {
            const name = style.item(i)
            if (name.startsWith(SHIFT_PROPERTY_PREFIX)) names.push(name)
        }
        return names
    }

    private requestMeasure(): void {
        this.view.requestMeasure({
            key: this,
            read: (view) => {
                const measurement = measureBlocks(view, this.revealPending)
                this.revealPending = false
                // A reveal is written HERE, in the read phase (module comment): the caret layer's
                // read follows this one and must see the text where it will be painted. The style
                // write costs one extra layout only when a caret actually crossed the edge.
                for (const m of measurement.blocks) {
                    if (m.revealTarget !== null) view.scrollDOM.style.setProperty(shiftProperty(m.opener), `${m.revealTarget}px`)
                }
                return measurement
            },
            write: (measurement, view) => this.applyMeasurement(measurement, view),
        })
    }

    private applyMeasurement({ blocks, live }: Measurement, view: EditorView): void {
        const verdicts = new Map<number, boolean>()
        for (const m of blocks) {
            const previous = this.blocks.get(m.opener)
            const metrics: BlockMetrics = {
                scroll: m.revealTarget ?? clampScroll(previous?.scroll ?? 0, m.overflow),
                barMarginLeft: m.barMarginLeft,
                visible: m.visible,
                overflow: m.overflow,
                trackPx: m.trackPx,
            }
            this.blocks.set(m.opener, metrics)
            for (const bar of m.bars) bar.style.marginLeft = `${m.barMarginLeft}px`
            this.applyShift(m.opener, metrics)
            verdicts.set(m.opener, m.overflow > 0)
        }
        // A block that no longer exists (or moved: its property is keyed by offset) leaves nothing behind.
        for (const opener of [...this.blocks.keys()]) if (!live.has(opener)) this.blocks.delete(opener)
        for (const name of this.shiftProperties()) {
            if (!this.blocks.has(Number(name.slice(SHIFT_PROPERTY_PREFIX.length)))) view.scrollDOM.style.removeProperty(name)
        }
        const next = mergeOverflowing(view.state.field(overflowingField), verdicts, live)
        if (!next) return
        // Out of the measure phase, but before this frame paints: a bar appears with the line that
        // overflowed, never a frame later.
        queueMicrotask(() => {
            if (this.destroyed) return
            view.dispatch({ effects: setOverflowing.of(next) })
        })
    }
}

const codeScrollPlugin = ViewPlugin.fromClass(CodeScrollController, {
    eventHandlers: {
        // A sideways wheel (a trackpad swipe, Shift+wheel) over the block scrolls the block; a
        // vertical one stays the editor's. The clipped spans are not scroll containers, so the
        // browser would otherwise do nothing with it.
        wheel(event, view) {
            const target = event.target instanceof Element ? event.target : null
            const host = target?.closest<HTMLElement>('.cm-line.gk-code-block, .gk-code-scrollbar')
            if (!host) return false
            const delta = wheelHorizontalDelta(event, view.defaultLineHeight)
            if (delta === null) return false
            const opener = host.classList.contains('gk-code-scrollbar')
                ? Number(host.dataset.gkCodeBlock)
                : blockOpenerAt(view, view.posAtDOM(host))
            if (opener === null) return false
            const controller = view.plugin(codeScrollPlugin)
            if (!controller || controller.overflowOf(opener) === 0) return false
            controller.scrollTo(opener, controller.scrollOf(opener) + delta)
            event.preventDefault()
            return true
        },
    },
})

/** The opener offset of the block whose lines (fences included) contain `pos`, or null. */
function blockOpenerAt(view: EditorView, pos: number): number | null {
    const line = view.state.doc.lineAt(pos).number
    for (const b of scrollableBlocks(view.state)) {
        if (line >= b.firstLine - 1 && line <= b.lastLine + 1) return b.opener
    }
    return null
}

const theme = EditorView.baseTheme({
    // The scroll container: from the line's padding edge, reached back across the line's padding
    // (`--gk-code-hang`, published by the clamp, so the leading fence-column spaces render at
    // column 0 inside it; an unindented line has none, so the container pads itself by
    // `--gk-code-inner` instead), to the panel's right edge. It is one row (`pre`), clipped; the
    // offset comes in through `text-indent` from the block's property, and the clip starts at the
    // panel's edge so nothing scrolled shows over the guides.
    // `contain: inline-size` is load-bearing: `.cm-content` is a flex item whose minimum size is
    // its min-content width, and an inline-block's percentage width is cyclic there, so without it
    // the unbreakable text widened the whole content to the longest line and `100%` followed.
    '.gk-code-scroll': {
        display: 'inline-block',
        verticalAlign: 'top',
        boxSizing: 'border-box',
        marginLeft: 'calc(-1 * var(--gk-code-hang, 0px))',
        paddingLeft: 'var(--gk-code-inner, 0px)',
        width: `calc(100% + var(--gk-code-hang, 0px) + ${CODE_PANEL_PAD_RIGHT})`,
        contain: 'inline-size',
        overflow: 'clip',
        whiteSpace: 'pre',
        textIndent: 'calc(-1 * var(--gk-code-shift, 0px))',
        clipPath: 'inset(0 0 0 var(--code-inset, 0px))',
    },
    // The bar: a strip of the panel between two lines. Its horizontal extent is set per block in
    // the measure (margin-left; the block fills to the content edge, where the panel ends). All
    // vertical footprint is padding, never margin (ADR 0022: CodeMirror measures the border box).
    '.gk-code-scrollbar': {
        boxSizing: 'content-box',
        height: '0.5em',
        padding: `0.15em ${CODE_PANEL_PAD_RIGHT} 0.15em ${PANEL_PAD}`,
        fontSize: `${CODE_FONT_SCALE}em`,
        background: 'var(--gk-code-bg, rgba(127,127,127,0.10))',
        touchAction: 'none',
        userSelect: 'none',
        cursor: 'default',
    },
    '.gk-code-scrollbar-track': {
        position: 'relative',
        height: '100%',
        borderRadius: '999px',
    },
    '.gk-code-scrollbar-thumb': {
        position: 'absolute',
        top: '0',
        bottom: '0',
        left: '0',
        width: '100%',
        borderRadius: '999px',
        background: 'var(--gk-code-scrollbar, rgba(127,127,127,0.45))',
        cursor: 'grab',
        transition: 'background 120ms ease-out',
    },
    '.gk-code-scrollbar:hover .gk-code-scrollbar-thumb, .gk-code-scrollbar--dragging .gk-code-scrollbar-thumb': {
        background: 'var(--gk-code-scrollbar-active, rgba(127,127,127,0.7))',
    },
    '.gk-code-scrollbar--dragging .gk-code-scrollbar-thumb': { cursor: 'grabbing' },
})

/** The code-scroll augmentation (ADR 0094). Registered after the content clamp (editor-extensions.ts). */
export function codeScrollAugmentation(): Extension {
    // The controller at the highest precedence so its measure read precedes the caret layer's
    // (module comment); the marks at the default precedence, after the highlight tokens.
    return [overflowingField, barsField, Prec.highest(codeScrollPlugin), containersPlugin, theme]
}
