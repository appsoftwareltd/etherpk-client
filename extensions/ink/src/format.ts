/**
 * An Ink drawing as the document keeps it: an Extension Fence (` ```ink.drawing `) whose body is
 * one JSON object per line, so a person or a coding agent can read it and two devices' strokes
 * merge as lines of their own.
 *
 * ```text
 * {"type":"ink.drawing","version":1,"id":"k3v9q0m2xa","paper":"dots"}
 * {"id":"p0c8w1ze","tool":"pen","colour":"#1e1e1e","size":4,"pts":[10,12.5,0.42, 14.2,13,0.5]}
 * ```
 *
 * - **The header** is the first line: the format's version, the drawing's own id (which the Client
 *   finds it by in a tab or the full window) and its paper (`plain`, `dots` or `lines`). Without
 *   one the drawing is still drawn, as version 1 on plain paper, with no id.
 * - **A stroke** is a line of its own: its id, its tool (`pen` or `highlighter`), its colour as
 *   `#rrggbb`, its width in pixels, and its points as a flat list of `x, y, pressure` triples, x and
 *   y rounded to a tenth of a pixel and pressure (0 to 1) to two places. A stroke whose every
 *   pressure is exactly 0.5 was drawn without pressure (a mouse, a finger) and is drawn with
 *   pressure worked out from its speed (`outline.ts`).
 * - **Lines that cannot be read** are kept as written and left out of the drawing. Of two lines
 *   with the same stroke id, the later one is the stroke.
 * - **A newer version** than this extension knows is drawn as nothing editable, so it is never
 *   written in a shape the newer version would misread.
 *
 * Colours are literal: the paper is always white, in both themes and on published sites.
 */

/** The fence's info word: an Extension Fence of the `ink` extension (ADR 0138). */
export const INK_FENCE = 'ink.drawing'

/** The format version this extension reads and writes. */
export const INK_VERSION = 1

export type InkPaper = 'plain' | 'dots' | 'lines'
export type InkTool = 'pen' | 'highlighter'

export const PAPERS: readonly InkPaper[] = ['plain', 'dots', 'lines']

/** The pressure a stroke drawn without pressure carries on every point. */
export const NO_PRESSURE = 0.5

export interface InkHeader {
    version: number
    /** The drawing's own id, or null when the header has none (or there is no header). */
    id: string | null
    paper: InkPaper
}

export interface InkStroke {
    id: string
    tool: InkTool
    colour: string
    size: number
    /** Flat `x, y, pressure` triples. */
    pts: number[]
}

/** A stroke and the body line it was read from. */
export interface InkStrokeLine {
    stroke: InkStroke
    /** The body line the stroke is read from (0-based). */
    line: number
    /** The line's text, as an edit expects it. */
    text: string
    /** Earlier lines with the same id, which this one hides: removed with it when it is erased. */
    hidden: { line: number; text: string }[]
}

export interface InkDrawing {
    header: InkHeader
    /** The header's body line and text, or null when there is none. */
    headerLine: { line: number; text: string } | null
    /** True when the header names a version newer than this extension reads. */
    newer: boolean
    /** The strokes, in the order they are drawn (each at its own line's place). */
    strokes: InkStrokeLine[]
}

export interface PaletteColour {
    name: string
    hex: string
}

/** The pens' colours. */
export const PEN_COLOURS: readonly PaletteColour[] = [
    { name: 'Black', hex: '#1e1e1e' },
    { name: 'Grey', hex: '#6b7280' },
    { name: 'Red', hex: '#e03131' },
    { name: 'Blue', hex: '#1971c2' },
    { name: 'Green', hex: '#2f9e44' },
    { name: 'Orange', hex: '#f08c00' },
    { name: 'Purple', hex: '#9c36b5' },
]

/** The highlighters' colours, drawn translucent beneath the pens. */
export const HIGHLIGHTER_COLOURS: readonly PaletteColour[] = [
    { name: 'Yellow', hex: '#ffd43b' },
    { name: 'Green', hex: '#8ce99a' },
    { name: 'Pink', hex: '#faa2c1' },
    { name: 'Blue', hex: '#a5d8ff' },
]

/** Each tool's three widths, thin to thick. */
export const WIDTHS: Readonly<Record<InkTool, readonly [number, number, number]>> = {
    pen: [2, 4, 8],
    highlighter: [12, 20, 32],
}

/** How opaque a highlighter is. */
export const HIGHLIGHTER_OPACITY = 0.35

const HEX_COLOUR = /^#[0-9a-f]{6}$/
const MAX_ID_LENGTH = 64
const BASE_36 = '0123456789abcdefghijklmnopqrstuvwxyz'

/** A random id of `length` base-36 characters. */
export function newId(length: number, random: (count: number) => Uint8Array = randomBytes): string {
    const bytes = random(length)
    let id = ''
    // 252 is the largest multiple of 36 under 256: bytes above it are re-drawn so every character is
    // as likely as every other.
    for (let i = 0; id.length < length; i++) {
        const byte = i < bytes.length ? bytes[i] : randomBytes(1)[0]
        if (byte < 252) id += BASE_36[byte % 36]
    }
    return id
}

