/**
 * Crop margins: how much white to leave out either side of a PDF's pages, so a small screen can
 * show the content at a larger size. Pure, so the arithmetic tests without a canvas; the viewer
 * hands in low-resolution renders of its pages.
 *
 * One crop serves a whole document, because cropping page by page would change the zoom as the
 * person scrolled. Odd and even pages have their own, because a printed book alternates its margins.
 * A page whose content the crop would cut off is shown whole instead ({@link pageFitsCrop}).
 */

/** A rendered page as a canvas gives it back: RGBA, row by row. */
export interface PageImage {
    width: number
    height: number
    data: Uint8ClampedArray
}

/** White either side of the content, as fractions of the page's width. */
export interface Margins {
    left: number
    right: number
}

export interface PageSample {
    /** 1-based, which decides whether it is an odd or an even page. */
    page: number
    margins: Margins
}

export interface DocumentCrop {
    odd: Margins
    even: Margins
}

/** A channel at or above this reads as paper, so a scan's off-white background is not content. */
const PAPER = 225
/** A column needs this share of its pixels inked to count, so a speck on a scan does not. */
const MIN_INK_SHARE = 0.01
/** White left around the content, so its edge never touches the edge of the screen. */
const PADDING = 0.015
/** The most that goes from both sides together, so a stray measurement cannot leave a sliver. */
const MAX_CROP = 0.6

/** The margins of one page, or `null` for a page with nothing on it. */
export function contentMargins(image: PageImage): Margins | null {
    const { width, height, data } = image
    const threshold = Math.max(1, Math.ceil(height * MIN_INK_SHARE))
    const columnHasInk = (x: number): boolean => {
        let ink = 0
        for (let y = 0; y < height; y++) {
            const at = (y * width + x) * 4
            const transparent = data[at + 3] < 16
            if (!transparent && (data[at] < PAPER || data[at + 1] < PAPER || data[at + 2] < PAPER) && ++ink >= threshold) {
                return true
            }
        }
        return false
    }
    let first = 0
    while (first < width && !columnHasInk(first)) first++
    if (first === width) return null
    let last = width - 1
    while (last > first && !columnHasInk(last)) last--
    return { left: first / width, right: (width - 1 - last) / width }
}

function narrowest(samples: readonly Margins[]): Margins | null {
    if (samples.length === 0) return null
    const round = (value: number) => Math.round(value * 1000) / 1000
    const left = Math.max(0, Math.min(...samples.map((s) => s.left)) - PADDING)
    const right = Math.max(0, Math.min(...samples.map((s) => s.right)) - PADDING)
    const total = left + right
    const scale = total > MAX_CROP ? MAX_CROP / total : 1
    return { left: round(left * scale), right: round(right * scale) }
}

/** The crop for a document, from the margins of a sample of its pages. */
export function cropFromSamples(samples: readonly PageSample[]): DocumentCrop {
    const odd = narrowest(samples.filter((s) => s.page % 2 === 1).map((s) => s.margins))
    const even = narrowest(samples.filter((s) => s.page % 2 === 0).map((s) => s.margins))
    const none: Margins = { left: 0, right: 0 }
    return { odd: odd ?? even ?? none, even: even ?? odd ?? none }
}

/** Whether a page's content all sits inside the crop. A blank page always does. */
export function pageFitsCrop(margins: Margins | null, crop: Margins): boolean {
    return margins === null || (margins.left >= crop.left && margins.right >= crop.right)
}

/** Which pages to sample: up to `count`, spread through the document, past any cover. */
export function samplePages(pageCount: number, count = 12): number[] {
    if (pageCount <= 2) return Array.from({ length: pageCount }, (_, i) => i + 1)
    const first = 3
    const span = pageCount - first + 1
    const pages = new Set<number>()
    for (let i = 0; i < Math.min(count, span); i++) {
        pages.add(first + Math.floor((i * span) / Math.min(count, span)))
    }
    return [...pages]
}
