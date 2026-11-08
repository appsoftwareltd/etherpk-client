/**
 * The script of the page an EBook reads in (ADR 0181). It runs in a `data:` document with an opaque origin
 * and no network, so it holds foliate-js and the EBook and nothing else: no key, no storage, no way into the
 * app. The app hands it the EBook's bytes and tells it what to do, and it reports what the person does.
 * Bundled into the page by `ebook-frame-plugin.ts`.
 */
import * as CFI from 'foliate-js/epubcfi.js'
import { EPUB } from 'foliate-js/epub.js'
import { FootnoteHandler } from 'foliate-js/footnotes.js'
import { Overlayer } from 'foliate-js/overlayer.js'
import { textWalker } from 'foliate-js/text-walker.js'
import { getSentences } from 'foliate-js/tts.js'
import 'foliate-js/view.js'
import type { FoliateEbook, FoliateRelocate, View } from 'foliate-js/view.js'

import { isProtectedEpub, withoutReachingOut } from '../../../../ebook/ebook-drm'
import { openEbookZip } from '../../../../ebook/ebook-zip'
import { EBOOK_FRAME_PROTOCOL, isOpenableLink, type AppToFrame, type FrameHighlight, type FrameToApp, type TocEntry } from '../../../../ebook/ebook-frame-protocol'
import { ALIGNABLE, FLOATED, floatedAs, isAlignable, pageStyles, type EbookSettings, type FrameFont, type PageColours } from '../../../../ebook/ebook-settings'
import { sha1 } from '../../../../ebook/sha1'

/** The app's tab: this document is inside a host page, which is inside the tab. */
const app = parent.parent
const post = (message: FrameToApp) => app.postMessage(message, '*')

let view: View | null = null
let highlights: FrameHighlight[] = []
let bookmarks: string[] = []
let searchId = 0
/** The stylesheet the pages are in, for a footnote to match them. */
let currentStyles = ''
/** The fonts the app handed over, as `@font-face` rules on blob addresses. */
let fontFaces = ''

function holdFonts(fonts: FrameFont[]): void {
    fontFaces = fonts
        .map(({ family, weight, style, unicodeRange, bytes }) => {
            const url = URL.createObjectURL(new Blob([bytes], { type: 'font/woff2' }))
            return `@font-face { font-family: '${family}'; font-weight: ${weight}; font-style: ${style}; unicode-range: ${unicodeRange}; font-display: swap; src: url('${url}') format('woff2'); }\n`
        })
        .join('')
}
/** Which section each document on screen holds, from foliate's `load`. */
const sectionOf = new WeakMap<Document, number>()

const nameOf = (value: unknown): string => {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(nameOf).filter(Boolean).join(', ')
    if (typeof value !== 'object' || value === null) return ''
    const named = (value as { name?: unknown }).name ?? value
    if (typeof named === 'string') return named
    const first = Object.values(named as object)[0]
    return typeof first === 'string' ? first : ''
}

function flattenToc(items: { label?: string; href?: string; subitems?: unknown[] }[] | undefined, depth = 0): TocEntry[] {
    return (items ?? []).flatMap((item) => [
        { label: (item.label ?? '').trim(), href: item.href ?? '', depth },
        ...flattenToc(item.subitems as typeof items, depth + 1),
    ])
}

function applySettings(settings: EbookSettings, colours: PageColours): void {
    const renderer = view?.renderer
    if (!renderer) return
    document.documentElement.style.background = colours.background
    renderer.setAttribute('flow', settings.flow)
    renderer.setAttribute('margin-left', `${settings.margin}px`)
    renderer.setAttribute('margin-right', `${settings.margin}px`)
    // On a phone the top bar comes and goes over the page, and the page buttons sit at its foot.
    const phone = matchMedia('(pointer: coarse) and (max-width: 640px)').matches
    renderer.setAttribute('margin-top', phone ? '64px' : '32px')
    renderer.setAttribute('margin-bottom', phone ? '72px' : '48px')
    renderer.setAttribute('gap', '6%')
    renderer.setAttribute('max-inline-size', '720px')
    renderer.setAttribute('max-column-count', settings.twoPages ? '2' : '1')
    currentStyles = `${fontFaces}${pageStyles(settings, colours)}`
    renderer.setStyles?.(currentStyles)
    document.documentElement.style.setProperty('--page', colours.background)
    document.documentElement.style.setProperty('--text', colours.text)
}

