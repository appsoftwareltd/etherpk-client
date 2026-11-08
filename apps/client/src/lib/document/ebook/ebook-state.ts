/**
 * What a person has done to one EBook: their highlights, the notes on them, and their [[Reading
 * Place]]. None of it is in the EBook, whose bytes never change, because an [[Asset]] is identified by
 * its content (ADR 0175). It is stored under the SHA-256 of the EBook's bytes, which stays the same
 * through an [[Export]], an [[Import]] and a move between backends.
 *
 * A place is an EPUB CFI, a published way of naming a spot in an EBook's text. A CFI usually breaks when
 * a publisher reissues an EBook with changed markup. Here a new edition is a new hash, so it holds across
 * devices, layouts and text sizes. `text` is kept beside it for the panel, and so a passage can still
 * be found by its words if a library update moves a CFI in a format with no CFIs of its own.
 */
export interface EbookHighlight {
    id: string
    /** A CFI range. */
    cfi: string
    /** `#rrggbb`. */
    colour: string
    text: string
    /** What the person wrote about it. */
    note?: string
    /** The chapter it is in, as the EBook's contents names it. */
    chapter?: string
    /** How far through the EBook it is, from 0 to 1. Sorts and labels a row without opening the EBook. */
    fraction: number
    createdAt: number
    updatedAt: number
}

/** Where a person has reached, and when. */
export interface EbookPlace {
    cfi: string
    fraction: number
    at: number
}

export interface EbookState {
    highlights: EbookHighlight[]
    place?: EbookPlace
}

export const emptyEbookState = (): EbookState => ({ highlights: [] })

/** Longest note or quote kept, so a hostile file cannot swamp the reader. */
export const MAX_EBOOK_TEXT = 20_000

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isShare = (value: unknown): value is number => isNumber(value) && value >= 0 && value <= 1
/**
 * A place in an EBook. An element's id is part of one, and an id can hold spaces or quotes, so the shape is
 * checked and not the characters. It only ever goes back to the frame or into a percent-encoded link.
 */
export const isEbookCfi = (value: unknown): value is string => typeof value === 'string' && value.length <= 2000 && /^epubcfi\(\P{Cc}+\)$/u.test(value)
const isColour = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
const optionalText = (key: string, value: unknown) => (typeof value === 'string' && value !== '' ? { [key]: value.slice(0, MAX_EBOOK_TEXT) } : {})

function hasHighlightBasics(r: Record<string, unknown>): boolean {
    return typeof r.id === 'string' && r.id !== '' && isEbookCfi(r.cfi) && isColour(r.colour) && typeof r.text === 'string' && isShare(r.fraction) && isNumber(r.createdAt) && isNumber(r.updatedAt)
}

/** A clean highlight from whatever was stored, or `null` for one that cannot be read. */
export function sanitizeEbookHighlight(raw: unknown): EbookHighlight | null {
    if (typeof raw !== 'object' || raw === null) return null
    const r = raw as Record<string, unknown>
    if (!hasHighlightBasics(r)) return null
    const { id, cfi, colour, text, fraction, createdAt, updatedAt } = r as unknown as EbookHighlight
    return {
        id,
        cfi,
        colour,
        text: text.slice(0, MAX_EBOOK_TEXT),
        fraction,
        createdAt,
        updatedAt,
        ...optionalText('note', r.note),
        ...optionalText('chapter', r.chapter),
    }
}

export function sanitizeEbookPlace(raw: unknown): EbookPlace | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined
    const { cfi, fraction, at } = raw as Record<string, unknown>
    if (!isEbookCfi(cfi) || !isShare(fraction) || !isNumber(at)) return undefined
    return { cfi, fraction, at }
}

/** Keep what can be read of a stored state: a damaged entry is dropped, the rest stay. */
export function sanitizeEbookState(raw: unknown): EbookState {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const highlights = Array.isArray(r.highlights) ? r.highlights.map(sanitizeEbookHighlight).filter((entry) => entry !== null) : []
    const place = sanitizeEbookPlace(r.place)
    return { highlights, ...(place ? { place } : {}) }
}

/** One EBook's state on the open graph. Every write shows at once and is saved behind the scenes. */
export interface EbookStateStore {
    state(): EbookState
    /** Fires on any change, local or from another device. Returns an unsubscribe. */
    subscribe(listener: () => void): () => void
    putHighlight(highlight: EbookHighlight): void
    removeHighlight(id: string): void
    setPlace(place: EbookPlace): void
    /** A reason every write is being refused, shown to the person; `null` when saving works. */
    problem(): string | null
    flush(): Promise<void>
    close(): Promise<void>
}

/** Reaches the stores of the open graph, for whichever backend it is on. */
export interface EbookStateHost {
    open(hash: string): Promise<EbookStateStore>
    /** Delete an EBook's state for good, with the EBook itself. */
    forget(hash: string): Promise<void>
}

/** The store of a synced graph opened with no member key, which has no person to keep it for. */
export function refusingEbookState(reason: string): EbookStateStore {
    const state = emptyEbookState()
    return {
        state: () => state,
        subscribe: () => () => {},
        putHighlight: () => {},
        removeHighlight: () => {},
        setPlace: () => {},
        problem: () => reason,
        flush: async () => {},
        close: async () => {},
    }
}

/** What an EBook tab asks of the open graph beyond asset operations, which it shares with a PDF's. */
export interface EbookGraphService {
    state: EbookStateHost
}
