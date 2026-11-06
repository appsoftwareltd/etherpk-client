/**
 * A picture of a drawing: Excalidraw's own SVG export, with the fonts its text uses embedded whole
 * (the build makes Excalidraw embed them whole rather than shrink them, see vite.config.ts), so the
 * picture stands on its own: in the document, on a phone, and as a file of a published site.
 *
 * Always light, in either of the app's themes: Excalidraw's dark mode inverts a drawing's colours as
 * it draws them, so a picture in it would not show the colours the drawing holds.
 */
import type { Drawing } from './format'
import { type ImageReader, readPictureFiles } from './images'
import type { ExcalidrawKit } from './load'
import { restoreScene } from './scene'

interface Exported {
    svg: SVGSVGElement
    /** Whatever could not be read, drawn as a grey box. */
    missing: readonly string[]
    /** The images' size in memory, as data URLs. */
    size: number
}

/** Kept pictures, by what they show, so a drawing scrolled back into view is not exported again. */
const kept = new Map<string, { picture: Promise<Exported>; size: number }>()
const KEEP = 24
/** A picture holds its images whole, so what is kept is bounded by size too. The newest always stays. */
const KEEP_SIZE = 64 * 1024 * 1024

function bound(): void {
    let total = 0
    for (const { size } of kept.values()) total += size
    for (const [key, { size }] of kept) {
        if (kept.size <= 1 || (kept.size <= KEEP && total <= KEEP_SIZE)) return
        kept.delete(key)
        total -= size
    }
}

async function exportPicture(kit: ExcalidrawKit, drawing: Pick<Drawing, 'header' | 'elements'>, read: ImageReader): Promise<Exported> {
    const elements = restoreScene(kit, drawing.elements)
    const { files, missing } = await readPictureFiles(elements, read)
    const svg = await kit.excalidraw.exportToSvg({
        elements: elements as never,
        appState: {
            viewBackgroundColor: drawing.header?.background ?? '#ffffff',
            exportBackground: true,
            exportWithDarkMode: false,
            exportEmbedScene: false,
        },
        files: files as never,
        exportPadding: 16,
    })
    return { svg, missing, size: Object.values(files).reduce((sum, file) => sum + file.dataURL.length, 0) }
}

/**
 * The picture of a drawing. An image that cannot be read is a grey box, and the picture is not kept,
 * so it is read again next time. With `requireImages` such a picture rejects instead, saying which.
 */
export async function drawingSvg(kit: ExcalidrawKit, drawing: Pick<Drawing, 'header' | 'elements'>, read: ImageReader, options: { requireImages?: boolean } = {}): Promise<SVGSVGElement> {
    const key = `${drawing.header?.background ?? ''}\n${JSON.stringify(drawing.elements)}`
    let entry = kept.get(key)
    if (!entry) {
        const made = { picture: exportPicture(kit, drawing, read), size: 0 }
        entry = made
        kept.set(key, made)
        made.picture.then(
            ({ missing, size }) => {
                if (missing.length > 0) kept.delete(key)
                else {
                    made.size = size
                    bound()
                }
            },
            () => kept.delete(key),
        )
        bound()
    }
    const { svg, missing } = await entry.picture
    if (options.requireImages && missing.length > 0) throw new Error(`it holds an image the graph could not read (${missing[0]})`)
    // Each caller gets its own copy: one element cannot sit in two places in the page.
    return svg.cloneNode(true) as SVGSVGElement
}

/**
 * The picture as a file: its bytes, size and type, for a published site and for a quote of the
 * drawing, such as a reference in the Backlinks panel.
 */
export async function drawingFile(kit: ExcalidrawKit, drawing: Pick<Drawing, 'header' | 'elements'>, read: ImageReader, options: { requireImages?: boolean } = {}): Promise<{ bytes: Uint8Array; width: number; height: number }> {
    const svg = await drawingSvg(kit, drawing, read, options)
    const width = Math.round(Number.parseFloat(svg.getAttribute('width') ?? '0')) || 640
    const height = Math.round(Number.parseFloat(svg.getAttribute('height') ?? '0')) || 360
    if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    const text = new XMLSerializer().serializeToString(svg)
    return { bytes: new TextEncoder().encode(text), width, height }
}
