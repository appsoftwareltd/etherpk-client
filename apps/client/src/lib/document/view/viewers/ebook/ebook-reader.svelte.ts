/**
 * One EBook tab's reader: what the toolbar shows, and everything a person does to the EBook. The EBook
 * itself is in a frame with an opaque origin (ADR 0181), so this class holds no part of it but the
 * words a person selects: it sends the frame commands and checks what the frame reports.
 */
import { DEFAULT_HIGHLIGHT, knownColour } from '#lib/document/pdf/annotation-palette.js'
import type { FileSelection } from '#lib/document/file-in-front.js'
import { adoptEbookTarget, addEbookBookmark, removeEbookBookmark, removeEbookBookmarksAt, subscribeEbookBookmarks, type EbookBookmark } from '#lib/document/ebook/ebook-bookmarks.js'
import { ebookDeviceMemory, type EbookPreferences } from '#lib/document/ebook/ebook-device-memory.js'
import { EBOOK_FRAME_PROTOCOL, readFrameMessage, type AppToFrame, type FrameHighlight, type FrameToApp, type OpenedEbook, type Relocated, type SearchMatch, type SelectionChanged, type TocEntry } from '#lib/document/ebook/ebook-frame-protocol.js'
import { countsAsReading, paceAfterTurn, paceMinutes } from '#lib/document/ebook/ebook-pace.js'
import { DARK_PAGE, FONT_SIZE_RANGE, LIGHT_PAGE, type EbookFont, type EbookSettings, type FrameFont, type PageColours } from '#lib/document/ebook/ebook-settings.js'
import { todayISO } from '#lib/document/calendar/month-grid-core.js'
import type { EbookHighlight, EbookPlace, EbookStateStore } from '#lib/document/ebook/ebook-state.js'

import { HidingControls } from '../pdf/pdf-hiding-controls'
import { loadEbookFont } from './ebook-fonts'
import { browserSpeech, ReadAloud } from './read-aloud.svelte'
import { browserKeepScreenOn, type KeepScreenOn } from '../pdf/wake-lock'

export type EbookStatus = 'opening' | 'ready' | 'protected' | 'error'

const PLACE_WRITE_DELAY_MS = 1500
const UNDO_DEPTH = 100
/** How long the frame has to say it is there, before the tab says it could not start. */
const FRAME_READY_MS = 20_000
/** How much of the view's width, from each side, turns the page at a tap. */
export const EDGE_TAP_SHARE = 0.22
/** A place on another device at least this far from here is worth offering. */
const PLACE_WORTH_OFFERING = 0.005
/** Less than this far from where the EBook opened is its layout settling, and not a person moving on. */
const SETTLING_FRACTION = 0.001
/** A place arriving this soon after opening, with nothing read yet, is gone to rather than offered. */
const JUST_OPENED_MS = 10_000
/** How long the progress stays once the page in view changes, where it is the only sign of it. */
const PROGRESS_MS = 5000
const ZOOM_STEP = 1.25

export interface EbookEnvironment {
    graphId: string
    /** The Asset's identity, which keys its tab. */
    target(): string
    /** Its file name as it stands, which a rename changes. */
    name(): string
    /** Opens this EBook's own state. Null when the graph keeps none. */
    openState(hash: string): Promise<EbookStateStore>
}

export interface SearchSection {
    chapter: string
    matches: SearchMatch[]
}

interface UndoStep {
    label: string
    cfi: string
    undo(): void
    redo(): void
}

export const TOUCH_PHONE = '(pointer: coarse) and (max-width: 640px), (pointer: coarse) and (max-height: 640px)'

/** One Latin letter finds most of an EBook, and one Chinese character is a word. */
export const isSearchable = (query: string): boolean => {
    const trimmed = query.trim()
    return trimmed.length > 1 || (trimmed.length === 1 && trimmed.charCodeAt(0) > 127)
}

const isTouchFirst = () => typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches

