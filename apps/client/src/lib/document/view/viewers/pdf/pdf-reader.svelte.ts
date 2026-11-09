/**
 * One PDF tab's reader: pdf.js's viewer, what the toolbar shows, and everything a person does to the
 * PDF. A class of `$state` fields, so the components stay about presentation and this stays
 * about behaviour. pdf.js owns the pages; {@link PdfOverlays} draws what a person put on them.
 */
import { contentMargins, cropFromSamples, pageFitsCrop, samplePages, type DocumentCrop, type Margins } from '#lib/document/pdf/crop-margins.js'
import { DEFAULT_CUSTOM, DEFAULT_HIGHLIGHT, DEFAULT_INK, knownColour, knownStrokeWidth, type DrawingTool } from '#lib/document/pdf/annotation-palette.js'
import type { FileSelection } from '#lib/document/file-in-front.js'
import { pdfDeviceMemory, type PdfPreferences } from '#lib/document/pdf/device-memory.js'
import type { PdfOpenedFrom } from '#lib/document/pdf/page-requests.js'
import { boxesToQuads, mergeLineBoxes, type Box } from '#lib/document/pdf/pdf-geometry.js'
import { addPdfBookmark, adoptPdfTarget, removePdfBookmark, subscribePdfBookmarks, type PdfBookmark } from '#lib/document/pdf/pdf-bookmarks.js'
import { newPdfStateId, type FormValue, type PdfAnnotation, type PdfHighlight, type PdfNote, type PdfStateStore } from '#lib/document/pdf/pdf-state.js'
import { SAVE_ENTRY_PREFIX } from '#lib/document/pdf/save-entries.js'

import { loadPdfLibrary, openPdf, pdfHash, type PdfDocument, type PdfLib, type PdfLoadingTask, type PdfWeb } from './pdf-library'
import { pdfL10n } from './pdf-l10n'
import { listenForPinch, wheelZoomFactor } from './pdf-pinch'
import { listenForTextDrag } from './pdf-text-drag'
import { dropSignatures, heldSignatures, holdSignatures, signaturesKey, type HeldSignatures } from './held-signatures.svelte'
import { listenForHandPan } from './pdf-hand-pan'
import { HidingControls } from './pdf-hiding-controls'
import { frameOf, PdfOverlays, type OverlayHost, type OverlayPage, type PdfTool, type PlacedSignature } from './pdf-overlay'
import { printPdf } from './pdf-print'
import { browserKeepScreenOn, type KeepScreenOn } from './wake-lock'

export type ReaderStatus = 'opening' | 'password' | 'ready' | 'error'


const NOTE_FONT_SIZE = 11
const UNDO_DEPTH = 100
const PLACE_WRITE_DELAY_MS = 1500
const DARK_PAGES = { background: '#171717', foreground: '#e5e5e5' }
/** How close together two taps must land, in time and on screen, to be a double-tap. */
const DOUBLE_TAP_MS = 320
const DOUBLE_TAP_PX = 32
/** A touch moved further than this is a scroll, not a tap. */
const TAP_SLOP_PX = 10
const SWIPE_PX = 48
/** How much of the view's width, from each side, turns the page at a tap. */
export const EDGE_TAP_SHARE = 0.22
/** How long the floating page count stays once the page in view changes, where it is the only one. */
const PAGE_COUNT_MS = 5000
/** Something on the page that answers a tap for itself. */
const ANSWERS_A_TAP = 'a, button, input, select, textarea, .etherpk-pdf-note, .etherpk-pdf-signature'

const boxesOverlap = (a: DOMRect, b: DOMRect): boolean => a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right

interface UndoStep {
    label: string
    /** The page it changes, brought into view first so that the change can be seen. */
    page: number
    undo(): void
    redo(): void
}

export interface ReaderEnvironment {
    graphId: string
    /** The Asset's identity, which keys its tab. */
    target(): string
    /** Its file name as it stands, which a rename changes. */
    name(): string
    /** Opens this PDF's own state. Null when the graph keeps none. */
    openState(hash: string): Promise<PdfStateStore>
}

export interface FindResult {
    current: number
    total: number
    /** `pending` while pages are still being read. */
    state: 'idle' | 'pending' | 'found' | 'not-found' | 'no-text'
}

/** A phone, held either way up. */
function isPhone(): boolean {
    return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px), (max-height: 640px) and (pointer: coarse)').matches
}

/** A phone in a person's hand, upright or sideways. A window that narrow with a mouse has no tap to answer. */
export const TOUCH_PHONE = '(pointer: coarse) and (max-width: 640px), (pointer: coarse) and (max-height: 640px)'

export function isTouchFirst(): boolean {
    return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
}

export class PdfReader {
    status = $state<ReaderStatus>('opening')
    errorMessage = $state('')
    passwordWrong = $state(false)
    /** The password prompt's own "remove it" tick was on when the PDF unlocked. */
    removePasswordAsked = $state(false)
    protectedByPassword = $state(false)

    page = $state(1)
    pageCount = $state(0)
    /** The zoom as the toolbar shows it: 1 is 100%. */
    scale = $state(1)

    preferences = $state<PdfPreferences>(pdfDeviceMemory().preferences())
    cropOn = $state(false)
    cropBusy = $state(false)

    findOpen = $state(false)
    findQuery = $state('')
    find = $state<FindResult>({ current: 0, total: 0, state: 'idle' })

    tool = $state<PdfTool>('none')
    /** On a phone a finger is all a person has to draw with. A tablet keeps it for scrolling, for a stylus. */
    private readonly fingerDrawsByDefault = isPhone()
    /** The page in view has been read and holds no text to select, as a scan without a text layer does. */
    pageWithoutText = $state(false)
    /** Whether the tool's colours and thicknesses are out over the page, or tucked to its right edge. */
    toolOptionsOpen = $state(false)
    /** The reference that opened this PDF, which a saved copy's link can follow. */
    openedFrom = $state.raw<PdfOpenedFrom | null>(null)
    /** Text is selected in the PDF, so the Highlight action can apply to it. */
    hasSelection = $state(false)

    annotations = $state.raw<PdfAnnotation[]>([])
    bookmarks = $state.raw<PdfBookmark[]>([])
    stateProblem = $state<string | null>(null)
    canUndo = $state(false)
    canRedo = $state(false)

    /** The note open for editing: where it is, and what it says. */
    noteEditor = $state<{ id: string | null; page: number; x: number; y: number; text: string } | null>(null)

