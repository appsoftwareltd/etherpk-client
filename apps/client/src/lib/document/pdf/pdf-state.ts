/**
 * What a person has done to one PDF: their [[PDF Annotation]]s, form values and
 * [[Reading Place]] (CONTEXT.md). None of it is in the PDF, whose bytes never change, because an
 * [[Asset]] is identified by its content. A person writes it into a file with **Save a copy**.
 *
 * It is stored under the SHA-256 of the PDF's bytes, which stays the same through an [[Export]], an
 * [[Import]] and a move between backends, where an Asset's own identity does not. The schema here is
 * EtherPK's own rather than pdf.js's, because stored data outlives any version of pdf.js.
 * Coordinates are PDF points, with the origin at the page's bottom left, whatever the zoom.
 */
import type { ReadingPlace } from './device-memory'

export type { ReadingPlace }

interface AnnotationBase {
    id: string
    /** 1-based. */
    page: number
    /** `#rrggbb`. */
    colour: string
    createdAt: number
    updatedAt: number
}

/** Text a person selected and highlighted. One quad per line, eight numbers each. */
export interface PdfHighlight extends AnnotationBase {
    kind: 'highlight'
    quads: number[]
    /** The words highlighted, when the PDF is not password-protected. */
    text?: string
}

/** A line drawn with the pen or the freehand highlighter: x, y, x, y… */
export interface PdfStroke extends AnnotationBase {
    kind: 'stroke'
    tool: 'pen' | 'highlighter'
    width: number
    points: number[]
    /** A stylus's pressure at each point, from 0 to 1. Without them the line is one width. */
    pressures?: number[]
}

/** A note typed on the page, by the top left corner of its box. */
export interface PdfNote extends AnnotationBase {
    kind: 'note'
    x: number
    y: number
    fontSize: number
    text: string
}

export type PdfAnnotation = PdfHighlight | PdfStroke | PdfNote

/** A form field's value as pdf.js's annotation storage holds it. */
export type FormValue = Record<string, unknown>

export interface PdfState {
    annotations: PdfAnnotation[]
    forms: Record<string, FormValue>
    place?: ReadingPlace
}

export const emptyPdfState = (): PdfState => ({ annotations: [], forms: {} })

/** Longest note kept, and most numbers in a stroke, so a hostile file cannot swamp the viewer. */
export const MAX_NOTE_LENGTH = 10_000
const MAX_POINTS = 100_000

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isNumberList = (value: unknown): value is number[] => Array.isArray(value) && value.every(isNumber)
const isPageNumber = (value: unknown): value is number => isNumber(value) && Number.isInteger(value) && value >= 1
const isColour = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)

function baseOf(r: Record<string, unknown>): AnnotationBase | null {
    if (typeof r.id !== 'string' || r.id === '') return null
    if (!isPageNumber(r.page) || !isColour(r.colour)) return null
    if (!isNumber(r.createdAt) || !isNumber(r.updatedAt)) return null
    return { id: r.id, page: r.page, colour: r.colour, createdAt: r.createdAt, updatedAt: r.updatedAt }
}

function highlightOf(base: AnnotationBase, r: Record<string, unknown>): PdfHighlight | null {
    if (!isNumberList(r.quads) || r.quads.length === 0 || r.quads.length % 8 !== 0) return null
    return { ...base, kind: 'highlight', quads: r.quads, ...(typeof r.text === 'string' ? { text: r.text } : {}) }
}

function isStrokePoints(value: unknown): value is number[] {
    return isNumberList(value) && value.length >= 2 && value.length % 2 === 0 && value.length <= MAX_POINTS
}

/** Pressures that do not fit their points are dropped, and the stroke still draws as an even line. */
function strokePressures(value: unknown, count: number): number[] | null {
    const fits = isNumberList(value) && value.length === count && value.every((pressure) => pressure >= 0 && pressure <= 1)
    return fits ? value : null
}

function strokeOf(base: AnnotationBase, r: Record<string, unknown>): PdfStroke | null {
    if (r.tool !== 'pen' && r.tool !== 'highlighter') return null
    if (!isNumber(r.width) || r.width <= 0 || !isStrokePoints(r.points)) return null
    const pressures = strokePressures(r.pressures, r.points.length / 2)
    return { ...base, kind: 'stroke', tool: r.tool, width: r.width, points: r.points, ...(pressures ? { pressures } : {}) }
}

function noteOf(base: AnnotationBase, r: Record<string, unknown>): PdfNote | null {
    if (!isNumber(r.x) || !isNumber(r.y) || !isNumber(r.fontSize) || r.fontSize <= 0) return null
    if (typeof r.text !== 'string' || r.text.length > MAX_NOTE_LENGTH) return null
    return { ...base, kind: 'note', x: r.x, y: r.y, fontSize: r.fontSize, text: r.text }
}

const READERS: Record<string, (base: AnnotationBase, r: Record<string, unknown>) => PdfAnnotation | null> = {
    highlight: highlightOf,
    stroke: strokeOf,
    note: noteOf,
}

/** A clean annotation from whatever was stored, or `null` for one that cannot be read. */
export function sanitizeAnnotation(raw: unknown): PdfAnnotation | null {
    if (typeof raw !== 'object' || raw === null) return null
    const r = raw as Record<string, unknown>
    const base = baseOf(r)
    const read = typeof r.kind === 'string' && Object.hasOwn(READERS, r.kind) ? READERS[r.kind] : null
    return base && read ? read(base, r) : null
}

export function sanitizePlace(raw: unknown): ReadingPlace | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined
    const r = raw as Record<string, unknown>
    if (!isPageNumber(r.page)) return undefined
    if (!isNumber(r.offset) || !isNumber(r.at)) return undefined
    return { page: r.page, offset: Math.min(1, Math.max(0, r.offset)), at: r.at }
}

/** Keep what can be read of a stored state: a damaged entry is dropped, the rest stay. */
export function sanitizePdfState(raw: unknown): PdfState {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const list = <T>(value: unknown, clean: (entry: unknown) => T | null): T[] =>
        Array.isArray(value) ? value.map(clean).filter((entry): entry is NonNullable<typeof entry> => entry !== null) : []
    const forms: Record<string, FormValue> = {}
    if (typeof r.forms === 'object' && r.forms !== null) {
        for (const [key, value] of Object.entries(r.forms)) {
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) forms[key] = value as FormValue
        }
    }
    const place = sanitizePlace(r.place)
    return {
        annotations: list(r.annotations, sanitizeAnnotation),
        forms,
        ...(place ? { place } : {}),
    }
}

/** One PDF's state on the open graph. Every write shows at once and is saved behind the scenes. */
export interface PdfStateStore {
    state(): PdfState
    /** Fires on any change, local or from another device. Returns an unsubscribe. */
    subscribe(listener: () => void): () => void
    putAnnotation(annotation: PdfAnnotation): void
    removeAnnotation(id: string): void
    setPlace(place: ReadingPlace): void
    /** `undefined` clears the field. */
    setFormValue(fieldId: string, value: FormValue | undefined): void
    /** A reason every write is being refused, shown to the person; `null` when saving works. */
    problem(): string | null
    /** Fires when {@link problem} changes. */
    flush(): Promise<void>
    close(): Promise<void>
}

/** Reaches the stores of the open graph, for whichever backend it is on. */
export interface PdfStateHost {
    open(hash: string): Promise<PdfStateStore>
    /** Delete a PDF's state for good, with the PDF itself. */
    forget(hash: string): Promise<void>
}

/** A new annotation id. */
export function newPdfStateId(): string {
    return crypto.randomUUID()
}