async function bytesHash(bytes: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The app's own page colours, which the frame cannot read for itself. */
function appPageColours(): PageColours {
    if (typeof document === 'undefined') return LIGHT_PAGE
    const dark = document.documentElement.classList.contains('dark')
    const fallback = dark ? DARK_PAGE : LIGHT_PAGE
    const style = getComputedStyle(document.documentElement)
    const token = (name: string, otherwise: string) => style.getPropertyValue(name).trim() || otherwise
    return { dark, background: token('--gk-surface-0', fallback.background), text: token('--gk-text-default', fallback.text), link: token('--gk-accent', fallback.link) }
}

export class EbookReader {
    status = $state<EbookStatus>('opening')
    errorMessage = $state('')
    hash = $state<string | null>(null)
    fileSize = $state(0)

    title = $state('')
    author = $state('')
    toc = $state.raw<TocEntry[]>([])
    direction = $state<'ltr' | 'rtl'>('ltr')
    fixedLayout = $state(false)
    hasPrintPages = $state(false)

    place = $state.raw<Relocated | null>(null)
    preferences = $state.raw<EbookPreferences>(ebookDeviceMemory().preferences())

    selection = $state.raw<SelectionChanged | null>(null)
    highlightToolOn = $state(false)
    highlightColour = $state(DEFAULT_HIGHLIGHT)
    highlights = $state.raw<EbookHighlight[]>([])
    /** The highlight the person pressed, whose actions are showing. */
    pressedHighlight = $state.raw<EbookHighlight | null>(null)
    /** The note being written: on which highlight, or on the selection when it has no id yet. */
    noteEditor = $state.raw<{ highlightId: string | null; selection: SelectionChanged | null; quote: string; text: string } | null>(null)
    bookmarks = $state.raw<EbookBookmark[]>([])
    stateProblem = $state<string | null>(null)
    canUndo = $state(false)
    canRedo = $state(false)

    findOpen = $state(false)
    findQuery = $state('')
    findSections = $state.raw<SearchSection[]>([])
    findBusy = $state(false)

    /** A newer place from another of the person's devices, offered rather than jumped to. */
    placeElsewhere = $state.raw<EbookPlace | null>(null)
    /** A link in the EBook the person pressed, which leaves the graph only if they say so. */
    linkAsked = $state<string | null>(null)

    controlsHidden = $state(false)
    readonly controls = new HidingControls(
        (hidden) => (this.controlsHidden = hidden),
        () => false,
    )
    progressShowing = $state(false)
    readonly readAloud = new ReadAloud(browserSpeech(), {
        start: () => this.send({ type: 'readFromHere' }),
        next: () => this.send({ type: 'readNext' }),
        stop: () => this.send({ type: 'readStop' }),
        voiceName: () => this.preferences.readingVoice,
        rate: () => this.preferences.readingRate,
    })
    turnFlash = $state.raw<{ side: 'previous' | 'next' } | null>(null)

    private frame: HTMLIFrameElement | null = null
    private frameReady: (() => void) | null = null
    private store: EbookStateStore | null = null
    private stopStore: (() => void) | null = null
    private stopBookmarks: (() => void) | null = null
    private keepScreen: KeepScreenOn | null = null
    private undoStack: UndoStep[] = []
    private redoStack: UndoStep[] = []
    private placeTimer: ReturnType<typeof setTimeout> | undefined
    private progressTimer: ReturnType<typeof setTimeout> | undefined
    private pendingPlace: EbookPlace | null = null
    /** When the latest place this tab knows of was written, by it or by another device. */
    private knownPlaceAt = 0
    private pendingLink: string | null = null
    private searchId = 0
    private destroyed = false
    private readonly memory = ebookDeviceMemory()
    private readonly controller = new AbortController()
    /** A key forwarded from the frame, dispatched on the frame so the app's own listeners hear it. */
    onFrameKey: ((event: KeyboardEvent) => void) | null = null
    /** A press on the page, which never reaches the app's own document. Answers whether it closed something. */
    onPagePress: (() => boolean) | null = null

    constructor(private readonly environment: EbookEnvironment) {
        this.highlightColour = knownColour(this.preferences.highlightColour, DEFAULT_HIGHLIGHT)
    }

    get settings(): EbookSettings {
        return this.preferences.settings
    }

    /** Start listening to the frame the component made. */
    attachFrame(frame: HTMLIFrameElement): void {
        this.frame = frame
        window.addEventListener('message', this.onMessage, { signal: this.controller.signal })
        this.keepScreen = browserKeepScreenOn()
        this.keepScreen.setEnabled(isTouchFirst() && this.preferences.keepScreenOn)
    }

    /** Read the file, open its state, and hand both to the frame once it says it is there. */
    async open(url: string): Promise<void> {
        try {
            const frameUp = new Promise<void>((resolve, reject) => {
                this.frameReady = resolve
                setTimeout(() => reject(new Error('the reader did not start')), FRAME_READY_MS)
            })
            // Failing to read the file comes first, and this must not then count as unhandled.
            frameUp.catch(() => {})
            const bytes = await (await fetch(url)).arrayBuffer()
            this.fileSize = bytes.byteLength
            this.hash = await bytesHash(bytes)
            await this.openState(this.hash)
            await frameUp
            if (this.destroyed) return
            await this.sendFont(this.settings.font)
            const stored = this.store?.state().place
            this.knownPlaceAt = stored?.at ?? 0
            const place = this.requestedPlace ?? stored?.cfi ?? null
            this.requestedPlace = null
            this.send({ type: 'open', bytes, place, settings: this.settings, colours: this.pageColours(), highlights: this.frameHighlights(), bookmarks: this.bookmarks.map((b) => b.cfi) }, [bytes])
        } catch (error) {
            this.fail('This EBook could not be opened. Check your connection and open it again.', error)
        }
    }

    private fail(message: string, error?: unknown): void {
        if (this.destroyed) return
        this.errorMessage = message
        this.status = 'error'
        if (error) console.warn('[EBook] open failed', error)
    }

    private async openState(hash: string): Promise<void> {
        const store = await this.environment.openState(hash)
        if (this.destroyed) {
            void store.close()
            return
        }
        this.store = store
        this.adoptState()
        this.stopStore = store.subscribe(() => this.adoptState())
        this.stopBookmarks = subscribeEbookBookmarks((all) => {
            this.bookmarks = all.filter((bookmark) => bookmark.hash === hash).toSorted((a, b) => a.fraction - b.fraction)
            this.sendMarks()
        })
        void adoptEbookTarget(hash, this.environment.target(), this.environment.name()).catch(() => {})
    }

    private adoptState(): void {
        const store = this.store
        if (!store) return
        const state = store.state()
        this.highlights = state.highlights.toSorted((a, b) => a.fraction - b.fraction || a.createdAt - b.createdAt)
        this.stateProblem = store.problem()
        if (this.pressedHighlight) this.pressedHighlight = this.highlights.find((h) => h.id === this.pressedHighlight?.id) ?? null
        this.sendMarks()
        this.noticePlaceElsewhere(state.place)
    }

    /** A place from another device is offered, because a page must not move under someone reading it. */
    private noticePlaceElsewhere(place: EbookPlace | undefined): void {
        // Only a place written since this tab last knew of one came from somewhere else: a change to
        // the highlights also fires this, with the same place as before.
        if (!place || this.status !== 'ready' || !this.place || place.at <= this.knownPlaceAt) return
        this.knownPlaceAt = place.at
        if (place.cfi === this.place.cfi) return
        if (Math.abs(place.fraction - this.place.fraction) < PLACE_WORTH_OFFERING) return
        // Nothing read here yet, so nothing moves under anyone: this is where they meant to be.
        if (!this.hasMoved && Date.now() - this.openedAt < JUST_OPENED_MS) this.goTo(place.cfi)
        else this.placeElsewhere = place
    }

    /** The reader's window: the host page in this tab's frame holds it, and nothing else. */
    private readerWindow(): Window | null {
        return this.frame?.contentWindow?.frames[0] ?? null
    }

    private send(message: AppToFrame, transfer: Transferable[] = []): void {
        // The reader has an opaque origin, which no target origin can name. It is this tab's own frame.
        this.readerWindow()?.postMessage(message, '*', transfer)
    }

    private readonly onMessage = (event: MessageEvent): void => {
        if (!event.source || event.source !== this.readerWindow()) return
        const message = readFrameMessage(event.data)
        if (message) this.handlers[message.type](message as never)
    }

    private readonly handlers: { [K in FrameToApp['type']]: (message: Extract<FrameToApp, { type: K }>) => void } = {
        ready: ({ protocol }) => {
            if (protocol === EBOOK_FRAME_PROTOCOL) this.frameReady?.()
            else this.fail('EtherPK has been updated. Reload the page to read this EBook.')
        },
        opened: (message) => this.onOpened(message),
        failed: ({ reason }) => {
            if (reason === 'protected') this.status = 'protected'
            else this.fail('This file could not be opened as an EBook. It may be damaged.')
        },
        relocate: (message) => this.onRelocate(message),
        selection: (message) => this.onSelection(message),
        tap: ({ xShare }) => this.onTap(xShare),
        key: (message) => this.onFrameKey?.(new KeyboardEvent('keydown', { ...message, bubbles: true, cancelable: true })),
        externalLink: ({ href }) => {
            this.linkAsked = href
        },
        highlightPressed: ({ cfi }) => {
            this.pressedHighlight = this.highlights.find((highlight) => highlight.cfi === cfi) ?? null
        },
        searchResults: ({ id, chapter, matches }) => {
            if (id === this.searchId) this.findSections = [...this.findSections, { chapter, matches }]
        },
        searchDone: ({ id }) => {
            if (id === this.searchId) this.findBusy = false
        },
        speak: ({ text, lang }) => this.readAloud.sentence(text, lang),
    }

    /** Whether the person has gone anywhere yet. An EBook only opened writes no place, or a new device would overwrite theirs. */
    private hasMoved = false
    /** When the EBook opened, and how far through it was. */
    private openedAt = 0
    private openedFraction = 0

    private onOpened(message: OpenedEbook): void {
        this.title = message.title
        this.author = message.author
        this.toc = message.toc
        this.direction = message.direction
        this.fixedLayout = message.fixedLayout
        this.hasPrintPages = message.hasPrintPages
        this.status = 'ready'
        this.openedAt = Date.now()
        this.openedFraction = this.place?.fraction ?? 0
        this.showProgress()
        this.sendMarks()
        this.noticePlaceElsewhere(this.store?.state().place)
    }

    /** The time between turns, which learns the person's pace and counts towards today's reading. */
    private noteTurn(previous: Relocated | null, message: Relocated): void {
        const now = Date.now()
        const elapsed = (now - this.lastTurnAt) / 60_000
        this.lastTurnAt = now
        if (!countsAsReading(elapsed)) return
        const day = todayISO()
        const held = this.preferences.readingDay
        const minutes = (held?.day === day ? held.minutes : 0) + elapsed
        const estimate = (previous?.minutesLeftInEbook ?? 0) - (message.minutesLeftInEbook ?? 0)
        this.updatePreferences({ pace: paceAfterTurn(this.preferences.pace, estimate, elapsed), readingDay: { day, minutes } })
    }

    private lastTurnAt = Date.now()

    /** Foliate's estimate, as this person's pace makes it. */
    paced(minutes: number | null): number | null {
        return minutes === null ? null : paceMinutes(this.preferences.pace, minutes)
    }

    /** The minutes read today on this device. Asked at the moment of use, because a tab can stay open past midnight. */
    get minutesReadToday(): number {
        const held = this.preferences.readingDay
        return held?.day === todayISO() ? held.minutes : 0
    }

    /** Fit the page, or a scale. Only a fixed-layout EBook's pages have a size of their own. */
    fixedZoom = $state<'fit-page' | number>('fit-page')

    zoomBy(factor: number): void {
        const current = this.fixedZoom === 'fit-page' ? 1 : this.fixedZoom
        const next = Math.round(Math.min(4, Math.max(0.5, current * factor)) * 100) / 100
        this.fixedZoom = next
        this.send({ type: 'zoom', zoom: next })
    }

    zoomToFit(): void {
        this.fixedZoom = 'fit-page'
        this.send({ type: 'zoom', zoom: 'fit-page' })
    }

    private onRelocate(message: Relocated): void {
        const moved = this.place?.fraction !== message.fraction
        const previous = this.place
        this.place = message
        if (!moved || this.status !== 'ready') return
        this.showProgress()
        this.keepScreen?.touched()
        // A layout settling moves the fraction a little, which is not a person reading on.
        this.hasMoved ||= Math.abs(message.fraction - this.openedFraction) > SETTLING_FRACTION
        if (!this.hasMoved) return
        this.noteTurn(previous, message)
        this.pendingPlace = { cfi: message.cfi, fraction: message.fraction, at: Date.now() }
        clearTimeout(this.placeTimer)
        this.placeTimer = setTimeout(() => this.writePlace(), PLACE_WRITE_DELAY_MS)
    }

    private writePlace(): void {
        if (!this.pendingPlace) return
        this.knownPlaceAt = this.pendingPlace.at
        this.store?.setPlace(this.pendingPlace)
        this.pendingPlace = null
    }

    private onSelection(message: SelectionChanged): void {
        const has = message.text.trim() !== '' && message.cfi !== null
        this.selection = has ? message : null
        if (has) this.pressedHighlight = null
    }

    private showProgress(): void {
        this.progressShowing = true
        clearTimeout(this.progressTimer)
        this.progressTimer = setTimeout(() => (this.progressShowing = false), PROGRESS_MS)
    }

    /** A tap on the page: the sides turn it, and the middle brings the phone's controls back. */
    private onTap(xShare: number): void {
        this.keepScreen?.touched()
        // The press that closes a menu does that and nothing else, as it does on a PDF.
        if (this.selection || this.onPagePress?.()) return
        if (this.pressedHighlight) this.pressedHighlight = null
        else if (!this.turnAtSide(xShare) && (!this.controls.on || this.controls.toggle())) this.showProgress()
    }

    /** A tap at a side turns the page, whichever way this EBook reads. Answers whether it was at one. */
    private turnAtSide(xShare: number): boolean {
        const atEnd = xShare >= 1 - EDGE_TAP_SHARE
        if (!atEnd && xShare > EDGE_TAP_SHARE) return false
        const direction = atEnd === (this.direction === 'ltr') ? 'next' : 'previous'
        this.turnFlash = { side: direction }
        this.send({ type: direction })
        return true
    }

    next(): void {
        this.send({ type: 'next' })
    }

    previous(): void {
        this.send({ type: 'previous' })
    }

    /** The left arrow goes on in an EBook read from right to left. */
    turnLeft(): void {
        this.send({ type: this.direction === 'rtl' ? 'next' : 'previous' })
    }

    turnRight(): void {
        this.send({ type: this.direction === 'rtl' ? 'previous' : 'next' })
    }

    goBack(): void {
        this.send({ type: 'back' })
    }

    goTo(target: string): void {
        this.send({ type: 'goTo', target })
    }

    goToFraction(fraction: number): void {
        this.send({ type: 'goToFraction', fraction: Math.min(1, Math.max(0, fraction)) })
    }

    /** Go to a place a link or the Sidebar asked for, now or as soon as the EBook opens. */
    private requestedPlace: string | null = null
    openPlaceFromLink(cfi: string): void {
        if (this.status === 'ready') this.goTo(cfi)
        else this.requestedPlace = cfi
    }

    acceptPlaceElsewhere(): void {
        if (this.placeElsewhere) this.goTo(this.placeElsewhere.cfi)
        this.placeElsewhere = null
    }

    /** The EBook's address, for a person who said yes. Opened with no way back to this window. */
    followLink(): void {
        if (this.linkAsked) window.open(this.linkAsked, '_blank', 'noopener,noreferrer')
        this.linkAsked = null
    }

    updatePreferences(change: Partial<EbookPreferences>): void {
        this.memory.setPreferences(change)
        this.preferences = this.memory.preferences()
    }

    updateSettings(change: Partial<EbookSettings>): void {
        this.updatePreferences({ settings: { ...this.settings, ...change } })
        // The page takes the font as soon as it can, and until then its fallback.
        void this.sendFont(this.settings.font).then(() => this.sendSettings())
    }

    /** The font's files, once each: a font that cannot be fetched just now leaves the fallback in its place. */
    private fontsHanded = new Set<EbookFont>()
    private fontFiles: FrameFont[] = []
    private async sendFont(font: EbookFont): Promise<void> {
        if (this.fontsHanded.has(font)) return
        const files = await loadEbookFont(font).catch(() => [])
        if (files.length === 0) return
        this.fontsHanded.add(font)
        this.fontFiles = [...this.fontFiles, ...files]
        // Copies, because transferring would leave nothing to send with the next font.
        this.send({ type: 'fonts', fonts: this.fontFiles.map((file) => ({ ...file, bytes: file.bytes.slice(0) })) })
    }

    sendSettings(): void {
        this.send({ type: 'settings', settings: this.settings, colours: this.pageColours() })
    }

    textSmaller(): void {
        if (this.fixedLayout) return this.zoomBy(1 / ZOOM_STEP)
        this.updateSettings({ fontSize: Math.max(FONT_SIZE_RANGE.min, this.settings.fontSize - FONT_SIZE_RANGE.step) })
    }

    textLarger(): void {
        if (this.fixedLayout) return this.zoomBy(ZOOM_STEP)
        this.updateSettings({ fontSize: Math.min(FONT_SIZE_RANGE.max, this.settings.fontSize + FONT_SIZE_RANGE.step) })
    }

    setKeepScreenOn(on: boolean): void {
        this.updatePreferences({ keepScreenOn: on })
        this.keepScreen?.setEnabled(on)
    }

    private pageColours(): PageColours {
        const { theme } = this.settings
        if (theme === 'light') return LIGHT_PAGE
        if (theme === 'dark') return DARK_PAGE
        return appPageColours()
    }

    openFind(): void {
        this.findOpen = true
    }

    closeFind(): void {
        this.findOpen = false
        this.findQuery = ''
        this.findSections = []
        this.findBusy = false
        this.searchId++
        this.send({ type: 'clearSearch' })
    }

    /** Search the whole EBook. Results arrive chapter by chapter, and a newer search drops the older one's. */
    runFind(query: string): void {
        this.findQuery = query
        this.findSections = []
        const id = ++this.searchId
        if (!isSearchable(query)) {
            this.findBusy = false
            this.send({ type: 'clearSearch' })
            return
        }
        this.findBusy = true
        this.send({ type: 'search', id, query })
    }

    private frameHighlights(): FrameHighlight[] {
        return this.highlights.map((highlight) => ({ cfi: highlight.cfi, colour: highlight.colour, hasNote: !!highlight.note }))
    }

    private sendMarks(): void {
        if (this.status === 'ready') this.send({ type: 'marks', highlights: this.frameHighlights(), bookmarks: this.bookmarks.map((b) => b.cfi) })
    }

    get bookmarksHere(): EbookBookmark[] {
        const here = new Set(this.place?.bookmarksHere ?? [])
        return this.bookmarks.filter((bookmark) => here.has(bookmark.cfi))
    }

    /** Mark this place, or take off the marks in view. A place spans a screen, so it can hold several. */
    toggleBookmark(): Promise<void> {
        const here = this.bookmarksHere
        if (here.length > 0) return removeEbookBookmarksAt(here.map((bookmark) => bookmark.id))
        const { hash, place } = this
        if (!hash || !place) return Promise.resolve()
        return addEbookBookmark({
            hash,
            target: this.environment.target(),
            name: this.environment.name(),
            cfi: place.cfi,
            fraction: place.fraction,
            ...(place.chapter ? { chapter: place.chapter } : {}),
        })
    }

    removeBookmark(id: string): Promise<void> {
        return removeEbookBookmark(id)
    }

    private record(step: UndoStep): void {
        this.undoStack = [...this.undoStack.slice(-(UNDO_DEPTH - 1)), step]
        this.redoStack = []
        this.syncUndo()
    }

    private syncUndo(): void {
        this.canUndo = this.undoStack.length > 0
        this.canRedo = this.redoStack.length > 0
    }

    undo(): void {
        const step = this.undoStack.pop()
        if (!step) return
        this.goTo(step.cfi)
        step.undo()
        this.redoStack.push(step)
        this.syncUndo()
    }

    redo(): void {
        const step = this.redoStack.pop()
        if (!step) return
        this.goTo(step.cfi)
        step.redo()
        this.undoStack.push(step)
        this.syncUndo()
    }

    setHighlightColour(colour: string): void {
        this.highlightColour = colour
        this.updatePreferences({ highlightColour: colour })
        const pressed = this.pressedHighlight
        if (pressed) this.changeHighlight(pressed, { colour }, 'Colour')
    }

    /** The words selected, as a highlight. Answers the highlight, so a note can go on it. */
    highlightSelection(note?: string, selection = this.selection): EbookHighlight | null {
        const { store } = this
        if (!selection?.cfi || !store) return null
        const now = Date.now()
        const highlight: EbookHighlight = {
            id: crypto.randomUUID(),
            cfi: selection.cfi,
            colour: this.highlightColour,
            text: selection.text.replace(/\s+/g, ' ').trim(),
            fraction: selection.fraction,
            createdAt: now,
            updatedAt: now,
            ...(selection.chapter ? { chapter: selection.chapter } : {}),
            ...(note ? { note } : {}),
        }
        store.putHighlight(highlight)
        this.record({ label: 'Highlight', cfi: highlight.cfi, undo: () => store.removeHighlight(highlight.id), redo: () => store.putHighlight(highlight) })
        this.send({ type: 'clearSelection' })
        this.selection = null
        return highlight
    }

    private changeHighlight(highlight: EbookHighlight, change: Partial<EbookHighlight>, label: string): void {
        const store = this.store
        if (!store) return
        const next = { ...highlight, ...change, updatedAt: Date.now() }
        store.putHighlight(next)
        this.record({ label, cfi: highlight.cfi, undo: () => store.putHighlight(highlight), redo: () => store.putHighlight(next) })
    }

    removeHighlight(id: string): void {
        const store = this.store
        const highlight = this.highlights.find((held) => held.id === id)
        if (!store || !highlight) return
        store.removeHighlight(id)
        this.pressedHighlight = null
        this.record({ label: 'Delete', cfi: highlight.cfi, undo: () => store.putHighlight(highlight), redo: () => store.removeHighlight(id) })
    }

    startNote(highlight: EbookHighlight | null): void {
        const quote = highlight?.text ?? this.selection?.text ?? ''
        // The selection goes with the note: a press on the page clears it while the person is still typing.
        this.noteEditor = { highlightId: highlight?.id ?? null, selection: highlight ? null : this.selection, quote: quote.replace(/\s+/g, ' ').trim(), text: highlight?.note ?? '' }
    }

    /** Keep the note. On a selection, it makes the highlight the note belongs to. */
    commitNote(text: string): void {
        const editor = this.noteEditor
        if (!editor) return
        const note = text.trim()
        const held = this.highlights.find((highlight) => highlight.id === editor.highlightId)
        if (held) this.setNote(held, note)
        else this.highlightSelection(note || undefined, editor.selection)
        this.noteEditor = null
    }

    private setNote(highlight: EbookHighlight, note: string): void {
        const store = this.store
        if (!store) return
        const { note: _old, ...rest } = highlight
        const next: EbookHighlight = { ...rest, ...(note ? { note } : {}), updatedAt: Date.now() }
        store.putHighlight(next)
        this.record({ label: 'Note', cfi: highlight.cfi, undo: () => store.putHighlight(highlight), redo: () => store.putHighlight(next) })
    }

    cancelNote(): void {
        this.noteEditor = null
    }

    clearSelection(): void {
        this.send({ type: 'clearSelection' })
        this.selection = null
    }

    /** What an extension can ask about this EBook. The selection stays in the frame, so nothing needs restoring. */
    fileSelection(): FileSelection {
        return { selectedText: (this.selection?.text ?? '').replace(/\s+/g, ' ').trim(), restoreSelection() {} }
    }

    /** The app's theme changed under an EBook that follows it. */
    themeChanged(): void {
        if (this.settings.theme === 'app' && this.status === 'ready') this.sendSettings()
    }

    async destroy(): Promise<void> {
        this.destroyed = true
        this.readAloud.destroy()
        this.controller.abort()
        clearTimeout(this.placeTimer)
        clearTimeout(this.progressTimer)
        this.writePlace()
        this.controls.destroy()
        this.keepScreen?.destroy()
        this.stopBookmarks?.()
        this.stopStore?.()
        await this.store?.close()
    }
}