function bookmarksInView(location: FoliateRelocate): string[] {
    const range = location.cfi
    return bookmarks.filter((cfi) => CFI.compare(CFI.collapse(range), cfi) <= 0 && CFI.compare(cfi, CFI.collapse(range, true)) <= 0)
}

const labelOf = (item: { label?: string } | undefined): string | null => item?.label?.trim() ?? null

function reportPlace(location: FoliateRelocate): void {
    if (!view) return
    const { time } = location
    post({
        type: 'relocate',
        cfi: location.cfi,
        fraction: location.fraction,
        chapter: labelOf(location.tocItem),
        minutesLeftInChapter: time?.section ?? null,
        minutesLeftInEbook: time?.total ?? null,
        printPage: labelOf(location.pageItem),
        backTo,
        canGoForward: view.history.canGoForward,
        bookmarksHere: bookmarksInView(location),
    })
}

/** The words selected in a section, with the section they are in, or null when nothing is selected. */
function selectedIn(doc: Document): { range: Range; index: number; text: string } | null {
    const selection = doc.getSelection()
    const index = sectionOf.get(doc)
    if (index === undefined || !selection || selection.isCollapsed || selection.rangeCount === 0) return null
    return { range: selection.getRangeAt(0), index, text: selection.toString() }
}

/** The latest selection asked about. An answer that took time to work out is dropped if there is a newer one. */
let selectionAsked = 0

async function reportSelection(doc: Document): Promise<void> {
    const asked = ++selectionAsked
    const selected = selectedIn(doc)
    if (!view || !selected) {
        post({ type: 'selection', text: '', cfi: null, chapter: null, fraction: 0 })
        return
    }
    const cfi = view.getCFI(selected.index, selected.range)
    const progress = await view.getCFIProgress(cfi).catch(() => null)
    if (asked !== selectionAsked) return
    post({
        type: 'selection',
        text: selected.text,
        cfi,
        chapter: labelOf(view.getProgressOf(selected.index, selected.range).tocItem),
        fraction: progress?.fraction ?? view.lastLocation?.fraction ?? 0,
    })
}

/** Keys that mean something in a reader, which the browser would otherwise act on in this frame. */
const READER_KEYS = new Set(['arrowleft', 'arrowright', 'pageup', 'pagedown', ' '])
const READER_MOD_KEYS = new Set(['f', 'p', 'k'])

function reportKey(event: KeyboardEvent): void {
    const key = event.key.toLowerCase()
    const held = event.ctrlKey || event.metaKey ? READER_MOD_KEYS : READER_KEYS
    if (held.has(key)) event.preventDefault()
    post({ type: 'key', key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey })
}

/** A press that is not a link, a highlight or the end of a selection. The app decides what it means. */
function reportTap(event: MouseEvent, doc: Document, frameLeft: number, frameTop: number): void {
    const pressed = event.target as Element
    if (linkAround(pressed) || doc.getSelection()?.isCollapsed === false) return
    if (pressed.localName === 'img') {
        showPicture(pressed as HTMLImageElement)
        return
    }
    post({ type: 'tap', xShare: (event.clientX + frameLeft) / innerWidth, yShare: (event.clientY + frameTop) / innerHeight })
}

let highlightPressed = false

const XLINK = 'http://www.w3.org/1999/xlink'

/** The link something is in. An `<a id>` holds an EBook's place, and is not one. */
function linkAround(element: Element): Element | null {
    const link = element.closest('a, area')
    return link?.hasAttribute('href') || link?.hasAttributeNS(XLINK, 'href') ? link : null
}

/**
 * foliate answers `a[href]` alone, so an image map's area or an SVG link would take the section's frame
 * away from the EBook. One out of the EBook asks first, like any other. One within it is held back, because
 * by now its address is a blob with no name for foliate to go to.
 */
