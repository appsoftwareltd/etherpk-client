/**
 * What a person has put on a PDF's pages, drawn over them: one overlay per rendered page, holding an
 * SVG for highlights and strokes, and elements for typed notes and placed signatures. EtherPK draws
 * this itself rather than through pdf.js's annotation editor, whose editors cannot be told a pen from
 * a finger, have no eraser for one stroke, and can be restored only through its paste path.
 *
 * The SVG's units are PDF points at scale 1 (`PageFrame`), so a zoom only stretches it. pdf.js clears
 * a page's children when it evicts or re-renders one, so an overlay is attached again each time its
 * page renders. Everything here is built with DOM calls and no HTML strings (ADR 0130).
 */
import { frameToPdf, pdfToFrame, quadsHit, smoothPath, strokeHit, strokeToFrame, type PageFrame, createStreamline, pressureOutline, settleStroke, type Streamline } from '#lib/document/pdf/pdf-geometry.js'
import type { PdfAnnotation, PdfNote } from '#lib/document/pdf/pdf-state.js'

const SVG = 'http://www.w3.org/2000/svg'

export type PdfTool = 'none' | 'select' | 'highlight' | 'pen' | 'highlighter' | 'note' | 'eraser'

/** A signature placed on a page. Held in memory only: it is never saved with the annotations. */
export interface PlacedSignature {
    id: string
    page: number
    /** Left, bottom, in PDF points, with its size. */
    x: number
    y: number
    width: number
    height: number
    url: string
}

/** What the overlays ask of the reader. */
export interface OverlayHost {
    tool(): PdfTool
    /** Whether a finger draws, rather than scrolls, with a drawing tool on. */
    fingerDraws(): boolean
    annotationsOn(page: number): readonly PdfAnnotation[]
    /** Whether the person has a PDF Bookmark on this page. */
    isBookmarked(page: number): boolean
    signaturesOn(page: number): readonly PlacedSignature[]
    /** A stroke was finished, in PDF points. */
    strokeDone(page: number, tool: 'pen' | 'highlighter', points: number[], pressures?: number[]): void
    /** Whether a stylus's pressure changes the Pen's width. */
    usesPressure(): boolean
    strokeWidth(tool: 'pen' | 'highlighter'): number
    strokeColour(tool: 'pen' | 'highlighter'): string
    erase(id: string): void
    placeNote(page: number, x: number, y: number): void
    openNote(id: string): void
    moveSignature(id: string, change: Partial<Pick<PlacedSignature, 'x' | 'y' | 'width' | 'height'>>): void
    removeSignature(id: string): void
}

/** A page as pdf.js's viewer holds it: only what the overlay touches. */
export interface OverlayPage {
    id: number
    div: HTMLElement
    /** Its size on screen at the current zoom, whether or not it is in the document. */
    viewport?: { width: number }
    pdfPage: { getViewport(options: { scale: number }): { width: number; height: number; transform: number[] } } | null
}

export function frameOf(page: OverlayPage): PageFrame | null {
    const viewport = page.pdfPage?.getViewport({ scale: 1 })
    if (!viewport) return null
    const [a, b, c, d, e, f] = viewport.transform
    return { width: viewport.width, height: viewport.height, transform: [a, b, c, d, e, f] }
}

/** The width a highlight stroke's opacity reads at: the page must show through. */
export const HIGHLIGHT_OPACITY = 0.38

/** How far a stylus's pressure moves toward each new reading. */
const PRESSURE_FOLLOW = 0.3

/** A stroke being drawn. */
interface LiveStroke {
    pointerId: number
    tool: 'pen' | 'highlighter'
    points: number[]
    /** One for each point when a stylus is drawing with pressure. */
    pressures: number[] | null
    steady: Streamline
    /** Where the pointer really is, which the steadied line trails. */
    reached: [number, number]
    path: SVGPathElement
}

function svgElement<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string>): SVGElementTagNameMap[K] {
    const element = document.createElementNS(SVG, name)
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value)
    return element
}

