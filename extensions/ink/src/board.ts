/**
 * The live board: a Canvas 2D view of the drawing on an endless sheet, and the pointer handling
 * that draws, erases, selects, moves, pans and zooms on it.
 *
 * - **Drawing.** Committed strokes are drawn from `Path2D`s kept per line of text (so a stroke is
 *   outlined once, not on every frame), highlighters first and translucent, then pens; the stroke
 *   being drawn goes on top, outlined afresh each frame. The canvas is scaled by the device's pixel
 *   ratio, so ink is sharp on a high-density screen.
 * - **Writing.** The board never changes the drawing itself: a finished stroke, an erase or a move
 *   goes to its `BoardHost`, which asks the Client for the fence edit, and the board draws from the
 *   body that comes back (`setDrawing`). Until it does, what was just done stays drawn (`awaiting`),
 *   so nothing flickers; a refused change is dropped.
 * - **Input** (`input.ts`): the tool, a pen's eraser end, palm rejection once a pen is seen, two
 *   fingers to pinch, the middle button or Space to pan, the wheel to pan and Ctrl/Cmd+wheel (a
 *   trackpad's pinch) to zoom.
 */
import { type Camera, fitTo, HOME, panBy, screenToWorld, visibleBounds, zoomAbout } from './camera'
import { HIGHLIGHTER_OPACITY, type InkDrawing, type InkPaper, type InkStroke, type InkTool, newStrokeId } from './format'
import { type Bounds, containsPoint, drawingBounds, eraserTouches, lassoTakes, padded, type Point, simplifiedPoints, strokeBounds, unionBounds } from './geometry'
import { type BoardTool, newTrail, type PointerSample, pointerIntent, pointPressure, type SampleTrail, takeSamples } from './input'
import { DOT_COLOUR, DOT_RADIUS, DOT_SPACING, LINE_COLOUR, LINE_SPACING, PAPER_COLOUR, strokePath } from './outline'

/** The eraser's reach, in screen pixels. */
const ERASER_RADIUS = 8
/** The selection's outline: an accent that reads on white paper. */
const SELECTION_COLOUR = '#1971c2'
/** The paper's marks are left out once they would be closer than this on screen. */
const MIN_MARK_SPACING = 6

export interface BoardHost {
    /** Whether the drawing can be changed now. */
    writable(): boolean
    tool(): BoardTool
    /** The colour and width the drawing tool draws with. */
    brush(tool: InkTool): { colour: string; size: number }
    /** Ask for each change: false when it was refused. */
    addStroke(stroke: InkStroke): boolean
    erase(ids: ReadonlySet<string>): boolean
    move(ids: ReadonlySet<string>, dx: number, dy: number): boolean
    /** The selection changed (how many strokes it holds). */
    selectionChanged(count: number): void
    /** The view moved or zoomed. */
    cameraChanged(camera: Camera): void
}

type Gesture =
    | { kind: 'stroke'; pointerId: number; pointerType: string; stroke: InkStroke; trail: SampleTrail }
    | { kind: 'erase'; pointerId: number; pointerType: string; last: Point; ids: Set<string> }
    | { kind: 'lasso'; pointerId: number; pointerType: string; polygon: Point[] }
    | { kind: 'move'; pointerId: number; pointerType: string; start: Point; dx: number; dy: number }
    | { kind: 'pan'; pointerId: number; pointerType: string; last: Point }
    | { kind: 'pinch'; ids: [number, number]; mid: Point; distance: number }

interface CachedStroke {
    stroke: InkStroke
    path: Path2D
    bounds: Bounds
}

/** What was just done and is not in the body yet, drawn until the body comes back. */
interface Awaiting {
    stroke?: InkStroke
    erased?: ReadonlySet<string>
    moved?: { ids: ReadonlySet<string>; dx: number; dy: number }
}

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

export class InkBoardCanvas {
    private drawing: InkDrawing | null = null
    private cache = new Map<string, CachedStroke>()
    private camera: Camera = HOME
    /**
     * Whether the person has done anything on the board yet. Until then the view is fitted to the
     * drawing again whenever the canvas changes size, as it does while the editor makes room for it.
     */
    private used = false
    private width = 0
    private height = 0
    private ratio = 1
    private penSeen = false
    private spaceHeld = false
    private readonly touches = new Map<number, Point>()
    private gesture: Gesture | null = null
    private selection = new Set<string>()
    private awaiting: Awaiting = {}
    private hover: Point | null = null
    private frame = 0
    private readonly resize: ResizeObserver
    private readonly context: CanvasRenderingContext2D | null