function holdOtherLinks(event: Event): void {
    const link = linkAround(event.target as Element)
    if (!link || link.matches('a[href]')) return
    event.preventDefault()
    const href = link.getAttribute('href') ?? link.getAttributeNS(XLINK, 'href')
    if (href && isOpenableLink(href)) post({ type: 'externalLink', href })
}

function listenToSection(doc: Document, index: number): void {
    sectionOf.set(doc, index)
    markAlignable(doc)
    markFloated(doc)
    doc.addEventListener('click', holdOtherLinks, true)
    doc.addEventListener('keydown', reportKey)
    doc.addEventListener('selectionchange', () => void reportSelection(doc))
    doc.addEventListener('click', (event) => {
        // foliate tests for a highlight in a click listener of its own: wait to hear from it.
        setTimeout(() => {
            if (highlightPressed) {
                highlightPressed = false
                return
            }
            const frame = doc.defaultView?.frameElement?.getBoundingClientRect()
            reportTap(event, doc, frame?.left ?? 0, frame?.top ?? 0)
        })
    })
}

/** Marks the paragraphs whose alignment follows the person's choice, by what the EBook set (`ALIGNABLE`). */
function markAlignable(doc: Document): void {
    const window = doc.defaultView
    if (!window) return
    for (const element of doc.querySelectorAll('p, li, blockquote, dd')) {
        if (isAlignable(window.getComputedStyle(element).textAlign)) element.setAttribute(ALIGNABLE, '')
    }
}

/**
 * Marks what the EBook floats inside its paragraphs (`FLOATED`), against the size of the paragraph's words.
 * A paragraph inside another comes later, so the closest one decides.
 */
function markFloated(doc: Document): void {
    const window = doc.defaultView
    if (!window) return
    for (const paragraph of doc.querySelectorAll('p, li, blockquote, dd')) {
        const wordsFontSize = Number.parseFloat(window.getComputedStyle(paragraph).fontSize)
        for (const element of paragraph.querySelectorAll('*')) {
            const style = window.getComputedStyle(element)
            if (style.getPropertyValue('float') === 'none') continue
            element.setAttribute(FLOATED, floatedAs(element.textContent ?? '', Number.parseFloat(style.fontSize), wordsFontSize))
        }
    }
}

const highlightKey = (highlight: FrameHighlight) => ({ value: highlight.cfi, colour: highlight.colour, hasNote: highlight.hasNote })

function drawHighlightsOf(index: number): void {
    for (const highlight of highlights) {
        if (view?.resolveCFI(highlight.cfi).index === index) void view.addAnnotation(highlightKey(highlight))
    }
}

function setMarks(nextHighlights: FrameHighlight[], nextBookmarks: string[]): void {
    const kept = new Set(nextHighlights.map((highlight) => `${highlight.cfi} ${highlight.colour} ${highlight.hasNote}`))
    for (const old of highlights) {
        if (!kept.has(`${old.cfi} ${old.colour} ${old.hasNote}`)) void view?.deleteAnnotation({ value: old.cfi })
    }
    const had = new Set(highlights.map((highlight) => `${highlight.cfi} ${highlight.colour} ${highlight.hasNote}`))
    highlights = nextHighlights
    bookmarks = nextBookmarks
    for (const highlight of nextHighlights) {
        if (!had.has(`${highlight.cfi} ${highlight.colour} ${highlight.hasNote}`)) void view?.addAnnotation(highlightKey(highlight))
    }
    if (view?.lastLocation) reportPlace(view.lastLocation)
}

/**
 * A dialog over the page, in this document, because what it shows is the EBook's own and the app's
 * document holds none of an EBook's markup. Closes on Esc, the button or a press outside it.
 */
function dialogOverPage(content: HTMLElement, label: string): HTMLDialogElement {
    const dialog = document.createElement('dialog')
    dialog.setAttribute('aria-label', label)
    const close = document.createElement('button')
    close.type = 'button'
    close.textContent = 'Close'
    close.addEventListener('click', () => dialog.close())
    dialog.append(close, content)
    dialog.addEventListener('close', () => dialog.remove())
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close()
    })
    document.body.append(dialog)
    return dialog
}

function openDialog(dialog: HTMLDialogElement): void {
    dialog.showModal()
    dialog.querySelector('button')?.focus()
}