    /** The phone's top bar and the page buttons are out of sight for now. */
    controlsHidden = $state(false)
    readonly controls = new HidingControls(
        (hidden) => (this.controlsHidden = hidden),
        () => !!document.activeElement?.matches('input, select, textarea') && !!this.container?.contains(document.activeElement),
    )
    /** The floating page count is up. Only where the toolbar is on the Command Bar does it ever go. */
    pageCountShowing = $state(false)
    /** The side a tap has just turned the page from. A new object for each tap, so each one flashes. */
    turnFlash = $state.raw<{ side: 'previous' | 'next' } | null>(null)
    printing = $state<{ done: number; total: number } | null>(null)
    printError = $state<string | null>(null)

    hash = $state<string | null>(null)
    bytes: Uint8Array<ArrayBuffer> | null = null
    pdf = $state.raw<PdfDocument | null>(null)
    currentPassword: string | null = null

    private lib: PdfLib | null = null
    private web: PdfWeb | null = null
    private task: PdfLoadingTask | null = null
    private viewer: InstanceType<PdfWeb['PDFViewer']> | null = null
    private eventBus: InstanceType<PdfWeb['EventBus']> | null = null
    private linkService: InstanceType<PdfWeb['PDFLinkService']> | null = null
    private container: HTMLDivElement | null = null
    private viewerElement: HTMLDivElement | null = null
    private passwordAnswer: ((password: string) => void) | null = null
    private overlays: PdfOverlays
    private store: PdfStateStore | null = null
    private stopStore: (() => void) | null = null
    private stopBookmarks: (() => void) | null = null
    private undoStack: UndoStep[] = []
    private redoStack: UndoStep[] = []
    private crop: DocumentCrop | null = null
    private uncroppedPages = new Set<number>()
    private keepScreen: KeepScreenOn | null = null
    private controller = new AbortController()
    private placeTimer: ReturnType<typeof setTimeout> | undefined
    private pendingPlace: { page: number; offset: number } | null = null
    private restored = false
    private linkedPage: number | null = null
    private heldScale: string | null = null
    private lastTap: { at: number; x: number; y: number } | null = null
    private destroyed = false
    private singleTapTimer: ReturnType<typeof setTimeout> | undefined
    private readonly memory = pdfDeviceMemory()

    constructor(private readonly environment: ReaderEnvironment) {
        const host: OverlayHost = {
            tool: () => this.tool,
            fingerDraws: () => this.fingerDraws,
            annotationsOn: (page) => this.annotations.filter((a) => a.page === page),
            isBookmarked: (page) => this.bookmarks.some((mark) => mark.page === page),
            signaturesOn: (page) => this.signatures.filter((s) => s.page === page),
            strokeDone: (page, tool, points, pressures) => this.addStroke(page, tool, points, pressures),
            usesPressure: () => this.preferences.penPressure,
            strokeWidth: (tool) => this.strokeWidth(tool),
            strokeColour: (tool) => (tool === 'pen' ? this.inkColour : this.highlightColour),
            erase: (id) => this.removeAnnotation(id, 'Erase'),
            placeNote: (page, x, y) => (this.noteEditor = { id: null, page, x, y, text: '' }),
            openNote: (id) => this.openNote(id),
            moveSignature: (id, change) => this.moveSignature(id, change),
            removeSignature: (id) => this.removeSignature(id),
        }
        this.overlays = new PdfOverlays(host)
    }

    /** Fetch the bytes from the asset's object URL and open them. */
    async open(url: string): Promise<void> {
        try {
            const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
            this.bytes = bytes
            this.hash = await pdfHash(bytes)
            this.lib = (await loadPdfLibrary()).lib
            this.web = (await loadPdfLibrary()).web
            this.task = await openPdf(bytes, (answer, wrong) => {
                this.passwordAnswer = answer
                this.passwordWrong = wrong
                this.protectedByPassword = true
                this.status = 'password'
            })
            const pdf = await this.task.promise
            if (this.destroyed) {
                void this.task.destroy()
                return
            }
            this.pdf = pdf
            this.pageCount = pdf.numPages
            await this.openState()
            this.status = 'ready'
        } catch (error) {
            if (!this.destroyed) {
                this.errorMessage = 'This file could not be opened as a PDF.'
                this.status = 'error'
                console.warn('[pdf] open failed', error)
            }
        }
    }

    /** The person answered the password prompt. */
    submitPassword(password: string, removeIt: boolean): void {
        this.currentPassword = password
        this.removePasswordAsked = removeIt
        this.status = 'opening'
        this.passwordAnswer?.(password)
    }

    private async openState(): Promise<void> {
        if (!this.hash) return
        const store = await this.environment.openState(this.hash)
        if (this.destroyed) {
            void store.close()
            return
        }
        this.store = store
        const apply = () => {
            const state = store.state()
            this.annotations = state.annotations
            this.stateProblem = store.problem()
            this.overlays.refresh()
        }
        apply()
        this.stopStore = store.subscribe(apply)
        // The person's list across every PDF: this tab shows the ones on these bytes, and puts their
        // tab and name right, since an Export, an Import or a rename can have moved them.
        this.stopBookmarks = subscribePdfBookmarks((all) => {
            this.bookmarks = all.filter((b) => b.hash === this.hash).toSorted((a, b) => a.page - b.page)
            this.overlays.refresh()
        })
        if (this.hash) void adoptPdfTarget(this.hash, this.environment.target(), this.environment.name()).catch(() => {})
        this.restoreForms(store.state().forms)
    }

    /**
     * Form values come back before any page renders, and each later change is heard here. pdf.js's
     * storage has no change event for a field, and widgets write straight to `setValue`.
     */
    private restoreForms(forms: Record<string, FormValue>): void {
        if (!this.pdf) return
        const storage = this.pdf.annotationStorage
        const setValue = storage.setValue.bind(storage)
        for (const [id, value] of Object.entries(forms)) setValue(id, value)
        storage.setValue = (key: string, value: Record<string, unknown>) => {
            setValue(key, value)
            if (!key.startsWith(SAVE_ENTRY_PREFIX)) this.store?.setFormValue(key, storage.getRawValue(key) as FormValue)
        }
    }

    /** Whether the person has filled in any field. */
    hasFormValues(): boolean {
        return Object.keys(this.store?.state().forms ?? {}).length > 0
    }

