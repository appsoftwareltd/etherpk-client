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

/** The bits of pdf.js this viewer uses, so the lazy import stays typed without importing eagerly. */
type PdfPage = {
    getViewport(options: { scale: number }): { width: number; height: number }
    render(options: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> }
}
export interface PdfDocument {
    numPages: number
    getPage(pageNumber: number): Promise<PdfPage>
    destroy(): Promise<void>
}

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
    return (await lib.getDocument({ url }).promise) as unknown as PdfDocument
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
    const context = canvas.getContext('2d')
    if (!context) return
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    // CSS size is the unscaled box; the backing store carries the extra device pixels.
    canvas.style.width = `${Math.floor(viewport.width / dpr)}px`
    canvas.style.height = `${Math.floor(viewport.height / dpr)}px`
    await page.render({ canvasContext: context, viewport }).promise
}
