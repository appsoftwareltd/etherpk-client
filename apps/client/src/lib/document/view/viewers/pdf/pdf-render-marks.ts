/**
 * Annotations and placed signatures drawn on a canvas, for printing: the printed page is a picture,
 * so what is on it has to be drawn into that picture. Coordinates are PDF points, turned by the page's
 * viewport.
 */
import { smoothPath, strokeToFrame, pdfToFrame, type PageFrame, pressureOutline } from '#lib/document/pdf/pdf-geometry.js'
import type { PdfAnnotation } from '#lib/document/pdf/pdf-state.js'

import { HIGHLIGHT_OPACITY, type PlacedSignature } from './pdf-overlay'

function drawHighlight(ctx: CanvasRenderingContext2D, frame: PageFrame, annotation: Extract<PdfAnnotation, { kind: 'highlight' }>): void {
    ctx.fillStyle = annotation.colour
    ctx.globalAlpha = HIGHLIGHT_OPACITY
    ctx.globalCompositeOperation = 'multiply'
    const { quads } = annotation
    for (let i = 0; i + 7 < quads.length; i += 8) {
        const corners = [0, 2, 6, 4].map((at) => pdfToFrame(frame, quads[i + at], quads[i + at + 1]))
        ctx.beginPath()
        corners.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
        ctx.closePath()
        ctx.fill()
    }
}

function drawStroke(ctx: CanvasRenderingContext2D, frame: PageFrame, annotation: Extract<PdfAnnotation, { kind: 'stroke' }>): void {
    if (annotation.pressures) {
        ctx.fillStyle = annotation.colour
        ctx.fill(new Path2D(pressureOutline(strokeToFrame(frame, annotation.points), annotation.pressures, annotation.width)))
        return
    }
    ctx.strokeStyle = annotation.colour
    ctx.lineWidth = annotation.width
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (annotation.tool === 'highlighter') {
        ctx.globalAlpha = HIGHLIGHT_OPACITY
        ctx.globalCompositeOperation = 'multiply'
    }
    ctx.stroke(new Path2D(smoothPath(strokeToFrame(frame, annotation.points))))
}

function drawNote(ctx: CanvasRenderingContext2D, frame: PageFrame, annotation: Extract<PdfAnnotation, { kind: 'note' }>): void {
    const [x, y] = pdfToFrame(frame, annotation.x, annotation.y)
    ctx.fillStyle = annotation.colour
    ctx.font = `${annotation.fontSize}px Helvetica, Arial, sans-serif`
    ctx.textBaseline = 'top'
    annotation.text.split('\n').forEach((line, index) => ctx.fillText(line, x, y + index * annotation.fontSize * 1.25))
}

export function drawAnnotations(ctx: CanvasRenderingContext2D, frame: PageFrame, scale: number, annotations: readonly PdfAnnotation[]): void {
    for (const annotation of annotations) {
        ctx.save()
        ctx.scale(scale, scale)
        if (annotation.kind === 'highlight') drawHighlight(ctx, frame, annotation)
        else if (annotation.kind === 'stroke') drawStroke(ctx, frame, annotation)
        else drawNote(ctx, frame, annotation)
        ctx.restore()
    }
}

export async function drawSignatures(ctx: CanvasRenderingContext2D, frame: PageFrame, scale: number, signatures: readonly PlacedSignature[]): Promise<void> {
    for (const signature of signatures) {
        const image = new Image()
        image.src = signature.url
        await image.decode()
        const [left, top] = pdfToFrame(frame, signature.x, signature.y + signature.height)
        ctx.drawImage(image, left * scale, top * scale, signature.width * scale, signature.height * scale)
    }
}