    constructor(
        private readonly canvas: HTMLCanvasElement,
        private readonly host: BoardHost,
    ) {
        this.context = canvas.getContext('2d')
        canvas.addEventListener('pointerdown', this.onPointerDown)
        canvas.addEventListener('pointermove', this.onPointerMove)
        canvas.addEventListener('pointerup', this.onPointerUp)
        canvas.addEventListener('pointercancel', this.onPointerCancel)
        canvas.addEventListener('pointerleave', this.onPointerLeave)
        canvas.addEventListener('wheel', this.onWheel, { passive: false })
        canvas.addEventListener('contextmenu', this.onContextMenu)
        this.resize = new ResizeObserver(() => this.measure())
        this.resize.observe(canvas)
        this.measure()
    }

    /** The drawing as the body now holds it. */
    setDrawing(drawing: InkDrawing): void {
        this.drawing = drawing
        const live = new Set<string>()
        for (const { stroke, text } of drawing.strokes) {
            live.add(text)
            if (!this.cache.has(text)) this.cache.set(text, { stroke, path: new Path2D(strokePath(stroke)), bounds: strokeBounds(stroke) })
        }
        for (const text of [...this.cache.keys()]) if (!live.has(text)) this.cache.delete(text)
        // The body came back: what was waiting for it is in it now, or was overtaken.
        const ids = new Set(drawing.strokes.map((s) => s.stroke.id))
        if (this.awaiting.stroke && ids.has(this.awaiting.stroke.id)) delete this.awaiting.stroke
        delete this.awaiting.erased
        delete this.awaiting.moved
        const before = this.selection.size
        for (const id of [...this.selection]) if (!ids.has(id)) this.selection.delete(id)
        if (this.selection.size !== before) this.host.selectionChanged(this.selection.size)
        if (!this.used && this.width > 0) this.fitView()
        this.requestDraw()
    }

    /** The view that shows the whole drawing. */
    fit(): void {
        this.used = true
        this.fitView()
    }

    private fitView(): void {
        this.setCamera(fitTo(this.drawing ? drawingBounds(this.drawing.strokes.map((s) => s.stroke)) : null, this.width, this.height))
    }

    /** Zoom about the middle of the canvas. */
    zoomBy(factor: number): void {
        this.used = true
        this.setCamera(zoomAbout(this.camera, { x: this.width / 2, y: this.height / 2 }, factor))
    }

    setSpaceHeld(held: boolean): void {
        this.spaceHeld = held
        // Data attributes, not classes: Svelte owns the canvas's class list.
        this.canvas.toggleAttribute('data-pan', held)
    }

    /** The grabbing cursor while the sheet is dragged. */
    private setGrabbing(grabbing: boolean): void {
        this.canvas.toggleAttribute('data-grabbing', grabbing)
    }

    /** Whether a pen has been seen, after which fingers only pan and zoom. */
    get penMode(): boolean {
        return this.penSeen
    }

    get selectionSize(): number {
        return this.selection.size
    }

    /** Erase the selected strokes. False when there are none, or it was refused. */
    deleteSelection(): boolean {
        if (this.selection.size === 0) return false
        const ids = new Set(this.selection)
        this.awaiting.erased = ids
        const done = this.host.erase(ids)
        if (!done) delete this.awaiting.erased
        this.selection.clear()
        this.host.selectionChanged(0)
        this.requestDraw()
        return done
    }

    /** Let go of the selection. False when there was none. */
    clearSelection(): boolean {
        const had = this.selection.size > 0 || this.gesture?.kind === 'lasso'
        if (this.gesture?.kind === 'lasso' || this.gesture?.kind === 'move') this.gesture = null
        this.selection.clear()
        this.host.selectionChanged(0)
        this.requestDraw()
        return had
    }

    /** Write what is being drawn now: the stroke, erase or move under a pointer still down. */
    flush(): void {
        if (this.gesture && this.gesture.kind !== 'pinch' && this.gesture.kind !== 'pan') this.finish(this.gesture)
        this.gesture = null
    }

