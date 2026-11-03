/**
 * A drawing as an SVG picture: white paper (with its dots or lines), the highlighters translucent
 * beneath the pens, and a viewBox fitted to the ink with a margin round it. Built as a small tree
 * of elements, which `svgMarkup` writes out as a file (a published site, a quote in the Backlinks
 * panel) and the widget builds with the DOM (`picture.ts`), so the extension never writes HTML.
 *
 * Pure and deterministic: the same body always gives the same picture.
 */
import { HIGHLIGHTER_OPACITY, type InkDrawing, type InkPaper } from './format'
import { type Bounds, boundsHeight, boundsWidth, drawingBounds, padded } from './geometry'
import { DOT_COLOUR, DOT_RADIUS, DOT_SPACING, LINE_COLOUR, LINE_SPACING, PAPER_COLOUR, strokePath } from './outline'

export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

/** The paper shown round the ink, in drawing pixels. */
export const PICTURE_MARGIN = 16

export interface SvgNode {
    tag: string
    attrs: Record<string, string>
    children?: SvgNode[]
}

export interface InkPicture {
    root: SvgNode
    /** The picture's own size, in drawing pixels. */
    width: number
    height: number
    /** The drawing area it shows. */
    view: Bounds
}

const n = (value: number) => {
    const rounded = Math.round(value * 100) / 100
    return String(rounded === 0 ? 0 : rounded)
}

/** The paper's pattern and the rectangle it fills, or none for plain paper. */
function paperNodes(paper: InkPaper, view: Bounds): SvgNode[] {
    if (paper === 'plain') return []
    const spacing = paper === 'dots' ? DOT_SPACING : LINE_SPACING
    const mark: SvgNode =
        paper === 'dots'
            ? { tag: 'circle', attrs: { cx: '0', cy: '0', r: n(DOT_RADIUS), fill: DOT_COLOUR } }
            : { tag: 'rect', attrs: { x: '0', y: '0', width: n(spacing), height: '1', fill: LINE_COLOUR } }
    // Four quarter-dots at the tile's corners make a whole dot at every multiple of the spacing.
    const marks: SvgNode[] =
        paper === 'dots'
            ? [0, spacing].flatMap((x) => [0, spacing].map((y) => ({ ...mark, attrs: { ...mark.attrs, cx: n(x), cy: n(y) } })))
            : [mark]
    const pattern: SvgNode = {
        tag: 'pattern',
        attrs: { id: 'ink-paper', x: '0', y: '0', width: n(spacing), height: n(spacing), patternUnits: 'userSpaceOnUse' },
        children: marks,
    }
    return [
        { tag: 'defs', attrs: {}, children: [pattern] },
        { tag: 'rect', attrs: { x: n(view.minX), y: n(view.minY), width: n(boundsWidth(view)), height: n(boundsHeight(view)), fill: 'url(#ink-paper)' } },
    ]
}

/** The drawing area a picture shows: the ink with a margin, or a blank sheet. Cheap: no outlines. */
export function pictureView(drawing: InkDrawing, options: { emptyWidth?: number; emptyHeight?: number } = {}): Bounds {
    const bounds = drawingBounds(drawing.strokes.map((s) => s.stroke))
    return bounds ? padded(bounds, PICTURE_MARGIN) : { minX: 0, minY: 0, maxX: options.emptyWidth ?? 320, maxY: options.emptyHeight ?? 120 }
}

/**
 * The picture of a drawing. With nothing drawn, a blank sheet `emptyWidth` × `emptyHeight`.
 */
export function inkPicture(drawing: InkDrawing, options: { emptyWidth?: number; emptyHeight?: number } = {}): InkPicture {
    const strokes = drawing.strokes.map((s) => s.stroke)
    const view = pictureView(drawing, options)
    const width = boundsWidth(view)
    const height = boundsHeight(view)
    const ink = (tool: 'pen' | 'highlighter') =>
        strokes
            .filter((s) => s.tool === tool)
            .map((s): SvgNode => ({ tag: 'path', attrs: { d: strokePath(s), fill: s.colour, ...(tool === 'highlighter' ? { 'fill-opacity': String(HIGHLIGHTER_OPACITY) } : {}) } }))
    const root: SvgNode = {
        tag: 'svg',
        attrs: { xmlns: SVG_NAMESPACE, viewBox: `${n(view.minX)} ${n(view.minY)} ${n(width)} ${n(height)}`, width: n(width), height: n(height) },
        children: [
            { tag: 'rect', attrs: { x: n(view.minX), y: n(view.minY), width: n(width), height: n(height), fill: PAPER_COLOUR } },
            ...paperNodes(drawing.header.paper, view),
            // Highlighters beneath the pens, so a pen's line stays dark where a highlighter crosses it.
            ...ink('highlighter'),
            ...ink('pen'),
        ],
    }
    return { root, width, height, view }
}

function escaped(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The picture written out as an SVG file's text. */
export function svgMarkup(node: SvgNode): string {
    const attrs = Object.entries(node.attrs)
        .map(([name, value]) => ` ${name}="${escaped(value)}"`)
        .join('')
    const children = node.children ?? []
    if (children.length === 0) return `<${node.tag}${attrs}/>`
    return `<${node.tag}${attrs}>${children.map(svgMarkup).join('')}</${node.tag}>`
}
