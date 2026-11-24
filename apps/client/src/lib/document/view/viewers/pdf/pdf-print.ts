/**
 * Printing a PDF. A frame holding the file is refused (ADR 0055), so this prints the way pdf.js's own
 * viewer does: render each page into an image, in a container only print media shows, and ask the
 * browser to print the window (`print-window.ts`).
 */
import { printContainer, type PrintOutcome } from '#lib/document/print/print-window.js'
import type { PdfAnnotation } from '#lib/document/pdf/pdf-state.js'

import type { PdfDocument, PdfLib } from './pdf-library'
import { frameOf, type PlacedSignature } from './pdf-overlay'
import { drawAnnotations, drawSignatures } from './pdf-render-marks'

/** Dots per PDF point: 150 dpi, sharp on paper without holding gigabytes for a long document. */
const PRINT_SCALE = 150 / 72

export interface PrintOptions {
    pdf: PdfDocument
    lib: PdfLib
    /** Empty to print a clean page. */
    annotations: readonly PdfAnnotation[]
    signatures: readonly PlacedSignature[]
    onProgress?: (done: number, total: number) => void
    signal?: AbortSignal
}

async function pageImage(options: PrintOptions, pageNumber: number): Promise<{ url: string; width: number; height: number }> {
    const { pdf, lib, annotations, signatures } = options
    const page = await pdf.getPage(pageNumber)
    const viewport = page.getViewport({ scale: PRINT_SCALE })
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    await page.render({
        canvas,
        viewport,
        intent: 'print',
        annotationMode: lib.AnnotationMode.ENABLE_STORAGE,
        printAnnotationStorage: pdf.annotationStorage.print,
    }).promise
    const frame = frameOf({ id: pageNumber, div: canvas, pdfPage: page })
    const ctx = canvas.getContext('2d')
    if (frame && ctx) {
        drawAnnotations(ctx, frame, PRINT_SCALE, annotations.filter((a) => a.page === pageNumber))
        await drawSignatures(ctx, frame, PRINT_SCALE, signatures.filter((s) => s.page === pageNumber))
    }
    page.cleanup()
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    canvas.width = canvas.height = 0
    if (!blob) throw new Error('The browser could not draw a page for printing.')
    return { url: URL.createObjectURL(blob), width: viewport.width / PRINT_SCALE, height: viewport.height / PRINT_SCALE }
}

/** Print the whole document. Resolves once the browser's dialog has closed, or could not be told of. */
export async function printPdf(options: PrintOptions): Promise<PrintOutcome> {
    const { pdf, onProgress, signal } = options
    const urls: string[] = []
    const container = document.createElement('div')
    container.className = 'etherpk-pdf-print'
    let styles = ''
    try {
        for (let n = 1; n <= pdf.numPages; n++) {
            signal?.throwIfAborted()
            const { url, width, height } = await pageImage(options, n)
            urls.push(url)
            const image = document.createElement('img')
            image.src = url
            image.alt = ''
            image.style.width = `${width}pt`
            image.style.height = `${height}pt`
            container.append(image)
            if (n === 1) styles = `@page { size: ${width}pt ${height}pt; margin: 0 }`
            onProgress?.(n, pdf.numPages)
        }
        signal?.throwIfAborted()
        return await printContainer({ container, styles })
    } finally {
        for (const url of urls) URL.revokeObjectURL(url)
    }
}