function randomBytes(count: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(count))
}

export const newDrawingId = (): string => newId(10)
export const newStrokeId = (): string => newId(8)

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseLine(text: string): unknown {
    try {
        return JSON.parse(text)
    } catch {
        return undefined
    }
}

/** A header line's content, or null when the line is not a header. */
function readHeader(value: unknown): InkHeader | null {
    if (!isRecord(value) || value.type !== INK_FENCE) return null
    const version = typeof value.version === 'number' && Number.isInteger(value.version) && value.version > 0 ? value.version : INK_VERSION
    const id = typeof value.id === 'string' && value.id.trim() !== '' && value.id.length <= MAX_ID_LENGTH ? value.id : null
    const paper = PAPERS.includes(value.paper as InkPaper) ? (value.paper as InkPaper) : 'plain'
    return { version, id, paper }
}

/** A stroke line's content, or null when the line is not a stroke this version can draw. */
export function readStroke(value: unknown): InkStroke | null {
    if (!isRecord(value)) return null
    const { id, tool, colour, size, pts } = value
    if (typeof id !== 'string' || id === '' || id.length > MAX_ID_LENGTH) return null
    if (tool !== 'pen' && tool !== 'highlighter') return null
    if (typeof colour !== 'string' || !HEX_COLOUR.test(colour.toLowerCase())) return null
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return null
    if (!Array.isArray(pts) || pts.length < 3 || pts.length % 3 !== 0) return null
    if (!pts.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
    return { id, tool, colour: colour.toLowerCase(), size, pts: pts as number[] }
}

const DEFAULT_HEADER: InkHeader = { version: INK_VERSION, id: null, paper: 'plain' }

/** The drawing a fence's body holds. */
export function readInk(body: readonly string[]): InkDrawing {
    let header: InkHeader | null = null
    let headerLine: InkDrawing['headerLine'] = null
    const byId = new Map<string, InkStrokeLine>()
    body.forEach((text, line) => {
        if (text.trim() === '') return
        const value = parseLine(text)
        if (header === null) {
            const read = readHeader(value)
            if (read) {
                header = read
                headerLine = { line, text }
                return
            }
        }
        const stroke = readStroke(value)
        if (!stroke) return
        const earlier = byId.get(stroke.id)
        // The later line is the stroke: the earlier is hidden behind it, and goes when it is erased.
        if (earlier) byId.delete(stroke.id)
        byId.set(stroke.id, { stroke, line, text, hidden: earlier ? [...earlier.hidden, { line: earlier.line, text: earlier.text }] : [] })
    })
    const read: InkHeader = header ?? DEFAULT_HEADER
    return {
        header: read,
        headerLine,
        newer: read.version > INK_VERSION,
        strokes: [...byId.values()].sort((a, b) => a.line - b.line),
    }
}

/** The drawing's own id, for the Client to find it by in a tab or the full window. */
export function identifyInk(body: readonly string[]): string | null {
    for (const text of body) {
        if (text.trim() === '') continue
        return readHeader(parseLine(text))?.id ?? null
    }
    return null
}

/** A number rounded to `places` decimal places, never written as `-0`. */
export function rounded(value: number, places: number): number {
    const factor = 10 ** places
    const result = Math.round(value * factor) / factor
    return result === 0 ? 0 : result
}

/** A pressure as stored: 0 to 1, two places. */
function pressure(value: number): number {
    return rounded(Math.min(1, Math.max(0, value)), 2)
}

/** The points as stored: x and y to a tenth of a pixel, pressure to two places. */
export function roundedPoints(pts: readonly number[]): number[] {
    const out: number[] = []
    for (let i = 0; i + 2 < pts.length; i += 3) out.push(rounded(pts[i], 1), rounded(pts[i + 1], 1), pressure(pts[i + 2]))
    return out
}

/** A stroke as its body line: keys in a fixed order, numbers rounded. */
export function strokeLine(stroke: InkStroke): string {
    return JSON.stringify({ id: stroke.id, tool: stroke.tool, colour: stroke.colour, size: rounded(stroke.size, 1), pts: roundedPoints(stroke.pts) })
}

/** A header as its body line. */
export function headerLine(header: { id: string; paper: InkPaper }): string {
    return JSON.stringify({ type: INK_FENCE, version: INK_VERSION, id: header.id, paper: header.paper })
}

/** A new, empty drawing's fence, for `insertBlock`. */
export function newInkText(id: string = newDrawingId()): string {
    return ['```' + INK_FENCE, headerLine({ id, paper: 'plain' }), '```'].join('\n')
}

/** Whether a stroke was drawn without pressure, so its pressure is worked out from its speed. */
export function withoutPressure(stroke: Pick<InkStroke, 'pts'>): boolean {
    for (let i = 2; i < stroke.pts.length; i += 3) if (stroke.pts[i] !== NO_PRESSURE) return false
    return true
}

/** What a picture of the drawing shows, for anyone who cannot see it. */
export function inkAlt(drawing: InkDrawing): string {
    const count = drawing.strokes.length
    if (count === 0) return 'Ink drawing, empty'
    return `Ink drawing, ${count} ${count === 1 ? 'stroke' : 'strokes'}`
}
