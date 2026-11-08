/**
 * What the app and the page an EBook reads in say to each other (ADR 0181). The page is treated as
 * hostile: an EBook is anyone's HTML, so although no script in one should run, everything that comes
 * from the frame is checked here before the app acts on it, as stored data is.
 */
import type { EbookSettings, FrameFont, PageColours } from './ebook-settings'
import { isEbookCfi } from './ebook-state'

/** A build's frame and app talk only if they agree on this. A long-open tab can meet a newer frame. */
export const EBOOK_FRAME_PROTOCOL = 1

export interface TocEntry {
    label: string
    href: string
    /** 0 for a top-level entry. */
    depth: number
}

export interface FrameHighlight {
    cfi: string
    colour: string
    /** Drawn with a mark that says a note is attached. */
    hasNote: boolean
}

export interface SearchMatch {
    cfi: string
    before: string
    match: string
    after: string
}

export type AppToFrame =
    | { type: 'open'; bytes: ArrayBuffer; place: string | null; settings: EbookSettings; colours: PageColours; highlights: FrameHighlight[]; bookmarks: string[] }
    | { type: 'next' }
    | { type: 'previous' }
    | { type: 'back' }
    | { type: 'forward' }
    | { type: 'goTo'; target: string }
    | { type: 'goToFraction'; fraction: number }
    | { type: 'settings'; settings: EbookSettings; colours: PageColours }
    | { type: 'fonts'; fonts: FrameFont[] }
    /** How large a fixed-layout EBook's pages are: fit the view, or a scale where 1 is the EBook's own size. */
    | { type: 'zoom'; zoom: 'fit-page' | number }
    | { type: 'marks'; highlights: FrameHighlight[]; bookmarks: string[] }
    | { type: 'search'; id: number; query: string }
    | { type: 'clearSearch' }
    | { type: 'clearSelection' }
    /** Read aloud from the place in view. The frame answers each with the sentence to speak. */
    | { type: 'readFromHere' }
    | { type: 'readNext' }
    | { type: 'readStop' }

export interface OpenedEbook {
    type: 'opened'
    title: string
    author: string
    toc: TocEntry[]
    direction: 'ltr' | 'rtl'
    fixedLayout: boolean
    hasPrintPages: boolean
}

export interface Relocated {
    type: 'relocate'
    cfi: string
    fraction: number
    chapter: string | null
    minutesLeftInChapter: number | null
    minutesLeftInEbook: number | null
    printPage: string | null
    /** Where the person was before a jump, while they have not gone back or read on. */
    backTo: number | null
    canGoForward: boolean
    /** The bookmarks in view, of those the app sent. */
    bookmarksHere: string[]
}

export interface SelectionChanged {
    type: 'selection'
    text: string
    cfi: string | null
    chapter: string | null
    fraction: number
}

export type FrameToApp =
    | { type: 'ready'; protocol: number }
    | OpenedEbook
    | { type: 'failed'; reason: 'protected' | 'unreadable' }
    | Relocated
    | SelectionChanged
    | { type: 'tap'; xShare: number; yShare: number }
    | { type: 'key'; key: string; code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }
    | { type: 'externalLink'; href: string }
    | { type: 'highlightPressed'; cfi: string }
    | { type: 'searchResults'; id: number; chapter: string; matches: SearchMatch[] }
    | { type: 'searchDone'; id: number }
    /** The sentence to speak, or null at the end of the EBook. */
    | { type: 'speak'; text: string | null; lang: string }

const MAX_LABEL = 500
const MAX_CFI = 2000
const MAX_TEXT = 20_000
const MAX_TOC = 5000
const MAX_MATCHES = 2000

type Fields = Record<string, unknown>

const text = (value: unknown, max: number): string | null => (typeof value === 'string' ? value.slice(0, max) : null)
const required = (value: unknown, max: number): string | null => {
    const clean = text(value, max)
    return clean === null || clean === '' ? null : clean
}
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const share = (value: unknown): number | null => {
    const number = finite(value)
    return number === null ? null : Math.min(1, Math.max(0, number))
}
const isCfi = isEbookCfi
const strings = (value: unknown, keep: (entry: unknown) => boolean, max: number): string[] =>
    Array.isArray(value) ? (value.filter(keep).slice(0, max) as string[]) : []

function tocEntry(raw: unknown): TocEntry | null {
    if (typeof raw !== 'object' || raw === null) return null
    const { label, href, depth } = raw as Fields
    const cleanLabel = text(label, MAX_LABEL)
    const cleanHref = required(href, MAX_CFI)
    const cleanDepth = finite(depth)
    if (cleanLabel === null || cleanHref === null || cleanDepth === null) return null
    return { label: cleanLabel, href: cleanHref, depth: Math.min(8, Math.max(0, Math.trunc(cleanDepth))) }
}

