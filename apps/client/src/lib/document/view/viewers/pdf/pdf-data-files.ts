/**
 * Where pdf.js's data files are in the build: CMaps for CJK text, the standard fonts a PDF may name
 * without embedding, and the WASM decoders for JPEG 2000 and JBIG2 images. Vite gives each a hashed
 * address, so a release that did not change one keeps its address, and the service worker fetches
 * them on first use rather than at install (`isOnDemandAppFile`). This module is imported only
 * when a PDF opens. `no-inline` matters: a small file would otherwise become a `data:` URL, which
 * the CSP's `connect-src` refuses.
 */
const FILES = {
    ...import.meta.glob('/node_modules/pdfjs-dist/cmaps/*.bcmap', { eager: true, import: 'default', query: '?url&no-inline' }),
    ...import.meta.glob('/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', { eager: true, import: 'default', query: '?url&no-inline' }),
    ...import.meta.glob('/node_modules/pdfjs-dist/wasm/*.wasm', { eager: true, import: 'default', query: '?url&no-inline' }),
} as Record<string, string>

const BY_NAME = new Map(Object.entries(FILES).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]))

/**
 * pdf.js's `BinaryDataFactory`: the worker asks the page for a data file by name. Its stock factory
 * joins a base address and a file name, which a hashed build cannot serve.
 */
export class PdfDataFiles {
    async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
        const url = BY_NAME.get(filename)
        if (!url) throw new Error(`pdf.js asked for ${kind} data the build does not hold: ${filename}`)
        const response = await fetch(url)
        if (!response.ok) throw new Error(`pdf.js data file ${filename} answered ${response.status}`)
        return new Uint8Array(await response.arrayBuffer())
    }
}
