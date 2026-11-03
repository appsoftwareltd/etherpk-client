/**
 * A picture of a drawing: Excalidraw's own SVG export, with the fonts its text uses embedded whole
 * (the build makes Excalidraw embed them whole rather than shrink them, see vite.config.ts), so the
 * picture stands on its own: in the document, on a phone, and as a file of a published site.
 *
 * Always light, in either of the app's themes: Excalidraw's dark mode inverts a drawing's colours as
 * it draws them, so a picture in it would not show the colours the drawing holds.
 */
import type { Drawing } from './format'
import type { ExcalidrawKit } from './load'
import { restoreScene } from './scene'

/** Kept pictures, by what they show, so a drawing scrolled back into view is not exported again. */
const kept = new Map<string, Promise<SVGSVGElement>>()
const KEEP = 24

export function drawingSvg(kit: ExcalidrawKit, drawing: Pick<Drawing, 'header' | 'elements'>): Promise<SVGSVGElement> {
    const key = `${drawing.header?.background ?? ''}\n${JSON.stringify(drawing.elements)}`
    let picture: Promise<SVGSVGElement> | undefined = kept.get(key)
    if (!picture) {
        const elements = restoreScene(kit, drawing.elements)
        const exported: Promise<SVGSVGElement> = kit.excalidraw.exportToSvg({
            elements: elements as never,
            appState: {
                viewBackgroundColor: drawing.header?.background ?? '#ffffff',
                exportBackground: true,
                exportWithDarkMode: false,
                exportEmbedScene: false,
            },
            files: null,
            exportPadding: 16,
        })
        exported.catch(() => kept.delete(key))
        kept.set(key, exported)
        if (kept.size > KEEP) kept.delete(kept.keys().next().value as string)
        picture = exported
    }
    // Each caller gets its own copy: one element cannot sit in two places in the page.
    return picture.then((svg) => svg.cloneNode(true) as SVGSVGElement)
}

/**
 * The picture as a file: its bytes, size and type, for a published site and for a quote of the
 * drawing, such as a reference in the Backlinks panel.
 */
export async function drawingFile(kit: ExcalidrawKit, drawing: Pick<Drawing, 'header' | 'elements'>): Promise<{ bytes: Uint8Array; width: number; height: number }> {
    const svg = await drawingSvg(kit, drawing)
    const width = Math.round(Number.parseFloat(svg.getAttribute('width') ?? '0')) || 640
    const height = Math.round(Number.parseFloat(svg.getAttribute('height') ?? '0')) || 360
    if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    const text = new XMLSerializer().serializeToString(svg)
    return { bytes: new TextEncoder().encode(text), width, height }
}