    destroy(): void {
        cancelAnimationFrame(this.frame)
        this.resize.disconnect()
        this.canvas.removeEventListener('pointerdown', this.onPointerDown)
        this.canvas.removeEventListener('pointermove', this.onPointerMove)
        this.canvas.removeEventListener('pointerup', this.onPointerUp)
        this.canvas.removeEventListener('pointercancel', this.onPointerCancel)
        this.canvas.removeEventListener('pointerleave', this.onPointerLeave)
        this.canvas.removeEventListener('wheel', this.onWheel)
        this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    }

    private setCamera(camera: Camera): void {
        this.camera = camera
        this.host.cameraChanged(camera)
        this.requestDraw()
    }

    private measure(): void {
        const rect = this.canvas.getBoundingClientRect()
        const ratio = window.devicePixelRatio || 1
        if (rect.width === this.width && rect.height === this.height && ratio === this.ratio) return
        this.width = rect.width
        this.height = rect.height
        this.ratio = ratio
        this.canvas.width = Math.max(1, Math.round(rect.width * ratio))
        this.canvas.height = Math.max(1, Math.round(rect.height * ratio))
        if (!this.used && this.drawing && this.width > 0) this.fitView()
        this.draw()
    }

    private screenPoint(event: PointerEvent | WheelEvent): Point {
        const rect = this.canvas.getBoundingClientRect()
        return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }

    private worldPoint(event: PointerEvent): Point {
        return screenToWorld(this.camera, this.screenPoint(event))
    }

    private onPointerDown = (event: PointerEvent): void => {
        if (event.pointerType === 'pen') this.penSeen = true
        if (event.pointerType === 'touch') this.touches.set(event.pointerId, this.screenPoint(event))
        const intent = pointerIntent({
            pointerType: event.pointerType,
            button: event.button,
            buttons: event.buttons,
            spaceHeld: this.spaceHeld,
            penSeen: this.penSeen,
            otherTouches: event.pointerType === 'touch' ? this.touches.size - 1 : 0,
            writable: this.host.writable(),
            tool: this.host.tool(),
        })
        if (intent === 'ignore') return
        this.used = true
        event.preventDefault()
        this.canvas.focus({ preventScroll: true })
        if (intent === 'pinch') {
            this.startPinch()
            return
        }
        // One gesture at a time: a second pointer that is not a pinch waits.
        if (this.gesture) return
        try {
            this.canvas.setPointerCapture(event.pointerId)
        } catch {
            // A pointer the browser does not know (a synthetic one) cannot be captured.
        }
        const base = { pointerId: event.pointerId, pointerType: event.pointerType }
        const world = this.worldPoint(event)
        if (intent === 'pan') {
            this.gesture = { ...base, kind: 'pan', last: this.screenPoint(event) }
            this.setGrabbing(true)
        }
        else if (intent === 'erase') {
            this.gesture = { ...base, kind: 'erase', last: world, ids: new Set() }
            this.eraseAlong(this.gesture, world)
        } else if (intent === 'lasso') {
            const selected = this.selectionBounds()
            if (selected && containsPoint(padded(selected, ERASER_RADIUS / this.camera.zoom), world)) this.gesture = { ...base, kind: 'move', start: world, dx: 0, dy: 0 }
            else {
                this.clearSelection()
                this.gesture = { ...base, kind: 'lasso', polygon: [world] }
            }
        } else {
            const tool = this.host.tool() === 'highlighter' ? 'highlighter' : 'pen'
            const brush = this.host.brush(tool)
            this.gesture = { ...base, kind: 'stroke', stroke: { id: newStrokeId(), tool, colour: brush.colour, size: brush.size, pts: [] }, trail: newTrail() }
            this.addSamples(this.gesture, [event])
        }
        this.requestDraw()
    }