/** The dialog of a footnote on its way. foliate needs its view in the document to load the note into. */
let noteDialog: HTMLDialogElement | null = null
const footnotes = new FootnoteHandler()
footnotes.addEventListener('before-render', (event) => {
    const note = (event as CustomEvent<{ view: View }>).detail.view
    note.renderer.setAttribute('flow', 'scrolled')
    // The note alone: without these, a reader scrolls on from it into the next chapter.
    note.renderer.setAttribute('no-preload', '')
    note.renderer.setAttribute('no-continuous-scroll', '')
    note.renderer.setAttribute('margin-top', '0px')
    note.renderer.setAttribute('margin-bottom', '0px')
    note.renderer.setAttribute('margin-left', '16px')
    note.renderer.setAttribute('margin-right', '16px')
    note.renderer.setAttribute('gap', '0%')
    if (currentStyles) note.renderer.setStyles?.(currentStyles)
    noteDialog = dialogOverPage(note, 'Footnote')
    // A link in a note does what one on the page does: out of the EBook it asks first, and within it the
    // page goes there, leaving the note behind.
    note.addEventListener('external-link', (linkEvent) => {
        linkEvent.preventDefault()
        post({ type: 'externalLink', href: (linkEvent as CustomEvent<{ href: string }>).detail.href })
    })
    note.addEventListener('link', (linkEvent) => {
        linkEvent.preventDefault()
        noteDialog?.close()
        void view?.goTo((linkEvent as CustomEvent<{ href: string }>).detail.href)
    })
})
footnotes.addEventListener('render', () => {
    if (noteDialog) openDialog(noteDialog)
})

/** An EBook's picture, as large as the window allows. */
function showPicture(image: HTMLImageElement): void {
    const large = document.createElement('img')
    large.src = image.src
    large.alt = image.alt
    openDialog(dialogOverPage(large, image.alt || 'Picture'))
}

/** Where the person was before the last jump, until they go back or read on. The tab offers to go back there. */
let backTo: number | null = null
/** The place a jump is leaving, until foliate's history takes the jump. */
let leaving: number | null = null
/** The renderer's reasons for a move that is the person reading on, as foliate's history counts them. */
const READING_ON = new Set(['page', 'snap', 'scroll'])

/** Called as a jump starts: to a chapter, a highlight, a found word, a percentage or a link in the EBook. */
function startJump(): void {
    leaving = view?.lastLocation?.fraction ?? null
}

function listenToHistory(target: View): void {
    target.history.addEventListener('popstate', () => {
        backTo = null
    })
    target.history.addEventListener('index-change', () => {
        if (target.history.canGoBack && leaving !== null) backTo = leaving
        else if (!target.history.canGoBack) backTo = null
        leaving = null
        if (target.lastLocation) reportPlace(target.lastLocation)
    })
}

/** Reading on takes the offer away. foliate reports the move before this hears it, so the place goes again. */
function listenToRenderer(target: View): void {
    target.renderer.addEventListener('relocate', (event) => {
        if (!READING_ON.has((event as CustomEvent<{ reason?: string }>).detail.reason ?? '')) return
        leaving = null
        if (backTo === null) return
        backTo = null
        if (target.lastLocation) reportPlace(target.lastLocation)
    })
}

function listenToView(target: View): void {
    listenToHistory(target)
    target.addEventListener('load', (event) => {
        const { doc, index } = (event as CustomEvent<{ doc: Document; index: number }>).detail
        listenToSection(doc, index)
    })
    target.addEventListener('relocate', (event) => reportPlace((event as CustomEvent<FoliateRelocate>).detail))
    target.addEventListener('link', (event) => {
        startJump()
        // A footnote opens over the page. Anything else in the EBook is followed as it is.
        void footnotes.handle(target.book, event)?.catch((error: unknown) => {
            console.warn('[EBook frame] footnote', error)
            noteDialog?.remove()
        })
    })
    target.addEventListener('external-link', (event) => {
        event.preventDefault()
        post({ type: 'externalLink', href: (event as CustomEvent<{ href: string }>).detail.href })
    })
    target.addEventListener('create-overlay', (event) => drawHighlightsOf((event as CustomEvent<{ index: number }>).detail.index))
    target.addEventListener('draw-annotation', (event) => {
        const { draw, annotation } = (event as CustomEvent<{ draw: (shape: unknown, options: unknown) => void; annotation: ReturnType<typeof highlightKey> }>).detail
        draw(annotation.hasNote ? Overlayer.underline : Overlayer.highlight, { color: annotation.colour, width: 3 })
    })
    target.addEventListener('show-annotation', (event) => {
        highlightPressed = true
        post({ type: 'highlightPressed', cfi: (event as CustomEvent<{ value: string }>).detail.value })
    })
}