function highlightElement(frame: PageFrame, annotation: Extract<PdfAnnotation, { kind: 'highlight' }>): SVGElement {
    const group = svgElement('g', { 'data-annotation': annotation.id, 'data-kind': 'highlight', fill: annotation.colour, opacity: String(HIGHLIGHT_OPACITY) })
    const { quads } = annotation
    for (let i = 0; i + 7 < quads.length; i += 8) {
        // Quad order is top left, top right, bottom left, bottom right, so the outline crosses over
        // unless the last two corners swap.
        const corners = [0, 2, 6, 4].map((at) => pdfToFrame(frame, quads[i + at], quads[i + at + 1]))
        group.append(svgElement('polygon', { points: corners.map((p) => p.join(',')).join(' ') }))
    }
    return group
}

/** A line of one width strokes a path. One whose width changes fills its outline. */
function pathAttributes(points: readonly number[], pressures: readonly number[] | null, colour: string, width: number): Record<string, string> {
    if (pressures) return { d: pressureOutline(points, pressures, width), fill: colour }
    return { d: smoothPath(points), fill: 'none', stroke: colour, 'stroke-width': String(width), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
}

function strokeElement(frame: PageFrame, annotation: Extract<PdfAnnotation, { kind: 'stroke' }>): SVGElement {
    return svgElement('path', {
        'data-annotation': annotation.id,
        'data-kind': annotation.tool,
        ...pathAttributes(strokeToFrame(frame, annotation.points), annotation.pressures ?? null, annotation.colour, annotation.width),
        ...(annotation.tool === 'highlighter' ? { opacity: String(HIGHLIGHT_OPACITY) } : {}),
    })
}

function positionPercent(frame: PageFrame, element: HTMLElement, x: number, y: number): void {
    const [left, top] = pdfToFrame(frame, x, y)
    element.style.left = `${(left / frame.width) * 100}%`
    element.style.top = `${(top / frame.height) * 100}%`
}

/** The mark in a page's corner that says it has a PDF Bookmark, as the editor marks a bookmarked line. */
function bookmarkFlag(page: number): HTMLElement {
    const flag = document.createElement('span')
    flag.className = 'etherpk-pdf-bookmark-flag'
    flag.setAttribute('data-testid', 'pdf-bookmark-flag')
    flag.setAttribute('role', 'img')
    flag.setAttribute('aria-label', `Page ${page} has a PDF Bookmark`)
    return flag
}

/** One page's overlay. */
class PageOverlay {
    readonly root = document.createElement('div')
    private readonly svg = svgElement('svg', { class: 'etherpk-pdf-svg' })
    private readonly items = document.createElement('div')
    private live: LiveStroke | null = null
    private penDown = false
    private erasing = false

    constructor(
        readonly page: OverlayPage,
        private readonly host: OverlayHost,
    ) {
        this.root.className = 'etherpk-pdf-overlay'
        this.root.setAttribute('data-page', String(page.id))
        this.items.className = 'etherpk-pdf-items'
        this.root.append(this.svg, this.items)
        this.listen()
    }

    private frame(): PageFrame | null {
        return frameOf(this.page)
    }

    private listen(): void {
        this.root.addEventListener('pointerdown', (event) => this.onPointerDown(event))
        this.root.addEventListener('pointermove', (event) => this.onPointerMove(event))
        this.root.addEventListener('pointerup', (event) => this.onPointerUp(event))
        this.root.addEventListener('pointercancel', () => this.cancelStroke())
        this.root.addEventListener('click', (event) => this.onClick(event))
        // A stylus would otherwise start a scroll, and so would a finger that draws. A finger scrolls
        // with a drawing tool on only when it does not draw.
        // Pointer events come first, so `penDown` is already set. iOS also says so on the touch.
        this.root.addEventListener(
            'touchstart',
            (event) => {
                const stylus = (event.touches[0] as Touch & { touchType?: string } | undefined)?.touchType === 'stylus'
                if (this.drawingTool() && (this.penDown || stylus || this.host.fingerDraws()) && event.touches.length === 1) event.preventDefault()
            },
            { passive: false },
        )
    }

    private drawingTool(): boolean {
        const tool = this.host.tool()
        return tool === 'pen' || tool === 'highlighter' || tool === 'eraser'
    }

    private pointFrom(event: { clientX: number; clientY: number }): [number, number] | null {
        const frame = this.frame()
        if (!frame) return null
        const box = this.root.getBoundingClientRect()
        return [((event.clientX - box.left) / box.width) * frame.width, ((event.clientY - box.top) / box.height) * frame.height]
    }

    private takesPointer(event: PointerEvent): boolean {
        if (event.button !== 0) return false
        return event.pointerType !== 'touch' || this.host.fingerDraws()
    }

    private onPointerDown(event: PointerEvent): void {
        this.penDown = event.pointerType === 'pen'
        if (!this.drawingTool() || !this.takesPointer(event)) return
        const tool = this.host.tool()
        event.preventDefault()
        this.root.setPointerCapture(event.pointerId)
        if (tool === 'eraser') {
            this.erasing = true
            this.eraseAt(event)
            return
        }
        this.startStroke(event, tool as 'pen' | 'highlighter')
    }

    private startStroke(event: PointerEvent, tool: 'pen' | 'highlighter'): void {
        const point = this.pointFrom(event)
        const frame = this.frame()
        if (!point || !frame) return
        const path = svgElement('path', { 'data-live': 'true', ...(tool === 'highlighter' ? { opacity: String(HIGHLIGHT_OPACITY) } : {}) })
        this.svg.append(path)
        // About one pixel on screen, at any zoom.
        const steady = createStreamline(frame.width / this.root.getBoundingClientRect().width)
        steady.next(point[0], point[1])
        const pressures = tool === 'pen' && event.pointerType === 'pen' && this.host.usesPressure() ? [event.pressure] : null
        this.live = { pointerId: event.pointerId, tool, points: [...point], pressures, steady, reached: point, path }
        this.drawLive()
    }

    private drawLive(): void {
        if (!this.live) return
        const { tool, points, pressures, path } = this.live
        for (const [name, value] of Object.entries(pathAttributes(points, pressures, this.host.strokeColour(tool), this.host.strokeWidth(tool)))) path.setAttribute(name, value)
    }

    private onPointerMove(event: PointerEvent): void {
        if (this.erasing) {
            this.eraseAt(event)
            return
        }
        if (!this.live || event.pointerId !== this.live.pointerId) return
        // Coalesced events are the points the browser merged between frames. Without them a fast
        // stylus stroke draws as a coarse polygon.
        const events = event.getCoalescedEvents?.() ?? []
        for (const each of events.length > 0 ? events : [event]) this.addLivePoint(each)
        this.drawLive()
    }

    private addLivePoint(event: PointerEvent): void {
        const live = this.live
        const point = this.pointFrom(event)
        if (!live || !point) return
        live.reached = point
        const steadied = live.steady.next(point[0], point[1])
        if (!steadied) return
        live.points.push(...steadied)
        if (live.pressures) {
            // A hand's pressure jitters more than its line does, and a width that jumps shows at once.
            const held = live.pressures[live.pressures.length - 1]
            live.pressures.push(Math.round((held + (event.pressure - held) * PRESSURE_FOLLOW) * 100) / 100)
        }
    }

    private onPointerUp(event: PointerEvent): void {
        this.penDown = false
        if (this.erasing) {
            this.erasing = false
            return
        }
        if (!this.live || event.pointerId !== this.live.pointerId) return
        const live = this.live
        this.live = null
        live.path.remove()
        this.finishStroke(live)
    }

    private finishStroke({ tool, points, pressures, reached }: LiveStroke): void {
        const frame = this.frame()
        if (!frame) return
        // The steadied line trails the pointer, and the stroke ends where the pen came off the page.
        if (points.length > 2 || reached[0] !== points[0] || reached[1] !== points[1]) {
            points.push(...reached)
            if (pressures) pressures.push(pressures[pressures.length - 1])
        }
        const settled = settleStroke(points)
        const inPdf: number[] = []
        for (let i = 0; i < settled.length; i += 2) inPdf.push(...frameToPdf(frame, settled[i], settled[i + 1]))
        this.host.strokeDone(this.page.id, tool, inPdf, pressures ?? undefined)
    }

    /** A second finger arrived: this was a pinch, not a stroke. */
    cancelStroke(): void {
        this.live?.path.remove()
        this.live = null
        this.penDown = false
        this.erasing = false
    }

    private eraseAt(event: PointerEvent): void {
        const point = this.pointFrom(event)
        const frame = this.frame()
        if (!point || !frame) return
        const [x, y] = frameToPdf(frame, point[0], point[1])
        const box = this.root.getBoundingClientRect()
        // A tolerance the same size on screen at any zoom.
        const tolerance = (8 / box.width) * frame.width
        for (const annotation of this.host.annotationsOn(this.page.id)) {
            if (annotationHit(annotation, x, y, tolerance)) this.host.erase(annotation.id)
        }
    }

    private onClick(event: MouseEvent): void {
        if (this.host.tool() !== 'note' || event.target !== this.root) return
        const frame = this.frame()
        const point = this.pointFrom(event)
        if (!frame || !point) return
        const [x, y] = frameToPdf(frame, point[0], point[1])
        this.host.placeNote(this.page.id, x, y)
    }

    /** Draw what the page holds. */
    render(): void {
        const frame = this.frame()
        if (!frame) return
        this.svg.setAttribute('viewBox', `0 0 ${frame.width} ${frame.height}`)
        const annotations = this.host.annotationsOn(this.page.id)
        const drawn: SVGElement[] = []
        const notes: HTMLElement[] = []
        for (const annotation of annotations) {
            if (annotation.kind === 'highlight') drawn.push(highlightElement(frame, annotation))
            else if (annotation.kind === 'stroke') drawn.push(strokeElement(frame, annotation))
            else notes.push(this.noteElement(frame, annotation))
        }
        const live = this.live?.path
        this.svg.replaceChildren(...drawn, ...(live ? [live] : []))
        const signatures = this.host.signaturesOn(this.page.id).map((signature) => this.signatureElement(frame, signature))
        const flag = this.host.isBookmarked(this.page.id) ? [bookmarkFlag(this.page.id)] : []
        this.items.replaceChildren(...flag, ...notes, ...signatures)
    }

    private noteElement(frame: PageFrame, note: PdfNote): HTMLElement {
        const element = document.createElement('button')
        element.type = 'button'
        element.className = 'etherpk-pdf-note'
        element.setAttribute('data-annotation', note.id)
        element.setAttribute('data-kind', 'note')
        element.setAttribute('aria-label', `Note: ${note.text}`)
        element.textContent = note.text
        element.style.setProperty('--note-size', String(note.fontSize))
        element.style.setProperty('--note-colour', note.colour)
        positionPercent(frame, element, note.x, note.y)
        // The eraser takes a note on its click, which a pointer captured by the page would never send.
        element.addEventListener('pointerdown', (event) => {
            if (this.host.tool() === 'eraser') event.stopPropagation()
        })
        element.addEventListener('click', (event) => {
            event.stopPropagation()
            if (this.host.tool() === 'eraser') this.host.erase(note.id)
            else this.host.openNote(note.id)
        })
        return element
    }

    private signatureElement(frame: PageFrame, signature: PlacedSignature): HTMLElement {
        const box = document.createElement('div')
        box.className = 'etherpk-pdf-signature'
        box.setAttribute('data-signature', signature.id)
        positionPercent(frame, box, signature.x, signature.y + signature.height)
        box.style.width = `${(signature.width / frame.width) * 100}%`
        box.style.height = `${(signature.height / frame.height) * 100}%`
        const image = document.createElement('img')
        image.src = signature.url
        image.alt = 'Your signature'
        image.draggable = false
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'etherpk-pdf-signature-remove'
        remove.textContent = '×'
        remove.setAttribute('aria-label', 'Remove this signature')
        remove.addEventListener('click', () => this.host.removeSignature(signature.id))
        const resize = document.createElement('div')
        resize.className = 'etherpk-pdf-signature-resize'
        box.append(image, remove, resize)
        this.dragSignature(box, resize, frame, signature)
        return box
    }

    private dragSignature(box: HTMLElement, resize: HTMLElement, frame: PageFrame, signature: PlacedSignature): void {
        box.addEventListener('pointerdown', (event) => {
            // Kept from the page behind, whose drawing tools would take the pointer and the click with it.
            event.stopPropagation()
            if (event.target instanceof HTMLButtonElement) return
            event.preventDefault()
            const resizing = event.target === resize
            const start = this.pointFrom(event)
            if (!start) return
            const held = { ...signature }
            box.setPointerCapture(event.pointerId)
            const onMove = (move: PointerEvent) => {
                const point = this.pointFrom(move)
                if (!point) return
                const [dx, dy] = [point[0] - start[0], point[1] - start[1]]
                this.applyDrag(box, frame, held, dx, dy, resizing)
            }
            const onUp = (up: PointerEvent) => {
                box.removeEventListener('pointermove', onMove)
                box.removeEventListener('pointerup', onUp)
                const point = this.pointFrom(up)
                if (!point) return
                const [dx, dy] = [point[0] - start[0], point[1] - start[1]]
                this.host.moveSignature(signature.id, draggedSignature(held, dx, dy, resizing))
            }
            box.addEventListener('pointermove', onMove)
            box.addEventListener('pointerup', onUp)
        })
    }

    private applyDrag(box: HTMLElement, frame: PageFrame, held: PlacedSignature, dx: number, dy: number, resizing: boolean): void {
        const next = { ...held, ...draggedSignature(held, dx, dy, resizing) }
        positionPercent(frame, box, next.x, next.y + next.height)
        box.style.width = `${(next.width / frame.width) * 100}%`
        box.style.height = `${(next.height / frame.height) * 100}%`
    }
}

/** A signature dragged by `dx`, `dy` frame units: moved, or from its corner, resized in proportion. */
export function draggedSignature(held: PlacedSignature, dx: number, dy: number, resizing: boolean): Pick<PlacedSignature, 'x' | 'y' | 'width' | 'height'> {
    if (!resizing) return { x: held.x + dx, y: held.y - dy, width: held.width, height: held.height }
    const width = Math.max(24, held.width + dx)
    const height = (width / held.width) * held.height
    return { x: held.x, y: held.y + held.height - height, width, height }
}

function annotationHit(annotation: PdfAnnotation, x: number, y: number, tolerance: number): boolean {
    if (annotation.kind === 'stroke') return strokeHit(annotation.points, x, y, tolerance + annotation.width / 2)
    if (annotation.kind === 'highlight') return quadsHit(annotation.quads, x, y, 0)
    return false
}

/** Every page's overlay. */
export class PdfOverlays {
    private readonly pages = new Map<number, PageOverlay>()

    constructor(private readonly host: OverlayHost) {}

    /** Put a page's overlay back: pdf.js has just rendered it, and may have cleared its children. */
    attach(page: OverlayPage): void {
        let overlay = this.pages.get(page.id)
        if (!overlay || overlay.page !== page) {
            overlay = new PageOverlay(page, this.host)
            this.pages.set(page.id, overlay)
        }
        if (overlay.root.parentElement !== page.div) page.div.append(overlay.root)
        overlay.render()
    }

    refresh(): void {
        for (const overlay of this.pages.values()) if (overlay.root.isConnected) overlay.render()
    }

    cancelStroke(): void {
        for (const overlay of this.pages.values()) overlay.cancelStroke()
    }

    clear(): void {
        for (const overlay of this.pages.values()) overlay.root.remove()
        this.pages.clear()
    }
}
