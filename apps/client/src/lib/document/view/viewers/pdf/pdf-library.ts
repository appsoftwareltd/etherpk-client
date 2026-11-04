/**
 * pdf.js, loaded **lazily** on the first PDF anyone opens: it is the largest dependency in the app,
 * and a graph that never opens a PDF should never pay for it. Its worker comes from the bundle as a
 * URL, which `worker-src` permits. Pages render to canvases: nothing is framed (ADR 0055).
 */
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'

export type PdfDocument = PDFDocumentProxy
export type PdfLoadingTask = PDFDocumentLoadingTask
export type PdfLib = typeof import('pdfjs-dist')
export type PdfWeb = typeof import('pdfjs-dist/web/pdf_viewer.mjs')

let loaded: Promise<{ lib: PdfLib; web: PdfWeb; dataFiles: unknown }> | undefined

/** The library and its viewer, once per session, with the worker and the viewer's styles in place. */
export function loadPdfLibrary(): Promise<{ lib: PdfLib; web: PdfWeb; dataFiles: unknown }> {
    loaded ??= (async () => {
        const lib = await import('pdfjs-dist')
        const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
        lib.GlobalWorkerOptions.workerSrc = worker.default
        // The viewer module reads the library from this global as it evaluates.
        ;(globalThis as { pdfjsLib?: PdfLib }).pdfjsLib = lib
        const [web, { PdfDataFiles }] = await Promise.all([
            import('pdfjs-dist/web/pdf_viewer.mjs'),
            import('./pdf-data-files'),
            import('pdfjs-dist/web/pdf_viewer.css'),
        ])
        return { lib, web, dataFiles: PdfDataFiles }
    })()
    return loaded
}

/** The asks pdf.js makes for a password: the first time, and after a wrong one. */
export type PasswordAsk = (answer: (password: string) => void, wrong: boolean) => void

/**
 * Open a PDF from its bytes. The bytes are copied, because pdf.js moves the buffer it is given to
 * its worker, and the caller keeps its own for the hash and for a saved copy.
 */
export async function openPdf(bytes: Uint8Array, askPassword: PasswordAsk): Promise<PdfLoadingTask> {
    const { lib, dataFiles } = await loadPdfLibrary()
    const task = lib.getDocument({
        data: bytes.slice(),
        // Every data file comes through the page (see PdfDataFiles).
        BinaryDataFactory: dataFiles as never,
        useWorkerFetch: false,
    })
    task.onPassword = (answer: (password: string) => void, reason: number) => {
        askPassword(answer, reason === lib.PasswordResponses.INCORRECT_PASSWORD)
    }
    return task
}

/** SHA-256 of the bytes, in hex: what a PDF's own state is stored under on both backends. */
export async function pdfHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