    private onPointerMove = (event: PointerEvent): void => {
        if (event.pointerType === 'pen') this.penSeen = true
        if (this.touches.has(event.pointerId)) this.touches.set(event.pointerId, this.screenPoint(event))
        const gesture = this.gesture
        if (!gesture) {
            this.hover = event.pointerType === 'touch' ? null : this.worldPoint(event)
            if (this.host.tool() === 'eraser') this.requestDraw()
            return
        }
        if (gesture.kind === 'pinch') {
            if (gesture.ids.includes(event.pointerId)) this.movePinch(gesture)
            return
        }
        if (gesture.pointerId !== event.pointerId) return
        // Every point the pointer passed through since the last event, where the browser keeps them.
        const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : []
        const events = coalesced.length > 0 ? coalesced : [event]
        if (gesture.kind === 'stroke') this.addSamples(gesture, events)
        else if (gesture.kind === 'erase') for (const one of events) this.eraseAlong(gesture, this.worldPoint(one))
        else if (gesture.kind === 'lasso') gesture.polygon.push(this.worldPoint(event))
        else if (gesture.kind === 'move') {
            const world = this.worldPoint(event)
            gesture.dx = world.x - gesture.start.x
            gesture.dy = world.y - gesture.start.y
        } else {
            const point = this.screenPoint(event)
            this.setCamera(panBy(this.camera, point.x - gesture.last.x, point.y - gesture.last.y))
            gesture.last = point
        }
        this.hover = gesture.kind === 'erase' ? this.worldPoint(event) : null
        this.requestDraw()
    }

    private onPointerUp = (event: PointerEvent): void => {
        this.end(event, true)
    }

    private onPointerCancel = (event: PointerEvent): void => {
        this.end(event, false)
    }

    private onPointerLeave = (): void => {
        if (this.hover && !this.gesture) {
            this.hover = null
            this.requestDraw()
        }
    }

    private end(event: PointerEvent, commit: boolean): void {
        this.touches.delete(event.pointerId)
        const gesture = this.gesture
        if (!gesture) return
        if (gesture.kind === 'pinch') {
            if (gesture.ids.includes(event.pointerId)) this.gesture = null
            return
        }
        if (gesture.pointerId !== event.pointerId) return
        this.gesture = null
        this.setGrabbing(false)
        if (commit && gesture.kind !== 'pan') this.finish(gesture)
        this.requestDraw()
    }

    /** Two fingers: whatever the first one started is let go, and they pan and zoom together. */
    private startPinch(): void {
        const [a, b] = [...this.touches.keys()]
        if (a === undefined || b === undefined) return
        const gesture = this.gesture
        // The first finger was drawing, erasing or lassoing: it was the start of a pinch, not a mark.
        if (gesture && gesture.kind !== 'pinch' && gesture.pointerType !== 'touch') return
        const pa = this.touches.get(a)!
        const pb = this.touches.get(b)!
        this.gesture = { kind: 'pinch', ids: [a, b], mid: midpoint(pa, pb), distance: Math.max(1, Math.hypot(pa.x - pb.x, pa.y - pb.y)) }
        this.requestDraw()
    }

    private movePinch(gesture: Extract<Gesture, { kind: 'pinch' }>): void {
        const pa = this.touches.get(gesture.ids[0])
        const pb = this.touches.get(gesture.ids[1])
        if (!pa || !pb) return
        const mid = midpoint(pa, pb)
        const distance = Math.max(1, Math.hypot(pa.x - pb.x, pa.y - pb.y))
        this.setCamera(zoomAbout(panBy(this.camera, mid.x - gesture.mid.x, mid.y - gesture.mid.y), mid, distance / gesture.distance))
        gesture.mid = mid
        gesture.distance = distance
    }

    private onWheel = (event: WheelEvent): void => {
        event.preventDefault()
        this.used = true
        // Lines and pages are turned into pixels, as a browser scrolling the page would.
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.height : 1
        if (event.ctrlKey || event.metaKey) {
            // A trackpad's pinch arrives as Ctrl+wheel.
            this.setCamera(zoomAbout(this.camera, this.screenPoint(event), Math.exp((-event.deltaY * unit) / 200)))
            return
        }
        const dx = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX
        const dy = event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY
        this.setCamera(panBy(this.camera, -dx * unit, -dy * unit))
    }

    private onContextMenu = (event: Event): void => {
        event.preventDefault()
    }

