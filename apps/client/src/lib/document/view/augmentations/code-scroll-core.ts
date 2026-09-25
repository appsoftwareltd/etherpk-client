/**
 * Pure geometry for the code-scroll augmentation (ADR 0094): which lines of a fenced block scroll,
 * how the set of overflowing blocks is kept, and the arithmetic of the custom scrollbar. No
 * CodeMirror imports; the DOM glue lives in `code-scroll.ts`.
 *
 * Code never soft-wraps (Editor Content Rules → Fenced Code Blocks → Presentation). A block's body
 * lines scroll sideways together, and a bar below the last body line is the visible affordance
 * while the widest line overflows the panel.
 */

/** 0-based, inclusive line indices of a block's body: everything strictly between its fences. */
export interface BodyRange {
    first: number
    last: number
}

/** The body lines of a fenced block, or null when the opener sits directly above its closer. */
export function fenceBodyRange(block: { start: number; end: number }): BodyRange | null {
    return block.end - block.start >= 2 ? { first: block.start + 1, last: block.end - 1 } : null
}

/**
 * Fold one measurement into the set of blocks (by opener position) whose widest laid-out line
 * overflows the panel. The measure sees only the blocks CodeMirror has rendered, so a block
 * outside the viewport keeps its last verdict rather than losing its bar each time it scrolls
 * out of sight; a block that no longer exists is dropped. Returns the next set, or null when the
 * measurement changes nothing: the caller dispatches a transaction only for a real change.
 */
export function mergeOverflowing(
    previous: ReadonlySet<number>,
    measured: ReadonlyMap<number, boolean>,
    live: ReadonlySet<number>,
): ReadonlySet<number> | null {
    const next = new Set<number>()
    for (const opener of previous) if (live.has(opener) && !measured.has(opener)) next.add(opener)
    for (const [opener, overflows] of measured) if (overflows && live.has(opener)) next.add(opener)
    if (next.size === previous.size && [...next].every((opener) => previous.has(opener))) return null
    return next
}

/** The set carried through a document change: every opener mapped to where the change moved it. */
export function mapOverflowing(set: ReadonlySet<number>, mapPos: (pos: number) => number): ReadonlySet<number> {
    const next = new Set<number>()
    for (const opener of set) next.add(mapPos(opener))
    return next
}

/** A scroll position held inside `[0, overflow]`, in whole pixels (the DOM rounds `scrollLeft` anyway). */
export function clampScroll(x: number, overflow: number): number {
    if (!Number.isFinite(x) || overflow <= 0) return 0
    return Math.round(Math.min(Math.max(x, 0), overflow))
}

/** Where the thumb sits on its track, as percentages of the track (so no track width is needed to lay it out). */
export interface ThumbGeometry {
    widthPct: number
    leftPct: number
}

/**
 * The thumb for a block whose lines show `visible` px of `visible + overflow` px of content, scrolled
 * to `scroll`. Its width is the visible fraction, floored at `minThumbPx` of the `trackPx`-wide track
 * so a huge line still leaves something to grab; its left is the scrolled fraction of the remaining
 * travel, so full scroll lands it against the far end.
 */
export function thumbGeometry(
    visible: number,
    overflow: number,
    scroll: number,
    trackPx: number,
    minThumbPx: number,
): ThumbGeometry {
    if (overflow <= 0 || visible <= 0) return { widthPct: 100, leftPct: 0 }
    const minPct = trackPx > 0 ? (minThumbPx / trackPx) * 100 : 0
    const widthPct = Math.min(100, Math.max((visible / (visible + overflow)) * 100, minPct))
    const leftPct = (clampScroll(scroll, overflow) / overflow) * (100 - widthPct)
    return { widthPct: round2(widthPct), leftPct: round2(leftPct) }
}

/** The scroll a thumb drag reaches: the thumb's travel maps linearly onto the overflow. */
export function scrollForThumbDelta(
    startScroll: number,
    deltaPx: number,
    trackPx: number,
    thumbPx: number,
    overflow: number,
): number {
    const travel = trackPx - thumbPx
    if (travel <= 0) return clampScroll(startScroll, overflow)
    return clampScroll(startScroll + (deltaPx * overflow) / travel, overflow)
}

/** The scroll that centres the thumb under a click `xPx` into the track. */
export function scrollForTrackClick(xPx: number, trackPx: number, thumbPx: number, overflow: number): number {
    const travel = trackPx - thumbPx
    if (travel <= 0) return 0
    return clampScroll(((xPx - thumbPx / 2) / travel) * overflow, overflow)
}

/**
 * How far a wheel event scrolls a block sideways, in px, or null when the wheel is vertical (or
 * undecided), which stays the editor's to scroll. A line-mode delta (a mouse wheel on Firefox) is
 * scaled by the line height; page mode is treated the same, being rare and never horizontal.
 */
export function wheelHorizontalDelta(
    e: { deltaX: number; deltaY: number; deltaMode: number },
    linePx: number,
): number | null {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return null
    return e.deltaMode === 0 ? e.deltaX : e.deltaX * linePx
}

function round2(n: number): number {
    return Math.round(n * 100) / 100
}