/**
 * An EBook's scripts would be refused anyway, so they are never handed a blob. A refresh is refused too,
 * but refusing it leaves the section's frame on an error page in place of the EBook, and a browser may
 * act on a connection hint before asking the policy, so both go before the section loads.
 */
function keepSectionsInPlace(book: FoliateEbook): void {
    book.transformTarget?.addEventListener('load', (event) => {
        const { detail } = event as CustomEvent<{ isScript: boolean; allow: boolean }>
        if (detail.isScript) detail.allow = false
    })
    book.transformTarget?.addEventListener('data', (event) => {
        const { detail } = event as CustomEvent<{ data: unknown; type: string }>
        if (/html/.test(detail.type)) detail.data = Promise.resolve(detail.data).then((data) => (typeof data === 'string' ? withoutReachingOut(data) : data))
    })
}

async function open(message: Extract<AppToFrame, { type: 'open' }>): Promise<void> {
    const zip = openEbookZip(new Uint8Array(message.bytes))
    if (isProtectedEpub({ encryption: zip.loadText('META-INF/encryption.xml'), hasRightsFile: zip.has('META-INF/rights.xml') || zip.has('META-INF/license.lcpl') })) {
        post({ type: 'failed', reason: 'protected' })
        return
    }
    // This document has no secure context, so foliate's default of `crypto.subtle` is not there.
    const book = await new EPUB({ ...zip, sha1: async (text: string) => sha1(text) }).init()
    keepSectionsInPlace(book)
    view = document.createElement('foliate-view') as View
    highlights = message.highlights
    bookmarks = message.bookmarks
    listenToView(view)
    document.body.append(view)
    await view.open(book)
    listenToRenderer(view)
    applySettings(message.settings, message.colours)
    await view.init(message.place ? { lastLocation: message.place } : { showTextStart: true })
    post({
        type: 'opened',
        title: nameOf(book.metadata?.title),
        author: nameOf(book.metadata?.author),
        toc: flattenToc(book.toc),
        direction: book.dir === 'rtl' ? 'rtl' : 'ltr',
        fixedLayout: view.isFixedLayout,
        hasPrintPages: (book.pageList?.length ?? 0) > 0,
    })
}

interface FoliateMatch {
    cfi: string
    excerpt?: { pre?: string; match?: string; post?: string }
}

async function search(id: number, query: string): Promise<void> {
    if (!view) return
    searchId = id
    for await (const result of view.search({ query })) {
        if (searchId !== id) return
        const section = result as { label?: string; subitems?: FoliateMatch[] }
        if (result === 'done' || !section.subitems) continue
        post({
            type: 'searchResults',
            id,
            chapter: section.label ?? '',
            matches: section.subitems.map(({ cfi, excerpt }) => ({ cfi, before: excerpt?.pre ?? '', match: excerpt?.match ?? '', after: excerpt?.post ?? '' })),
        })
    }
    post({ type: 'searchDone', id })
}

/** What read aloud has reached: the section's document, and the sentences left in it. */
let reading: { doc: Document; sentences: Generator<{ range: Range }> } | null = null
const READING_MARK = 'ebook-read-aloud'

