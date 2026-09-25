/**
 * Augmentation: Logseq-style **outline guide lines** — a quiet vertical thread drawn from each parent
 * bullet down to its last descendant, showing parent/child structure. A self-managed overlay layer
 * (a `<div>` inside the scroller, behind the text) rather than per-line decorations, so the threads
 * span rows cleanly and never collide with the content-clamp mask or the code-block panel. Purely
 * visual; the document is untouched.
 *
 * Geometry is read on the next animation frame after every doc/viewport/size change: a thread's x
 * comes from {@link EditorView.coordsAtPos} on the bullet's `-` (centred under the rendered dot); its
 * y-span uses document-relative block tops, so it scrolls with the content. The branch structure is a
 * single O(n) stack pass mirroring {@link branchRange} (a blank line or a shallower line ends a
 * branch), so a parent with no children draws nothing. Which threads exist, and which end on a quote,
 * is {@link guideThreads}: a thread whose tree ends in a quote runs on to the bottom of the quote's
 * panel, measured off the panel itself, and a top-level quote bullet that is last in its group gets
 * a thread of its own down the panel.
 *
 * A branch can be taller than the rendered viewport, so either end of a thread may lie outside the
 * DOM CodeMirror has built: `coordsAtPos` is null there. Those ends are placed from
 * {@link EditorView.lineBlockAt} (valid for any position; off-screen, an estimate is as good as a
 * measurement) and an off-screen parent's x by the clamp's layout ({@link bulletDotOffset}) from the
 * text area's left edge, found off a rendered dot or, deep inside a code block taller than the
 * rendered range where no bullet is rendered at all, off `.cm-content`'s own box. (Without that
 * second source, the threads beside such a block vanished once its top scrolled away.)
 *
 * Only a null on a RENDERED position means layout is not ready. That used to be one
 * signal: any unmeasurable end was "not ready", and with no other thread in view the redraw retried
 * every frame forever without touching the overlay — a subtree deleted at the foot of a long branch
 * left its threads drawn at the stale position, while the long branch never got one at all.
 */