    /** The positions an event brings to the stroke being drawn, less any the browser repeats (`takeSamples`). */
    private addSamples(gesture: Extract<Gesture, { kind: 'stroke' }>, events: readonly PointerEvent[]): void {
        const rect = this.canvas.getBoundingClientRect()
        const samples = events.map((e): PointerSample => ({ x: e.clientX, y: e.clientY, pressure: pointPressure(e.pointerType, e.pressure), time: e.timeStamp }))
        const pts = gesture.stroke.pts
        for (const sample of takeSamples(gesture.trail, samples)) {
            const world = screenToWorld(this.camera, { x: sample.x - rect.left, y: sample.y - rect.top })
            const n = pts.length
            // A point on top of the last adds nothing but weight.
            if (n >= 3 && Math.hypot(world.x - pts[n - 3], world.y - pts[n - 2]) < 0.25 / this.camera.zoom) continue
            pts.push(world.x, world.y, sample.pressure)
        }
    }

    private eraseAlong(gesture: Extract<Gesture, { kind: 'erase' }>, to: Point): void {
        const radius = ERASER_RADIUS / this.camera.zoom
        for (const { stroke } of this.drawing?.strokes ?? []) {
            if (!gesture.ids.has(stroke.id) && eraserTouches(stroke, gesture.last, to, radius)) gesture.ids.add(stroke.id)
        }
        gesture.last = to
    }

    private finish(gesture: Exclude<Gesture, { kind: 'pinch' } | { kind: 'pan' }>): void {
        if (gesture.kind === 'stroke') {
            if (gesture.stroke.pts.length === 0) return
            const stroke = { ...gesture.stroke, pts: simplifiedPoints(gesture.stroke.pts) }
            this.awaiting.stroke = stroke
            if (!this.host.addStroke(stroke) && this.awaiting.stroke === stroke) delete this.awaiting.stroke
        } else if (gesture.kind === 'erase') {
            if (gesture.ids.size === 0) return
            this.awaiting.erased = gesture.ids
            if (!this.host.erase(gesture.ids)) delete this.awaiting.erased
        } else if (gesture.kind === 'lasso') {
            const polygon = gesture.polygon
            this.selection = new Set((this.drawing?.strokes ?? []).filter((s) => lassoTakes(s.stroke, polygon)).map((s) => s.stroke.id))
            this.host.selectionChanged(this.selection.size)
        } else if (gesture.dx !== 0 || gesture.dy !== 0) {
            const moved = { ids: new Set(this.selection), dx: gesture.dx, dy: gesture.dy }
            this.awaiting.moved = moved
            if (!this.host.move(moved.ids, moved.dx, moved.dy)) delete this.awaiting.moved
        }
        this.requestDraw()
    }

    /** How far the selected strokes reach, moved as they are being dragged. */
    private selectionBounds(): Bounds | null {
        if (this.selection.size === 0) return null
        const bounds = unionBounds([...this.cache.values()].filter((c) => this.selection.has(c.stroke.id)).map((c) => c.bounds))
        if (!bounds) return null
        const { dx, dy } = this.offset()
        return { minX: bounds.minX + dx, minY: bounds.minY + dy, maxX: bounds.maxX + dx, maxY: bounds.maxY + dy }
    }

    /** How far the selected strokes are drawn from where the body has them. */
    private offset(): { dx: number; dy: number } {
        if (this.gesture?.kind === 'move') return { dx: this.gesture.dx, dy: this.gesture.dy }
        if (this.awaiting.moved) return { dx: this.awaiting.moved.dx, dy: this.awaiting.moved.dy }
        return { dx: 0, dy: 0 }
    }

    private requestDraw(): void {
        if (this.frame) return
        this.frame = requestAnimationFrame(() => {
            this.frame = 0
            this.draw()
        })
    }