    /** Start the viewer on the elements the component made. */
    mount(container: HTMLDivElement, viewerElement: HTMLDivElement): void {
        this.container = container
        this.viewerElement = viewerElement
        try {
            this.startViewer()
        } catch (error) {
            // A throw from here would take the whole workspace with it, for one tab's PDF.
            this.errorMessage = 'This PDF could not be shown.'
            this.status = 'error'
            console.warn('[pdf] the viewer did not start', error)
            return
        }
        this.listenForGestures(container)
        this.keepScreen = browserKeepScreenOn()
        this.keepScreen.setEnabled(isTouchFirst() && this.preferences.keepScreenOn)
    }

    private startViewer(): void {
        const { web, lib, pdf, container, viewerElement } = this
        if (!web || !lib || !pdf || !container || !viewerElement) return
        const eventBus = new web.EventBus()
        const linkService = new web.PDFLinkService({ eventBus, externalLinkTarget: web.LinkTarget.BLANK, externalLinkRel: 'noopener noreferrer nofollow' })
        const findController = new web.PDFFindController({ eventBus, linkService })
        const viewer = new web.PDFViewer({
            container,
            viewer: viewerElement,
            eventBus,
            linkService,
            findController,
            l10n: pdfL10n as never,
            annotationMode: lib.AnnotationMode.ENABLE_FORMS,
            // EtherPK draws annotations itself (pdf-overlay.ts), so pdf.js's editor stays off.
            annotationEditorMode: lib.AnnotationEditorType.DISABLE,
            pageColors: this.preferences.darkPages ? DARK_PAGES : null,
            supportsPinchToZoom: false,
            // A page's box is then exactly the page, which the overlay and the crop both measure from.
            removePageBorders: true,
        } as ConstructorParameters<PdfWeb['PDFViewer']>[0])
        linkService.setViewer(viewer)
        this.viewer = viewer
        this.eventBus = eventBus
        this.linkService = linkService
        this.listenToViewer(eventBus)
        viewer.setDocument(pdf)
        linkService.setDocument(pdf, null)
    }