import { syntaxTree } from '@codemirror/language'
import { type EditorState, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

import { lineIndent } from '../../outliner'
import { analysisFor } from '../analysis/editor-analysis'
import { quoteEndsAt } from './blockquote-core'
import { bulletDotOffset, proseMetricsField } from './content-clamp'
import { quotePanelBottom } from './markdown-format'
import { GUIDE_WIDTH_PX, type GuideThread, guideThreads } from './outline-guides-core'

interface Thread {
    x: number
    top: number
    height: number
}

interface Measured {
    threads: Thread[]
    /** A rendered position could not be measured: layout is not ready, so the caller may retry. */
    incomplete: boolean
}

/** Vertical gap (px) left between a thread's top and the parent dot, so they don't crowd each other. */
const DOT_GAP = 8

/**
 * Frames to wait for a rendered position to become measurable before drawing what we have. Keeps the
 * overlay from blinking out across a doc swap that re-mounts the editor, without ever letting a
 * position that will not measure (a hidden editor) starve the redraw.
 */
const MAX_RETRIES = 20

/** The dot's centre and its row, measured from the `-` on a rendered bullet line; null when not laid out. */
function measureMarker(view: EditorView, line: { from: number; text: string }): { x: number; top: number; bottom: number } | null {
    const markerPos = line.from + lineIndent(line.text)
    const a = view.coordsAtPos(markerPos)
    // Left-biased (`-1`) so we read the `-` glyph's TRAILING edge, not the start of the next char —
    // the dot carries a `margin-right` (the content gutter), and a default-biased read would land
    // past it and pull the thread off the dot's centre.
    const b = view.coordsAtPos(markerPos + 1, -1)
    return a && b ? { x: (a.left + b.left) / 2, top: a.top, bottom: a.bottom } : null
}

/**
 * The guide threads for `state`, as the overlay draws them: the analysis's branches, and the syntax
 * tree for where a quote ends. `within` is the 0-based line range to keep threads for. The rule
 * tables call this too, so the rows and the overlay cannot be wired differently.
 */
export function guideThreadsFor(state: EditorState, within?: { from: number; to: number }): GuideThread[] {
    const analysis = analysisFor(state)
    const tree = syntaxTree(state)
    return guideThreads(analysis.lines, analysis.branchEnds, analysis.outline, (line) => quoteEndsAt(tree, state.doc, line), within)
}

/** The bottom (viewport px) of the quote panel on the rendered line starting at `lineFrom`, or null. */
function panelBottom(view: EditorView, lineFrom: number): number | null {
    const { node } = view.domAtPos(lineFrom)
    const line = (node instanceof HTMLElement ? node : node.parentElement)?.closest('.cm-line')
    return line ? quotePanelBottom(line) : null
}

function computeThreads(view: EditorView): Measured {
    const { state } = view
    const analysis = analysisFor(state)
    const lines = analysis.lines
    const ends = analysis.branchEnds
    const ranges = view.visibleRanges
    const rendered = (pos: number): boolean => ranges.some((range) => pos >= range.from && pos <= range.to)
    const visibleFrom = Math.max(0, Math.min(...ranges.map((range) => state.doc.lineAt(range.from).number - 1)))
    const visibleTo = Math.min(lines.length - 1, Math.max(...ranges.map((range) => state.doc.lineAt(range.to).number - 1)))
    // The overlay box lives in the scroller and scrolls with it; (sx, sy) is the viewport position of
    // the scroll-content origin, so `coordsAtPos` (viewport) maps to box coords by subtracting it.
    const sr = view.scrollDOM.getBoundingClientRect()
    const sx = sr.left - view.scrollDOM.scrollLeft
    const sy = sr.top - view.scrollDOM.scrollTop
    // `lineBlockAt` tops are relative to the document's first line; this is where that sits in the box.
    const docTop = view.documentTop - sy
    const metrics = state.field(proseMetricsField, false) ?? null
    const threads: Thread[] = []
    let incomplete = false
    // The text area's left edge (viewport px), which the clamp lays every bullet out from
    // ({@link bulletDotOffset}): where an off-screen parent's dot is placed from. Found lazily, and
    // `null` when it cannot be found this frame.
    let textLeft: number | null | undefined
    const findTextLeft = (): number | null => {
        if (textLeft !== undefined) return textLeft
        textLeft = null
        if (!metrics) return textLeft
        let bulletRendered = false
        for (let j = visibleFrom; j <= visibleTo; j++) {
            // The analysis's own bullets only (`-1` is prose, frontmatter or fence content): a `- item`
            // inside a code fence is laid out by the panel's rules, not the outline's.
            if (ends[j] < 0) continue
            const line = state.doc.line(j + 1)
            if (!rendered(line.from)) continue
            bulletRendered = true
            // Off a rendered dot where there is one: measured, so exact whatever the fonts did.
            const m = measureMarker(view, line)
            if (m) return (textLeft = m.x - bulletDotOffset(analysis.outline[j].depth, lineIndent(lines[j]), metrics))
        }
        if (bulletRendered) {
            incomplete = true // a rendered bullet that will not measure: layout is not ready
            return textLeft
        }
        // No bullet in the DOM at all: deep inside a code block taller than the rendered range, every
        // line there is code. The text area's own box stands in.
        const content = view.contentDOM
        textLeft = content.getBoundingClientRect().left + content.clientLeft + parseFloat(getComputedStyle(content).paddingLeft)
        return textLeft
    }
    for (const thread of guideThreadsFor(state, { from: visibleFrom, to: visibleTo })) {
        const i = thread.parent
        const parent = state.doc.line(i + 1)
        let centreX: number
        let top: number
        if (rendered(parent.from)) {
            const m = measureMarker(view, parent)
            if (!m) {
                incomplete = true // rendered but not laid out yet
                continue
            }
            centreX = m.x
            // From just below the parent dot's row centre (the GAP keeps it off the dot).
            top = (m.top + m.bottom) / 2 - sy + DOT_GAP
        } else {
            // The parent is above the rendered range: its dot sits where the clamp lays it out. The
            // top is off-screen, so the block top is as good as the row centre.
            const left = findTextLeft()
            if (left === null || !metrics) continue
            centreX = left + bulletDotOffset(analysis.outline[i].depth, lineIndent(lines[i]), metrics)
            top = view.lineBlockAt(parent.from).top + docTop
        }
        // Snap the line's left edge to the DEVICE-pixel grid (not the CSS grid): at a fractional device
        // ratio (e.g. 125%/150% display scaling) an integer CSS-x lands on a half device-pixel for some
        // lines and a whole one for others, so they antialias to different apparent thicknesses. Rounding
        // the left edge (`centre − half the width`) in device space makes every line land on the same
        // phase → uniform, and as close to the dot's (fractional) centre as the grid allows.
        const dpr = window.devicePixelRatio || 1
        const x = Math.round((centreX - GUIDE_WIDTH_PX / 2) * dpr) / dpr - sx
        // Down to the bottom of the last descendant's text row (Logseq-style — the thread spans the
        // whole subtree), or, where that line ends a quote, on to the bottom of the quote's panel.
        // Below the rendered range, or inside a block widget, the block's bottom stands in.
        const lastLine = state.doc.line(thread.last + 1)
        const lastPos = lastLine.to
        const panel = rendered(lastPos) && thread.toPanel() ? panelBottom(view, lastLine.from) : null
        const last = panel === null && rendered(lastPos) ? view.coordsAtPos(lastPos) : null
        if (panel === null && !last && rendered(lastPos)) incomplete = true
        const bottom = panel !== null ? panel - sy : last ? last.bottom - sy : view.lineBlockAt(lastPos).bottom + docTop
        if (bottom > top) threads.push({ x, top, height: bottom - top })
    }
    return { threads, incomplete }
}

const guidePlugin = ViewPlugin.fromClass(
    class {
        readonly box: HTMLElement
        private raf = 0
        private retries = 0
        private warmup: ReturnType<typeof setTimeout>

        constructor(readonly view: EditorView) {
            this.box = document.createElement('div')
            this.box.className = 'cm-outline-guides'
            this.box.setAttribute('aria-hidden', 'true')
            view.scrollDOM.appendChild(this.box)
            this.schedule()
            // Cold-start insurance: on a slow first mount the doc/layout can settle after the first
            // frame; a delayed re-schedule catches that without waiting for the next user interaction.
            this.warmup = setTimeout(() => this.schedule(), 250)
        }

        update(update: ViewUpdate) {
            // The prose metrics too: an off-screen parent's dot is placed with them, so the threads
            // redraw on them directly rather than on whatever re-measure happens to follow.
            const metricsChanged = update.startState.field(proseMetricsField, false) !== update.state.field(proseMetricsField, false)
            if (update.docChanged || update.viewportChanged || update.geometryChanged || metricsChanged) {
                this.schedule()
            }
        }

        // Redraw on the next animation frame — after the browser has laid out, so `coordsAtPos` is
        // valid. (CM's own `requestMeasure` is unreliable here: a doc swap that re-mounts the editor can
        // cancel the queued measure before it runs.) While a rendered position will not measure and
        // nothing else could be drawn, the overlay is left as it is and we retry the next frame, so it
        // never flickers out across a re-mount — but only for a bounded run of frames: after that the
        // overlay is redrawn from whatever did measure, which may be nothing.
        schedule() {
            this.retries = 0
            this.measure()
        }

        private measure() {
            if (this.raf) cancelAnimationFrame(this.raf)
            this.raf = requestAnimationFrame(() => {
                this.raf = 0
                const { threads, incomplete } = computeThreads(this.view)
                if (incomplete && this.retries < MAX_RETRIES) {
                    this.retries += 1
                    this.measure()
                    if (threads.length === 0) return
                }
                this.render(threads)
            })
        }

        render(threads: Thread[]) {
            this.box.textContent = ''
            for (const t of threads) {
                const line = this.box.appendChild(document.createElement('div'))
                line.className = 'cm-outline-guide'
                line.style.cssText = `position:absolute;left:${t.x}px;top:${t.top}px;width:${GUIDE_WIDTH_PX}px;height:${t.height}px`
            }
        }

        destroy() {
            if (this.raf) cancelAnimationFrame(this.raf)
            clearTimeout(this.warmup)
            this.box.remove()
        }
    },
)

const theme = EditorView.baseTheme({
    // The overlay sits behind the text; the threads are GUIDE_WIDTH_PX wide, in the strong border colour.
    '.cm-outline-guides': { position: 'absolute', top: '0', left: '0', zIndex: '0', pointerEvents: 'none' },
    '.cm-outline-guide': { background: 'var(--gk-border-strong, rgba(3,7,18,0.16))' },
})

/** The outline guide-line augmentation (Dual Mode Editor.md). Mounted in DocumentView. */
export function outlineGuidesAugmentation(): Extension {
    return [guidePlugin, theme]
}