function searchMatch(raw: unknown): SearchMatch | null {
    if (typeof raw !== 'object' || raw === null) return null
    const { cfi, before, match, after } = raw as Fields
    if (!isCfi(cfi)) return null
    return { cfi, before: text(before, MAX_LABEL) ?? '', match: text(match, MAX_LABEL) ?? '', after: text(after, MAX_LABEL) ?? '' }
}

const present = <T>(list: (T | null)[]): T[] => list.filter((entry): entry is T => entry !== null)

function opened(m: Fields): FrameToApp {
    return {
        type: 'opened',
        title: text(m.title, MAX_LABEL) ?? '',
        author: text(m.author, MAX_LABEL) ?? '',
        toc: Array.isArray(m.toc) ? present(m.toc.slice(0, MAX_TOC).map(tocEntry)) : [],
        direction: m.direction === 'rtl' ? 'rtl' : 'ltr',
        fixedLayout: m.fixedLayout === true,
        hasPrintPages: m.hasPrintPages === true,
    }
}

function relocate(m: Fields): FrameToApp | null {
    const fraction = share(m.fraction)
    if (!isCfi(m.cfi) || fraction === null) return null
    return {
        type: 'relocate',
        cfi: m.cfi,
        fraction,
        chapter: text(m.chapter, MAX_LABEL),
        minutesLeftInChapter: finite(m.minutesLeftInChapter),
        minutesLeftInEbook: finite(m.minutesLeftInEbook),
        printPage: text(m.printPage, MAX_LABEL),
        backTo: share(m.backTo),
        canGoForward: m.canGoForward === true,
        bookmarksHere: strings(m.bookmarksHere, isCfi, MAX_TOC),
    }
}

function selection(m: Fields): FrameToApp | null {
    const selected = text(m.text, MAX_TEXT)
    if (selected === null) return null
    return { type: 'selection', text: selected, cfi: isCfi(m.cfi) ? m.cfi : null, chapter: text(m.chapter, MAX_LABEL), fraction: share(m.fraction) ?? 0 }
}

function tap(m: Fields): FrameToApp | null {
    const xShare = share(m.xShare)
    const yShare = share(m.yShare)
    return xShare === null || yShare === null ? null : { type: 'tap', xShare, yShare }
}

function key(m: Fields): FrameToApp | null {
    const name = required(m.key, 40)
    if (name === null) return null
    return { type: 'key', key: name, code: text(m.code, 40) ?? '', ctrlKey: m.ctrlKey === true, metaKey: m.metaKey === true, shiftKey: m.shiftKey === true, altKey: m.altKey === true }
}

function searchResults(m: Fields): FrameToApp | null {
    const id = finite(m.id)
    if (id === null || !Array.isArray(m.matches)) return null
    return { type: 'searchResults', id, chapter: text(m.chapter, MAX_LABEL) ?? '', matches: present(m.matches.slice(0, MAX_MATCHES).map(searchMatch)) }
}

/** An address a person can be asked about: never a script, a data page or a file on their device. */
export function isOpenableLink(href: string): boolean {
    return /^(?:https?:|mailto:)/i.test(href)
}

const READERS: Record<string, (m: Fields) => FrameToApp | null> = {
    ready: (m) => (finite(m.protocol) === null ? null : { type: 'ready', protocol: m.protocol as number }),
    opened,
    failed: (m) => ({ type: 'failed', reason: m.reason === 'protected' ? 'protected' : 'unreadable' }),
    relocate,
    selection,
    tap,
    key,
    externalLink: (m) => {
        const href = required(m.href, MAX_CFI)
        return href !== null && isOpenableLink(href) ? { type: 'externalLink', href } : null
    },
    highlightPressed: (m) => (isCfi(m.cfi) ? { type: 'highlightPressed', cfi: m.cfi } : null),
    searchResults,
    searchDone: (m) => (finite(m.id) === null ? null : { type: 'searchDone', id: m.id as number }),
    speak: (m) => ({ type: 'speak', text: text(m.text, MAX_TEXT), lang: text(m.lang, 40) ?? '' }),
}

/** What the frame said, checked, or null for anything else. */
export function readFrameMessage(raw: unknown): FrameToApp | null {
    if (typeof raw !== 'object' || raw === null) return null
    const message = raw as Fields
    const read = typeof message.type === 'string' && Object.hasOwn(READERS, message.type) ? READERS[message.type] : null
    return read ? read(message) : null
}