/** A note is read when its reference is pressed, and not in the middle of the text around it. */
const leaveOutNotes = (node: Node) => ((node as Element).matches?.('aside[epub\\:type]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)

const sentencesOf = (doc: Document) => getSentences(doc, textWalker, leaveOutNotes, 'sentence')

const overlayerOf = (doc: Document) => view?.renderer.getContents().find((section) => section.doc === doc)?.overlayer

function clearReadingMark(): void {
    if (reading) overlayerOf(reading.doc)?.remove(READING_MARK)
}

/** Start with the sentence at the top of the screen, and skip those before it. */
function sentencesFromHere(): void {
    const here = view?.lastLocation?.range
    const doc = here?.startContainer.ownerDocument
    if (!here || !doc) return
    const sentences = sentencesOf(doc)
    let first = sentences.next()
    while (!first.done && first.value.range.compareBoundaryPoints(Range.START_TO_START, here) < 0) first = sentences.next()
    reading = { doc, sentences }
    if (first.done) void speakNext()
    else speak(first.value.range)
}

function speak(range: Range): void {
    if (!reading) return
    overlayerOf(reading.doc)?.add(READING_MARK, range, Overlayer.outline, { color: READING_COLOUR, width: 2 })
    void view?.renderer.scrollToAnchor(range)
    post({ type: 'speak', text: range.toString(), lang: ebookLanguage() })
}

const READING_COLOUR = '#2563eb'

const ebookLanguage = () => nameOf(view?.book.metadata?.language)

/** The next sentence, going on to the next section when this one has none left. */
async function speakNext(): Promise<void> {
    if (!reading || !view) return
    clearReadingMark()
    const next = reading.sentences.next()
    if (!next.done) return speak(next.value.range)
    const before = view.renderer.primaryIndex
    await view.renderer.nextSection()
    const contents = view.renderer.getContents().find((section) => section.index === view?.renderer.primaryIndex)
    if (view.renderer.primaryIndex === before || !contents) {
        reading = null
        post({ type: 'speak', text: null, lang: '' })
        return
    }
    reading = { doc: contents.doc, sentences: sentencesOf(contents.doc) }
    return speakNext()
}

function stopReading(): void {
    clearReadingMark()
    reading = null
}

/** How long a turn can hold up the next one, should foliate not answer: reading must never stop. */
const TURN_WAIT_MS = 600

/** foliate ignores a turn asked for during a turn, so quick taps would lose pages. One waits for the last. */
let turning: Promise<unknown> = Promise.resolve()
const turn = (go: () => Promise<void> | undefined): void => {
    const next = () => Promise.race([go(), new Promise((resolve) => setTimeout(resolve, TURN_WAIT_MS))])
    turning = turning.then(next, next)
}

const COMMANDS: { [K in AppToFrame['type']]: (message: Extract<AppToFrame, { type: K }>) => unknown } = {
    open,
    next: () => turn(() => view?.next()),
    previous: () => turn(() => view?.prev()),
    back: () => view?.history.back(),
    forward: () => view?.history.forward(),
    goTo: ({ target }) => {
        startJump()
        return view?.goTo(target)
    },
    goToFraction: ({ fraction }) => {
        startJump()
        return view?.goToFraction(fraction)
    },
    settings: ({ settings, colours }) => applySettings(settings, colours),
    fonts: ({ fonts }) => holdFonts(fonts),
    zoom: ({ zoom }) => view?.renderer.setAttribute('zoom', String(zoom)),
    marks: ({ highlights: nextHighlights, bookmarks: nextBookmarks }) => setMarks(nextHighlights, nextBookmarks),
    search: ({ id, query }) => search(id, query),
    clearSearch: () => {
        searchId = 0
        view?.clearSearch()
    },
    clearSelection: () => view?.deselect(),
    readFromHere: sentencesFromHere,
    readNext: speakNext,
    readStop: stopReading,
}

window.addEventListener('message', (event) => {
    if (event.source !== app) return
    const message = event.data as AppToFrame
    const run = COMMANDS[message.type] as ((message: AppToFrame) => unknown) | undefined
    if (!run) return
    void Promise.resolve()
        .then(() => run(message))
        .catch((error: unknown) => {
            console.warn('[EBook frame]', error)
            if (message.type === 'open') post({ type: 'failed', reason: 'unreadable' })
        })
})

window.addEventListener('keydown', reportKey)
// The margins around a section's frame are this document's own, and a click in the frame does not reach it.
document.addEventListener('click', (event) => reportTap(event, document, 0, 0))
post({ type: 'ready', protocol: EBOOK_FRAME_PROTOCOL })
