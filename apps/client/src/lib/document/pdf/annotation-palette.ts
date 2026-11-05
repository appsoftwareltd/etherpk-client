/**
 * What a [[PDF Annotation]] can be drawn with. The colours start from the pastels Graph Settings
 * offers, so a graph's colours and its annotations read as one set. Black, white and the three
 * primaries are here alone: a pastel reads poorly as ink on a white page, and a graph has no use for them.
 */
import { PRESENCE_PALETTE } from '#lib/sync/presence-identity.js'

export interface AnnotationColour {
    label: string
    colour: string
}

export const DEFAULT_INK = '#171717'
/** The palette's yellow, the colour a person expects of a highlighter. */
export const DEFAULT_HIGHLIGHT = '#fcd34d'
/** What the colour picker opens on until a person has chosen a colour of their own. */
export const DEFAULT_CUSTOM = '#8b5cf6'

export const ANNOTATION_COLOURS: readonly AnnotationColour[] = [
    { label: 'Black', colour: DEFAULT_INK },
    { label: 'White', colour: '#ffffff' },
    { label: 'Red', colour: '#dc2626' },
    { label: 'Blue', colour: '#2563eb' },
    { label: 'Green', colour: '#16a34a' },
    ...PRESENCE_PALETTE.map(({ label, color }) => ({ label, colour: color })),
]

export type DrawingTool = 'pen' | 'highlighter'

/** In PDF points, thin to thick. A highlighter's are wider because it has to cover a line of text. */
export const STROKE_WIDTHS: Record<DrawingTool, readonly number[]> = {
    pen: [0.8, 1.4, 2.4, 4],
    highlighter: [6, 12, 18, 28],
}
export const STROKE_WIDTH_NAMES = ['Fine line', 'Medium line', 'Thick line', 'Very thick line'] as const

const DEFAULT_WIDTHS: Record<DrawingTool, number> = { pen: 1.4, highlighter: 12 }

/** A colour's name for a screen reader. A custom colour has none but its value. */
export function colourName(colour: string): string {
    return ANNOTATION_COLOURS.find((each) => each.colour === colour)?.label ?? colour
}

/** A remembered value is whatever was in this device's storage, so it is checked before it is drawn with. */
export function knownColour(value: unknown, fallback: string): string {
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
}

export function knownStrokeWidth(tool: DrawingTool, value: unknown): number {
    return typeof value === 'number' && STROKE_WIDTHS[tool].includes(value) ? value : DEFAULT_WIDTHS[tool]
}
