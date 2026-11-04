/**
 * Annotations in the shape pdf.js's save path takes them. `saveDocument()` writes whatever its
 * annotation storage holds, and these are the same entries its own editors put there, so a saved
 * copy carries ordinary PDF annotations that any reader shows. This shape belongs to pdf.js and can
 * change with it. `pdf-save.test.ts` holds it to a real save, so an upgrade that changes it fails there.
 */
import { averageStrokeWidth, boundsOf, smoothPoints, type PageFrame } from './pdf-geometry'
import type { PdfAnnotation, PdfHighlight, PdfNote, PdfStroke } from './pdf-state'

/** pdf.js's `AnnotationEditorType` values, which its worker reads. */
const FREETEXT = 3
const HIGHLIGHT = 9
const INK = 15

/** pdf.js's prefix for an entry that is a new annotation rather than a form value. */
export const SAVE_ENTRY_PREFIX = 'pdfjs_internal_editor_'

export function colourBytes(colour: string): [number, number, number] {
    return [1, 3, 5].map((at) => Number.parseInt(colour.slice(at, at + 2), 16)) as [number, number, number]
}

function highlightEntry(annotation: PdfHighlight, opacity: number): Record<string, unknown> {
    const { quads } = annotation
    const outlines: number[][] = []
    for (let i = 0; i + 7 < quads.length; i += 8) {
        // The appearance fills a closed outline, so the last two corners swap from quad order.
        outlines.push([quads[i], quads[i + 1], quads[i + 2], quads[i + 3], quads[i + 6], quads[i + 7], quads[i + 4], quads[i + 5]])
    }
    return {
        annotationType: HIGHLIGHT,
        color: colourBytes(annotation.colour),
        opacity,
        thickness: 0,
        quadPoints: quads,
        outlines,
        rect: boundsOf(quads),
        rotation: 0,
        pageIndex: annotation.page - 1,
    }
}

/** A polyline as the worker's curve format: four NaNs, a start point, then six numbers a segment. */
function inkLine(points: readonly number[]): Float32Array {
    const line: number[] = [Number.NaN, Number.NaN, Number.NaN, Number.NaN, points[0], points[1]]
    for (let i = 2; i + 1 < points.length; i += 2) {
        line.push(Number.NaN, Number.NaN, Number.NaN, Number.NaN, points[i], points[i + 1])
    }
    return Float32Array.from(line)
}

function strokeEntry(annotation: PdfStroke, opacity: number): Record<string, unknown> {
    const points = smoothPoints(annotation.points)
    // An ink annotation has one thickness. Only a flattened copy can keep a line's changing width.
    const thickness = averageStrokeWidth(annotation)
    return {
        annotationType: INK,
        color: colourBytes(annotation.colour),
        opacity: annotation.tool === 'highlighter' ? opacity : 1,
        thickness,
        paths: { lines: [inkLine(points)], points: [points] },
        rect: boundsOf(points, thickness / 2 + 1),
        rotation: 0,
        pageIndex: annotation.page - 1,
    }
}

/** A note's box, from its top left: wide and tall enough for its lines in the PDF's own font. */
export function noteBox(note: PdfNote): [number, number, number, number] {
    const lines = note.text.split('\n')
    const longest = Math.max(1, ...lines.map((line) => line.length))
    const width = longest * note.fontSize * 0.6 + 4
    const height = lines.length * note.fontSize * 1.25 + 4
    return [note.x, note.y - height, note.x + width, note.y]
}

function noteEntry(annotation: PdfNote): Record<string, unknown> {
    return {
        annotationType: FREETEXT,
        color: colourBytes(annotation.colour),
        fontSize: annotation.fontSize,
        value: annotation.text,
        rect: noteBox(annotation),
        rotation: 0,
        pageIndex: annotation.page - 1,
    }
}

/** One annotation's entry for pdf.js's annotation storage. */
export function saveEntry(annotation: PdfAnnotation, highlightOpacity: number): Record<string, unknown> {
    if (annotation.kind === 'highlight') return highlightEntry(annotation, highlightOpacity)
    if (annotation.kind === 'stroke') return strokeEntry(annotation, highlightOpacity)
    return noteEntry(annotation)
}

export type { PageFrame }