    private listenToViewer(eventBus: InstanceType<PdfWeb['EventBus']>): void {
        eventBus.on('pagesinit', () => this.onPagesInit())
        eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
            this.page = pageNumber
            this.showPageCount()
            void this.readPageText(pageNumber)
        })
        eventBus.on('scalechanging', ({ scale }: { scale: number }) => {
            this.scale = scale
            this.applyCropToPages()
        })
        eventBus.on('updateviewarea', ({ location }: { location: { pageNumber: number; top: number } }) => this.onViewArea(location))
        eventBus.on('pagerendered', ({ source }: { source: OverlayPage }) => this.onPageRendered(source))
        eventBus.on('updatefindmatchescount', ({ matchesCount }: { matchesCount: { current: number; total: number } }) => {
            this.find = { ...this.find, current: matchesCount.current, total: matchesCount.total }
        })
        eventBus.on('updatefindcontrolstate', (event: { state: number; matchesCount: { current: number; total: number } }) => {
            void this.onFindState(event)
        })
    }

    private onPagesInit(): void {
        const viewer = this.viewer
        if (!viewer || !this.hash) return
        // Here, not as the viewer starts: it has no pages to show one of until now, and it goes back to
        // scrolling each time it is given the document again.
        if (this.preferences.pageByPage && this.web) viewer.scrollMode = this.web.ScrollMode.PAGE
        this.showPageCount()
        void this.readPageText(this.page)
        const remembered = this.memory.pdf(this.environment.graphId, this.hash)
        // A link clicked while the file was still loading is newer than the one remembered.
        if (this.openedFrom) this.memory.updatePdf(this.environment.graphId, this.hash, { openedFrom: this.openedFrom })
        else this.openedFrom = remembered.openedFrom ?? null
        viewer.currentScaleValue = this.heldScale ?? (remembered.zoom ? String(remembered.zoom) : 'auto')
        this.heldScale = null
        this.scale = viewer.currentScale
        if (remembered.crop) void this.setCrop(true)
        this.restorePlace()
    }

    /** Back to where the person had reached, unless a link named a page of its own. */
    private restorePlace(): void {
        const place = this.store?.state().place
        const viewer = this.viewer
        this.restored = true
        if (this.linkedPage !== null) {
            this.goToPage(this.linkedPage)
            this.linkedPage = null
            return
        }
        if (!place || !viewer) return
        void this.scrollToPlace(place.page, place.offset)
    }

    private async scrollToPlace(pageNumber: number, offset: number): Promise<void> {
        const { viewer, pdf } = this
        if (!viewer || !pdf || pageNumber > pdf.numPages) return
        const page = await pdf.getPage(pageNumber)
        const [, y1, , y2] = page.view
        const top = y2 - (y2 - y1) * offset
        viewer.scrollPageIntoView({ pageNumber, destArray: [null, { name: 'XYZ' }, null, top, null] })
    }

    /** Remember the place, a moment after the scrolling stops. */
    private onViewArea(location: { pageNumber: number; top: number }): void {
        if (!this.restored || !this.pdf) return
        const { pageNumber, top } = location
        const view = this.viewer?.getPageView(pageNumber - 1)?.pdfPage?.view as number[] | undefined
        const height = view ? view[3] - view[1] : 0
        const offset = height > 0 ? Math.min(1, Math.max(0, (view![3] - top) / height)) : 0
        this.pendingPlace = { page: pageNumber, offset }
        clearTimeout(this.placeTimer)
        this.placeTimer = setTimeout(() => this.writePlace(), PLACE_WRITE_DELAY_MS)
    }

    private writePlace(): void {
        if (this.pendingPlace) this.store?.setPlace({ ...this.pendingPlace, at: Date.now() })
        this.pendingPlace = null
    }

    private onPageRendered(page: OverlayPage): void {
        this.overlays.attach(page)
        this.applyCropToPage(page)
        if (this.crop) void this.checkPageAgainstCrop(page)
    }

    // ---- Moving around ----

    goToPage(pageNumber: number): void {
        if (!this.viewer) return
        const clamped = Math.min(this.pageCount, Math.max(1, Math.round(pageNumber)))
        this.viewer.currentPageNumber = clamped
        this.alignTurnedPage()
    }

    /** Open a page named by a link, such as `#page=12`. Held until the pages exist. */
    openPageFromLink(pageNumber: number): void {
        if (this.restored) this.goToPage(pageNumber)
        else this.linkedPage = pageNumber
    }

    /** False when there is no page to go to. */
    nextPage(): boolean {
        const turned = this.viewer?.nextPage() ?? false
        if (turned) this.alignTurnedPage()
        return turned
    }

    /** False when there is no page to go to. */
    previousPage(): boolean {
        const turned = this.viewer?.previousPage() ?? false
        if (turned) this.alignTurnedPage()
        return turned
    }

    /**
     * Page by page, a page arrives at its top with its middle in the middle of the view. pdf.js would
     * put a page wider than the view at its top left, which shows the margin and half a line.
     */
    private alignTurnedPage(): void {
        const container = this.container
        if (!container || !this.preferences.pageByPage) return
        container.scrollTo({ left: (container.scrollWidth - container.clientWidth) / 2, top: 0 })
    }

    private rememberZoom(): void {
        if (!this.viewer || !this.hash) return
        this.memory.updatePdf(this.environment.graphId, this.hash, { zoom: this.viewer.currentScale })
    }

    /**
     * A point in the view as `updateScale` takes it. It measures an origin from the scroller's offset in
     * its positioned parent, not from the window's edge, so a point on the screen has to be moved there.
     */
    private zoomOrigin(clientX: number, clientY: number): [number, number] | undefined {
        const container = this.container
        if (!container) return undefined
        const box = container.getBoundingClientRect()
        return [clientX - box.left + container.offsetLeft, clientY - box.top + container.offsetTop]
    }

    /** The middle of the view, which every zoom but a pinch holds still: moving the page is left to the person. */
    private viewMiddle(): [number, number] | undefined {
        const box = this.container?.getBoundingClientRect()
        return box ? this.zoomOrigin(box.left + box.width / 2, box.top + box.height / 2) : undefined
    }

    zoomIn(): void {
        this.viewer?.increaseScale({ origin: this.viewMiddle() })
        this.rememberZoom()
    }

    zoomOut(): void {
        this.viewer?.decreaseScale({ origin: this.viewMiddle() })
        this.rememberZoom()
    }

    fitWidth(): void {
        if (!this.viewer) return
        if (this.crop) this.applyCropScale()
        else this.viewer.currentScaleValue = 'page-width'
        this.rememberZoom()
    }

    // ---- Gestures ----

    private listenForGestures(container: HTMLDivElement): void {
        const signal = this.controller.signal
        listenForPinch(
            container,
            {
                onStart: () => this.overlays.cancelStroke(),
                onPinch: (origin, scaleFactor) => {
                    this.viewer?.updateScale({ drawingDelay: 400, scaleFactor, origin: this.zoomOrigin(origin[0], origin[1]) })
                },
                onPan: (dx, dy) => container.scrollBy(-dx, -dy),
                onEnd: () => this.rememberZoom(),
            },
            signal,
        )
        listenForTextDrag(
            container,
            {
                takes: (type) => this.tool === 'select' || (this.tool === 'highlight' && (type === 'pen' || this.fingerDraws)),
                done: () => {
                    if (this.tool === 'highlight') this.highlightSelection()
                },
            },
            signal,
        )
        // The tab changed size (a panel opened, the phone turned): a crop fits its width again.
        const resized = new ResizeObserver(() => {
            if (this.crop) this.applyCropScale()
        })
        resized.observe(container)
        signal.addEventListener('abort', () => resized.disconnect())
        // The whole tab, toolbar too: with the pointer anywhere in it the browser would scale the app.
        // On the window, ahead of everything, because a browser that has decided no listener wants a
        // wheel event sends it uncancelable, and then nothing can stop its zoom.
        const tab = container.closest<HTMLElement>('.etherpk-pdf-reader') ?? container
        window.addEventListener('wheel', (event) => event.composedPath().includes(tab) && this.onWheel(event), { passive: false, capture: true, signal })
        // Safari's own page zoom, for the same reason.
        tab.addEventListener('gesturestart', (event) => event.preventDefault(), { signal })
        listenForHandPan(container, () => this.tool === 'hand', signal)
        container.addEventListener('pointerdown', (event) => this.onTapStart(event), { signal })
        container.addEventListener('pointerup', (event) => this.onTapEnd(event), { signal })
        // The tap that turned the page ends there, or its click lands on whatever the next page has under it.
        container.addEventListener(
            'touchend',
            (event) => {
                if (this.turnedAtEdge) event.preventDefault()
                this.turnedAtEdge = false
            },
            { signal, passive: false },
        )
        document.addEventListener(
            'selectionchange',
            () => {
                this.onSelectionChange()
                // A task of its own, to come after pdf.js's listener for this event, which puts the mark back.
                setTimeout(() => this.clearIdleSelecting())
            },
            { signal },
        )
        container.addEventListener('mouseup', () => this.clearIdleSelecting(), { signal })
    }

    private onWheel(event: WheelEvent): void {
        if (!event.ctrlKey && !event.metaKey) return
        event.preventDefault()
        this.viewer?.updateScale({ drawingDelay: 400, scaleFactor: wheelZoomFactor(event.deltaY, event.deltaMode), origin: this.viewMiddle() })
        this.rememberZoom()
    }

    private tapStart: { x: number; y: number; at: number } | null = null
    private turnedAtEdge = false
    private pageCountTimer: ReturnType<typeof setTimeout> | undefined

    private showPageCount(): void {
        this.pageCountShowing = true
        clearTimeout(this.pageCountTimer)
        this.pageCountTimer = setTimeout(() => (this.pageCountShowing = false), PAGE_COUNT_MS)
    }

    private hidePageCount(): void {
        this.pageCountShowing = false
        clearTimeout(this.pageCountTimer)
    }

    private onTapStart(event: PointerEvent): void {
        this.toolOptionsOpen = false
        this.keepScreen?.touched()
        this.tapStart = { x: event.clientX, y: event.clientY, at: Date.now() }
    }

    private onTapEnd(event: PointerEvent): void {
        this.onPointerRelease()
        const start = this.tapStart
        this.tapStart = null
        // The Hand is for a mouse, so to a touch it is the same as no tool.
        if (!start || (this.tool !== 'none' && this.tool !== 'hand') || (event.pointerType !== 'touch' && event.pointerType !== 'pen')) return
        const dx = event.clientX - start.x
        const dy = event.clientY - start.y
        const tapped = Math.hypot(dx, dy) <= TAP_SLOP_PX
        if (tapped && this.turnAtEdge(event)) return
        if (event.pointerType !== 'touch') return
        if (tapped) this.onTap(event)
        else this.onSwipe(dx, dy)
    }

    /**
     * A tap in the outer part of the view does what the button under it does, at any height and however
     * far the page is zoomed or moved, because the sides are the screen's and not the page's. At once, so
     * that quick taps turn quickly: a double-tap zooms only away from these. Only what answers a tap for
     * itself keeps it, as a selection does to clear. The side flashes when the page turns.
     */
    private turnAtEdge(event: PointerEvent): boolean {
        const side = this.sideTapped(event)
        if (!side) return false
        clearTimeout(this.singleTapTimer)
        this.lastTap = null
        this.turnedAtEdge = true
        const turned = side === 'previous' ? this.previousPage() : this.nextPage()
        if (turned) this.turnFlash = { side }
        return true
    }

    /** The side of the view a tap landed in, unless the tap belongs to something else. */
    private sideTapped(event: PointerEvent): 'previous' | 'next' | null {
        const container = this.container
        if (!container || !this.preferences.pageByPage || this.hasSelection) return null
        if (event.target instanceof Element && event.target.closest(ANSWERS_A_TAP)) return null
        const box = container.getBoundingClientRect()
        const share = (event.clientX - box.left) / box.width
        if (share < EDGE_TAP_SHARE) return 'previous'
        return share > 1 - EDGE_TAP_SHARE ? 'next' : null
    }

    /** A page turn: page by page, not zoomed in past the screen, and not while drawing. */
    private onSwipe(dx: number, dy: number): void {
        if (!this.preferences.pageByPage || !this.pageFitsScreen()) return
        if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return
        if (dx < 0) this.nextPage()
        else this.previousPage()
    }

    private pageFitsScreen(): boolean {
        const container = this.container
        return !container || container.scrollWidth <= container.clientWidth + 1
    }

    private onTap(event: PointerEvent): void {
        if (event.target instanceof Element && event.target.closest('a, button, input, select, textarea')) return
        const last = this.lastTap
        const now = Date.now()
        if (last && now - last.at < DOUBLE_TAP_MS && Math.hypot(event.clientX - last.x, event.clientY - last.y) < DOUBLE_TAP_PX) {
            clearTimeout(this.singleTapTimer)
            this.lastTap = null
            this.toggleCloseZoom(event)
            return
        }
        this.lastTap = { at: now, x: event.clientX, y: event.clientY }
        clearTimeout(this.singleTapTimer)
        // A tap clears a selection before this wait is up, and that tap has then done its job.
        const answered = this.hasSelection || (event.target instanceof Element && !!event.target.closest(ANSWERS_A_TAP))
        this.singleTapTimer = setTimeout(() => this.onSingleTap(answered), DOUBLE_TAP_MS)
    }

    /** The middle of the page, or anywhere on it without Page by page, where no side turns the page. */
    private onSingleTap(answered: boolean): void {
        if (answered || window.getSelection()?.toString()) return
        if (!this.controls.on || this.controls.toggle()) this.showPageCount()
        else this.hidePageCount()
    }

    /** Double-tap: fit-width and a closer zoom, in turn. */
    private toggleCloseZoom(event: PointerEvent): void {
        const viewer = this.viewer
        if (!viewer) return
        if (this.pageFitsScreen()) viewer.updateScale({ scaleFactor: 2, origin: [event.clientX, event.clientY] })
        else this.fitWidth()
        this.rememberZoom()
    }

    // ---- Reading controls ----

    get inkColour(): string {
        return knownColour(this.preferences.inkColour, DEFAULT_INK)
    }

    get highlightColour(): string {
        return knownColour(this.preferences.highlightColour, DEFAULT_HIGHLIGHT)
    }

    get customColour(): string {
        return knownColour(this.preferences.customColour, DEFAULT_CUSTOM)
    }

    /** The colour the tool in hand draws with. */
    get toolColour(): string {
        return this.tool === 'highlight' || this.tool === 'highlighter' ? this.highlightColour : this.inkColour
    }

    /** Applies to the tool in hand: highlighting and inking each keep a colour of their own. */
    pickColour(colour: string): void {
        this.updatePreferences(this.tool === 'highlight' || this.tool === 'highlighter' ? { highlightColour: colour } : { inkColour: colour })
    }

    pickCustomColour(colour: string): void {
        this.updatePreferences({ customColour: colour })
        this.pickColour(colour)
    }

    strokeWidth(tool: DrawingTool): number {
        return knownStrokeWidth(tool, tool === 'pen' ? this.preferences.penWidth : this.preferences.highlighterWidth)
    }

    setStrokeWidth(tool: DrawingTool, width: number): void {
        this.updatePreferences(tool === 'pen' ? { penWidth: width } : { highlighterWidth: width })
    }

    /** A link to this PDF was clicked. Kept with the PDF, so a reload still knows it. */
    noteOpenedFrom(from: PdfOpenedFrom): void {
        this.openedFrom = from
        if (this.hash) this.memory.updatePdf(this.environment.graphId, this.hash, { openedFrom: from })
    }

    get fingerDraws(): boolean {
        return this.preferences.fingerDraws ?? this.fingerDrawsByDefault
    }

    set fingerDraws(on: boolean) {
        this.updatePreferences({ fingerDraws: on })
    }

    updatePreferences(change: Partial<PdfPreferences>): void {
        this.memory.setPreferences(change)
        this.preferences = this.memory.preferences()
    }

    setPageByPage(on: boolean): void {
        this.updatePreferences({ pageByPage: on })
        if (this.viewer && this.web) this.viewer.scrollMode = on ? this.web.ScrollMode.PAGE : this.web.ScrollMode.VERTICAL
    }

    setKeepScreenOn(on: boolean): void {
        this.updatePreferences({ keepScreenOn: on })
        this.keepScreen?.setEnabled(on)
    }

    /** pdf.js reads its page colours when a document is set, so the document is set again. */
    setDarkPages(on: boolean): void {
        this.updatePreferences({ darkPages: on })
        const viewer = this.viewer
        const pdf = this.pdf
        if (!viewer || !pdf) return
        // The new pages start from these, in `onPagesInit`.
        this.heldScale = viewer.currentScaleValue
        this.linkedPage = this.page
        this.overlays.clear()
        viewer.pageColors = on ? DARK_PAGES : null
        viewer.setDocument(pdf)
    }

    /** Turn crop margins on or off. Optional, and remembered per PDF on this device. */
    async setCrop(on: boolean): Promise<void> {
        this.cropOn = on
        if (this.hash) this.memory.updatePdf(this.environment.graphId, this.hash, { crop: on })
        if (!on) {
            this.crop = null
            this.applyCropToPages()
            if (this.viewer) this.viewer.currentScaleValue = 'auto'
            return
        }
        this.cropBusy = true
        try {
            this.crop = await this.measureCrop()
            this.uncroppedPages.clear()
            this.applyCropScale()
            this.applyCropToPages()
        } finally {
            this.cropBusy = false
        }
    }

    private async renderSmall(pageNumber: number): Promise<Margins | null> {
        const pdf = this.pdf
        if (!pdf) return null
        const page = await pdf.getPage(pageNumber)
        const natural = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: 200 / natural.width })
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        await page.render({ canvas, viewport }).promise
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return null
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
        return contentMargins(image)
    }

    private async measureCrop(): Promise<DocumentCrop> {
        const samples = []
        for (const page of samplePages(this.pageCount)) {
            const margins = await this.renderSmall(page)
            if (margins) samples.push({ page, margins })
        }
        return cropFromSamples(samples)
    }

    private cropFor(pageNumber: number): Margins | null {
        if (!this.crop || this.uncroppedPages.has(pageNumber)) return null
        return pageNumber % 2 === 1 ? this.crop.odd : this.crop.even
    }

    /** The scale that fits the cropped width of the page in view to the tab. */
    applyCropScale(): void {
        const { viewer, container, crop } = this
        if (!viewer || !container || !crop) return
        const view = viewer.getPageView(this.page - 1)
        const margins = this.cropFor(this.page) ?? crop.odd
        const atOne = view?.viewport ? view.viewport.width / view.scale : 0
        const width = container.clientWidth - 16
        if (atOne > 0 && width > 0) viewer.currentScale = width / (atOne * (1 - margins.left - margins.right))
    }

    private applyCropToPage(page: OverlayPage): void {
        const margins = this.cropFor(page.id)
        const { div } = page
        if (!margins || (margins.left === 0 && margins.right === 0)) {
            div.style.removeProperty('clip-path')
            div.style.removeProperty('margin-left')
            div.style.removeProperty('margin-right')
            div.removeAttribute('data-cropped')
            return
        }
        // From the view, not the element: a page out of the document in Page by page measures nothing.
        const width = page.viewport?.width ?? div.clientWidth
        div.setAttribute('data-cropped', 'true')
        div.style.clipPath = `inset(0 ${margins.right * 100}% 0 ${margins.left * 100}%)`
        // The crop leaves the page 16px narrower than the tab, so it sits in the middle.
        div.style.marginLeft = `${8 - margins.left * width}px`
        div.style.marginRight = `${-margins.right * width}px`
    }

    private applyCropToPages(): void {
        const viewer = this.viewer
        if (!viewer) return
        for (let i = 0; i < viewer.pagesCount; i++) {
            const page = viewer.getPageView(i) as unknown as OverlayPage | undefined
            if (page) this.applyCropToPage(page)
        }
    }

    /** A page the sample did not see, with content the crop would cut off, is shown whole. */
    private async checkPageAgainstCrop(page: OverlayPage): Promise<void> {
        const crop = this.cropFor(page.id)
        if (!crop || this.uncroppedPages.has(page.id)) return
        const margins = await this.renderSmall(page.id)
        if (pageFitsCrop(margins, crop)) return
        this.uncroppedPages.add(page.id)
        this.applyCropToPage(page)
    }

    // ---- Find ----

    openFind(): void {
        this.findOpen = true
    }

    closeFind(): void {
        this.findOpen = false
        this.findQuery = ''
        this.find = { current: 0, total: 0, state: 'idle' }
        this.eventBus?.dispatch('findbarclose', { source: this })
    }

    runFind(query: string, type: '' | 'again' = '', previous = false): void {
        this.findQuery = query
        if (query === '') {
            this.find = { current: 0, total: 0, state: 'idle' }
            this.eventBus?.dispatch('findbarclose', { source: this })
            return
        }
        this.find = { ...this.find, state: 'pending' }
        this.eventBus?.dispatch('find', {
            source: this,
            type,
            query,
            caseSensitive: false,
            entireWord: false,
            highlightAll: true,
            findPrevious: previous,
            matchDiacritics: false,
        })
    }

    private async onFindState(event: { state: number; matchesCount: { current: number; total: number } }): Promise<void> {
        const { web } = this
        if (!web) return
        const { current, total } = event.matchesCount
        if (event.state === web.FindState.PENDING) {
            this.find = { current, total, state: 'pending' }
            return
        }
        if (event.state !== web.FindState.NOT_FOUND) {
            this.find = { current, total, state: 'found' }
            return
        }
        this.find = { current: 0, total: 0, state: (await this.hasAnyText()) ? 'not-found' : 'no-text' }
    }

    private async pageHasText(pageNumber: number): Promise<boolean> {
        const page = await this.pdf!.getPage(pageNumber)
        const { items } = await page.getTextContent()
        return items.some((item) => 'str' in item && item.str.trim() !== '')
    }

    /** A scanned PDF has no text, which is a different answer from no match. */
    private async hasAnyText(): Promise<boolean> {
        const { pdf } = this
        if (!pdf) return true
        for (const n of samplePages(pdf.numPages, 8)) {
            if (await this.pageHasText(n)) return true
        }
        return false
    }

    /** Whether each page read so far has text. A page not read yet counts as having some. */
    private readonly pagesWithText = new Map<number, boolean>()

    /** Find out whether the page in view has text to select, and say so if it is still in view. */
    private async readPageText(pageNumber: number): Promise<void> {
        if (!this.pdf) return
        let known = this.pagesWithText.get(pageNumber)
        if (known === undefined) {
            this.pageWithoutText = false
            known = await this.pageHasText(pageNumber).catch(() => true)
            this.pagesWithText.set(pageNumber, known)
        }
        if (this.page === pageNumber) this.pageWithoutText = !known
    }

    /** The text selected in this PDF at this moment, for `context.layout.activeFile`. */
    fileSelection(): FileSelection {
        const selection = window.getSelection()
        if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !this.container?.contains(selection.anchorNode)) {
            return { selectedText: '', restoreSelection() {} }
        }
        const range = selection.getRangeAt(0).cloneRange()
        return {
            selectedText: selection.toString().replace(/\s+/g, ' ').trim(),
            restoreSelection() {
                const now = window.getSelection()
                now?.removeAllRanges()
                now?.addRange(range)
            },
        }
    }

    // ---- Annotating ----

    setTool(tool: PdfTool): void {
        this.toolOptionsOpen = false
        this.tool = this.tool === tool ? 'none' : tool
        if (this.tool === 'highlight' && this.hasSelection) this.highlightSelection()
    }

    private onSelectionChange(): void {
        const selection = window.getSelection()
        const inside = !!selection && !selection.isCollapsed && !!this.container?.contains(selection.anchorNode)
        this.hasSelection = inside
    }

    /**
     * pdf.js marks a text layer as selecting on mousedown and for as long as the selection is in it, a
     * caret included, and clears the mark on pointerup, the order a mouse sends them. A touch's mouse
     * events come after its pointerup, so a tap leaves the mark on and a caret behind it. While the mark
     * is on, the page's links and form fields take no touches, so it goes when nothing is being selected.
     */
    private clearIdleSelecting(): void {
        if (this.tapStart || !window.getSelection()?.isCollapsed) return
        this.container?.querySelectorAll('.textLayer.selecting').forEach((layer) => layer.classList.remove('selecting'))
    }

    /** The text tool: highlight what is selected, a click or a lifted finger after selecting it. */
    onPointerRelease(): void {
        if (this.tool === 'highlight' && this.hasSelection) this.highlightSelection()
    }

    /** Turn the selection into one highlight per page it touches. */
    highlightSelection(): void {
        const selection = window.getSelection()
        const viewer = this.viewer
        if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !viewer) return
        const rects = [...selection.getRangeAt(0).getClientRects()]
        const text = selection.toString().replace(/\s+/g, ' ').trim()
        const created: PdfHighlight[] = []
        for (let i = 0; i < viewer.pagesCount; i++) {
            const highlight = this.highlightOnPage(viewer.getPageView(i) as unknown as OverlayPage, rects, text)
            if (highlight) created.push(highlight)
        }
        selection.removeAllRanges()
        this.hasSelection = false
        this.addAll(created, 'Highlight')
    }

    private highlightOnPage(page: OverlayPage, rects: DOMRect[], text: string): PdfHighlight | null {
        const frame = frameOf(page)
        if (!frame || !page.div.isConnected) return null
        const box = page.div.getBoundingClientRect()
        const inPage = rects.filter((rect) => {
            const [x, y] = [rect.left + rect.width / 2, rect.top + rect.height / 2]
            return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
        })
        if (inPage.length === 0) return null
        const scaleX = frame.width / box.width
        const scaleY = frame.height / box.height
        const boxes: Box[] = inPage.map((rect) => ({
            left: (rect.left - box.left) * scaleX,
            right: (rect.right - box.left) * scaleX,
            top: (rect.top - box.top) * scaleY,
            bottom: (rect.bottom - box.top) * scaleY,
        }))
        const now = Date.now()
        return {
            id: newPdfStateId(),
            kind: 'highlight',
            page: page.id,
            colour: this.highlightColour,
            createdAt: now,
            updatedAt: now,
            quads: boxesToQuads(frame, mergeLineBoxes(boxes)),
            // A password-protected PDF's words stay out of a plain file beside it.
            ...(this.protectedByPassword ? {} : { text }),
        }
    }

    private addStroke(page: number, tool: 'pen' | 'highlighter', points: number[], pressures?: number[]): void {
        const now = Date.now()
        this.addAll(
            [
                {
                    id: newPdfStateId(),
                    kind: 'stroke',
                    tool,
                    page,
                    colour: tool === 'pen' ? this.inkColour : this.highlightColour,
                    width: this.strokeWidth(tool),
                    points,
                    ...(pressures ? { pressures } : {}),
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            tool === 'pen' ? 'Draw' : 'Highlight',
        )
    }

    private addAll(created: readonly PdfAnnotation[], label: string): void {
        if (created.length === 0) return
        const put = () => {
            for (const annotation of created) this.store?.putAnnotation(annotation)
        }
        const remove = () => {
            for (const annotation of created) this.store?.removeAnnotation(annotation.id)
        }
        put()
        this.pushUndo({ label, page: created[0].page, undo: remove, redo: put })
    }

    removeAnnotation(id: string, label = 'Delete'): void {
        const annotation = this.annotations.find((a) => a.id === id)
        if (!annotation) return
        this.store?.removeAnnotation(id)
        this.pushUndo({ label, page: annotation.page, undo: () => this.store?.putAnnotation(annotation), redo: () => this.store?.removeAnnotation(id) })
    }

    openNote(id: string): void {
        const note = this.annotations.find((a): a is PdfNote => a.id === id && a.kind === 'note')
        if (note) this.noteEditor = { id, page: note.page, x: note.x, y: note.y, text: note.text }
    }

    /** Keep the note being edited. Emptied, it goes. */
    commitNote(text: string): void {
        const editor = this.noteEditor
        this.noteEditor = null
        if (!editor) return
        const trimmed = text.trim()
        const held = this.annotations.find((a): a is PdfNote => a.id === editor.id && a.kind === 'note')
        if (!held) {
            if (trimmed !== '') this.addNewNote(editor.page, editor.x, editor.y, trimmed)
            return
        }
        if (trimmed === '') {
            this.removeAnnotation(held.id)
        } else if (trimmed !== held.text) {
            const next: PdfNote = { ...held, text: trimmed, updatedAt: Date.now() }
            this.store?.putAnnotation(next)
            this.pushUndo({ label: 'Edit note', page: held.page, undo: () => this.store?.putAnnotation(held), redo: () => this.store?.putAnnotation(next) })
        }
    }

    private addNewNote(page: number, x: number, y: number, text: string): void {
        const now = Date.now()
        this.addAll([{ id: newPdfStateId(), kind: 'note', page, x, y, text, fontSize: NOTE_FONT_SIZE, colour: this.inkColour, createdAt: now, updatedAt: now }], 'Add note')
    }

    cancelNote(): void {
        this.noteEditor = null
    }

    /** Where a note's editor sits on its page, as fractions of the page. */
    noteEditorPosition(): { left: number; top: number; pageElement: HTMLElement | null } | null {
        const editor = this.noteEditor
        const page = editor ? (this.viewer?.getPageView(editor.page - 1) as unknown as OverlayPage | undefined) : undefined
        const frame = page ? frameOf(page) : null
        if (!editor || !page || !frame) return null
        const [a, b, c, d, e, f] = frame.transform
        const x = a * editor.x + c * editor.y + e
        const y = b * editor.x + d * editor.y + f
        return { left: x / frame.width, top: y / frame.height, pageElement: page.div }
    }

    private pushUndo(step: UndoStep): void {
        this.undoStack = [...this.undoStack, step].slice(-UNDO_DEPTH)
        this.redoStack = []
        this.syncUndo()
    }

    private syncUndo(): void {
        this.canUndo = this.undoStack.length > 0
        this.canRedo = this.redoStack.length > 0
    }

    /** Some of the page is on screen. In page by page, the pages not in front are out of the document. */
    private pageOnScreen(pageNumber: number): boolean {
        const element = (this.viewer?.getPageView(pageNumber - 1) as unknown as OverlayPage | undefined)?.div
        if (!element || !this.container) return false
        const box = element.getBoundingClientRect()
        return box.width > 0 && boxesOverlap(box, this.container.getBoundingClientRect())
    }

    /** A step changes a page, which may be far from this one: without going there, nothing seems to happen. */
    private showStep(step: UndoStep): void {
        if (!this.pageOnScreen(step.page)) this.goToPage(step.page)
    }

    undo(): void {
        const step = this.undoStack.pop()
        if (!step) return
        this.showStep(step)
        step.undo()
        this.redoStack.push(step)
        this.syncUndo()
    }

    redo(): void {
        const step = this.redoStack.pop()
        if (!step) return
        this.showStep(step)
        step.redo()
        this.undoStack.push(step)
        this.syncUndo()
    }

    // ---- PDF Bookmarks ----

    /** The PDF Bookmark on the page in view, when there is one. */
    get bookmarkHere(): PdfBookmark | undefined {
        return this.bookmarks.find((mark) => mark.page === this.page)
    }

    toggleBookmark(): void {
        const held = this.bookmarkHere
        if (held) {
            this.removeBookmark(held.id)
            return
        }
        if (!this.hash) return
        addPdfBookmark({ hash: this.hash, target: this.environment.target(), name: this.environment.name() }, this.page).catch((error: unknown) => this.saveFailed(error))
    }

    removeBookmark(id: string): void {
        removePdfBookmark(id).catch((error: unknown) => this.saveFailed(error))
    }

    private saveFailed(error: unknown): void {
        this.stateProblem = error instanceof Error ? error.message : String(error)
    }

    // ---- Signatures ----

    /** Put a signature in the middle of the page in view, ready to be dragged into place. */
    placeSignature(url: string, aspect: number): void {
        const viewer = this.viewer
        const page = viewer?.getPageView(this.page - 1) as unknown as OverlayPage | undefined
        const frame = page ? frameOf(page) : null
        if (!frame) return
        const view = (page as unknown as { pdfPage: { view: number[] } }).pdfPage.view
        const width = Math.min(frame.width * 0.35, 200)
        const height = width / aspect
        const x = (view[0] + view[2] - width) / 2
        const y = (view[1] + view[3] - height) / 2
        this.holdSignatures({ list: [...this.signatures, { id: newPdfStateId(), page: this.page, x, y, width, height, url }], saved: false })
        this.overlays.refresh()
    }

    private moveSignature(id: string, change: Partial<Pick<PlacedSignature, 'x' | 'y' | 'width' | 'height'>>): void {
        this.holdSignatures({ list: this.signatures.map((s) => (s.id === id ? { ...s, ...change } : s)) })
        this.overlays.refresh()
    }

    private removeSignature(id: string): void {
        this.holdSignatures({ list: this.signatures.filter((s) => s.id !== id) })
        this.overlays.refresh()
    }

    /** Where this PDF's signatures are kept, once its hash is known. */
    private get signaturesKey(): string | null {
        return this.hash ? signaturesKey(this.environment.graphId, this.hash) : null
    }

    private get held(): HeldSignatures | undefined {
        return this.signaturesKey ? heldSignatures(this.signaturesKey) : undefined
    }

    get signatures(): PlacedSignature[] {
        return this.held?.list ?? []
    }

    /** The signatures have been written to a file, so closing the tab no longer loses them. */
    get signaturesSaved(): boolean {
        return this.held?.saved ?? true
    }

    private holdSignatures(change: Partial<HeldSignatures>): void {
        if (this.signaturesKey) holdSignatures(this.signaturesKey, { list: this.signatures, saved: this.signaturesSaved, ...change })
    }

    markSignaturesSaved(): void {
        this.holdSignatures({ saved: true })
    }

    /**
     * The tab is going. A signature in no file stays, to come back when the PDF opens. One already in a
     * copy stays through a rebuild and goes with its tab, which a task later is out of the layout
     * whichever way it closed: a tab's own close button takes it out only after the tab has gone.
     */
    releaseSavedSignatures(tabIsOpen: () => boolean): void {
        const key = this.signaturesKey
        if (!key) return
        setTimeout(() => {
            if (heldSignatures(key)?.saved && !tabIsOpen()) dropSignatures(key)
        })
    }

    /** Whether closing would lose a signature nobody saved. */
    get hasUnsavedSignature(): boolean {
        return this.signatures.length > 0 && !this.signaturesSaved
    }

    /** The person chose not to keep what they placed. */
    discardSignatures(): void {
        if (this.signaturesKey) dropSignatures(this.signaturesKey)
        this.overlays.refresh()
    }

    // ---- Print ----

    async print(includeAnnotations: boolean): Promise<void> {
        const { pdf, lib } = this
        if (!pdf || !lib || this.printing) return
        this.printError = null
        this.printing = { done: 0, total: pdf.numPages }
        try {
            await printPdf({
                pdf,
                lib,
                annotations: includeAnnotations ? this.annotations : [],
                signatures: this.signatures,
                onProgress: (done, total) => (this.printing = { done, total }),
                signal: this.controller.signal,
            })
        } catch (error) {
            if (!this.destroyed) this.printError = `This PDF could not be printed (${error instanceof Error ? error.message : String(error)}).`
        } finally {
            this.printing = null
        }
    }

    /** Scroll to a page and flash nothing: what the panel's rows do. */
    showPage(pageNumber: number): void {
        this.goToPage(pageNumber)
    }

    async destroy(): Promise<void> {
        this.destroyed = true
        clearTimeout(this.placeTimer)
        clearTimeout(this.singleTapTimer)
        clearTimeout(this.pageCountTimer)
        this.controls.destroy()
        this.writePlace()
        this.controller.abort()
        this.keepScreen?.destroy()
        this.stopStore?.()
        this.stopBookmarks?.()
        this.overlays.clear()
        const store = this.store
        this.store = null
        this.viewer?.setDocument(null as never)
        this.linkService?.setDocument(null as never, null)
        await store?.close()
        await this.task?.destroy()
    }
}
