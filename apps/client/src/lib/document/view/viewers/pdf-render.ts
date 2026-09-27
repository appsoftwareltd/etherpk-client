/**
 * The pdf.js side of the PDF viewer, kept out of the component so the page-rendering rules are
 * plain functions rather than lifecycle.
 *
 * pdf.js is loaded **lazily**, on the first PDF anyone opens: it is the largest dependency in
 * the app and a graph that never opens a PDF should never pay for it. Its worker comes from the
 * bundle as a URL — `worker-src` already permits `'self'` and `blob:`, so nothing about the
 * policy changes (ADR 0055 is about *framing*, which this deliberately avoids).
 *
 * Pages render to a `<canvas>`. There is no iframe, no `blob:` document inheriting this app's
 * origin, and no content sniffing — which is the whole reason the browser's own viewer was
 * turned down.
 */

import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'

/**
 * An open PDF, typed from pdf.js itself so an API change fails the type check rather than the
 * running app. The import is type-only: the library still loads lazily, below.
 */
export type PdfDocument = PDFDocumentProxy
type PdfPage = PDFPageProxy

let pdfjs: Promise<typeof import('pdfjs-dist')> | undefined

/** Load pdf.js once per session and point it at its bundled worker. */
async function library(): Promise<typeof import('pdfjs-dist')> {
    pdfjs ??= (async () => {
        const lib = await import('pdfjs-dist')
        const workerUrl = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
        lib.GlobalWorkerOptions.workerSrc = workerUrl.default
        return lib
    })()
    return pdfjs
}

/** Open a PDF from an object URL. Rejects when the bytes are not a PDF at all. */
export async function openPdf(url: string): Promise<PdfDocument> {
    const lib = await library()
    return lib.getDocument({ url }).promise
}

/**
 * Release an open PDF: its worker, its buffers and its fonts. The loading task owns them; the
 * document itself has no destroy().
 */
export function closePdf(document: PdfDocument): Promise<void> {
    return document.loadingTask.destroy()
}

/**
 * The scale that fits `page` to `containerWidth`, capped so a small page is not blown up past
 * its natural size into a blur. `devicePixelRatio` is applied separately, to the canvas backing
 * store, so the page stays sharp on a retina display without changing its layout size.
 */
export function fitScale(pageWidth: number, containerWidth: number, max = 2): number {
    if (pageWidth <= 0 || containerWidth <= 0) return 1
    return Math.min(containerWidth / pageWidth, max)
}

/** Render one page into a canvas at `scale`, sharp on a high-density display. */
export async function renderPage(page: PdfPage, canvas: HTMLCanvasElement, scale: number): Promise<void> {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 3)
    const viewport = page.getViewport({ scale: scale * dpr })
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    // CSS size is the unscaled box; the backing store carries the extra device pixels.
    canvas.style.width = `${Math.floor(viewport.width / dpr)}px`
    canvas.style.height = `${Math.floor(viewport.height / dpr)}px`
    await page.render({ canvas, viewport }).promise
}