    private draw(): void {
        const ctx = this.context
        if (!ctx || this.width === 0) return
        const { zoom, x, y } = this.camera
        ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0)
        ctx.globalAlpha = 1
        ctx.fillStyle = PAPER_COLOUR
        ctx.fillRect(0, 0, this.width, this.height)
        ctx.setTransform(this.ratio * zoom, 0, 0, this.ratio * zoom, -x * zoom * this.ratio, -y * zoom * this.ratio)
        const view = visibleBounds(this.camera, this.width, this.height)
        this.drawPaper(ctx, view)
        this.drawStrokes(ctx, view)
        this.drawOverlays(ctx)
    }

    private drawPaper(ctx: CanvasRenderingContext2D, view: Bounds): void {
        const paper: InkPaper = this.drawing?.header.paper ?? 'plain'
        if (paper === 'plain') return
        const spacing = paper === 'dots' ? DOT_SPACING : LINE_SPACING
        if (spacing * this.camera.zoom < MIN_MARK_SPACING) return
        const startX = Math.floor(view.minX / spacing) * spacing
        const startY = Math.floor(view.minY / spacing) * spacing
        if (paper === 'lines') {
            ctx.fillStyle = LINE_COLOUR
            for (let ly = startY; ly <= view.maxY; ly += spacing) ctx.fillRect(view.minX, ly, view.maxX - view.minX, 1)
            return
        }
        ctx.fillStyle = DOT_COLOUR
        ctx.beginPath()
        for (let dy = startY; dy <= view.maxY; dy += spacing) {
            for (let dx = startX; dx <= view.maxX; dx += spacing) {
                ctx.moveTo(dx + DOT_RADIUS, dy)
                ctx.arc(dx, dy, DOT_RADIUS, 0, Math.PI * 2)
            }
        }
        ctx.fill()
    }

    private drawStrokes(ctx: CanvasRenderingContext2D, view: Bounds): void {
        const erasing = this.gesture?.kind === 'erase' ? this.gesture.ids : null
        const erased = this.awaiting.erased
        const { dx, dy } = this.offset()
        const moving = dx !== 0 || dy !== 0
        const visible = (b: Bounds, shift: boolean) => {
            const ox = shift ? dx : 0
            const oy = shift ? dy : 0
            return b.maxX + ox >= view.minX && b.minX + ox <= view.maxX && b.maxY + oy >= view.minY && b.minY + oy <= view.maxY
        }
        // Highlighters beneath the pens, so a pen's line stays dark where a highlighter crosses it.
        for (const tool of ['highlighter', 'pen'] as const) {
            ctx.globalAlpha = tool === 'highlighter' ? HIGHLIGHTER_OPACITY : 1
            for (const { text } of this.drawing?.strokes ?? []) {
                const cached = this.cache.get(text)
                if (!cached || cached.stroke.tool !== tool) continue
                const id = cached.stroke.id
                if (erasing?.has(id) || erased?.has(id)) continue
                const shift = moving && this.selection.has(id)
                if (!visible(cached.bounds, shift)) continue
                ctx.fillStyle = cached.stroke.colour
                if (shift) {
                    ctx.save()
                    ctx.translate(dx, dy)
                    ctx.fill(cached.path)
                    ctx.restore()
                } else ctx.fill(cached.path)
            }
            const pending = [this.awaiting.stroke, this.gesture?.kind === 'stroke' ? this.gesture.stroke : undefined]
            for (const stroke of pending) {
                if (!stroke || stroke.tool !== tool || stroke.pts.length === 0) continue
                ctx.fillStyle = stroke.colour
                // Outlined as a finished stroke, as it will be once written, so it keeps its shape when the pen lifts.
                ctx.fill(new Path2D(strokePath(stroke)))
            }
        }
        ctx.globalAlpha = 1
    }

    private drawOverlays(ctx: CanvasRenderingContext2D): void {
        const pixel = 1 / this.camera.zoom
        ctx.lineWidth = pixel
        ctx.strokeStyle = SELECTION_COLOUR
        if (this.gesture?.kind === 'lasso' && this.gesture.polygon.length > 1) {
            ctx.setLineDash([4 * pixel, 4 * pixel])
            ctx.beginPath()
            this.gesture.polygon.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
            ctx.closePath()
            ctx.stroke()
        }
        const selected = this.selectionBounds()
        if (selected) {
            const box = padded(selected, 4 * pixel)
            ctx.setLineDash([6 * pixel, 4 * pixel])
            ctx.strokeRect(box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY)
        }
        ctx.setLineDash([])
        const erasing = this.gesture?.kind === 'erase' || (!this.gesture && this.host.tool() === 'eraser')
        if (this.hover && erasing) {
            ctx.strokeStyle = '#6b7280'
            ctx.beginPath()
            ctx.arc(this.hover.x, this.hover.y, ERASER_RADIUS * pixel, 0, Math.PI * 2)
            ctx.stroke()
        }
    }
}
