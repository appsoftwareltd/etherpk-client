/**
 * Pure parsing of an image's **display size** — the rendered width/height on screen,
 * distinct from the file's byte size. It is expressed as a hint in the alt text
 * (`![alt|300](url)`, `![alt|640x480](url)`) and is always a **maximum**: the image
 * scales down to fit, never up. Ported from the AS Notes inline editor. We use the
 * standard-markdown alt form (not Obsidian's `![[img|300]]` embed) because CONTEXT.md →
 * Wikilink bans `|`-label syntax.
 *
 * No CodeMirror or DOM imports, so the boundary rules are unit-tested directly.
 */

/** Matches a display-size hint at the end of alt text: `|300` or `|300x200` (with optional trailing space). */
const DISPLAY_SIZE_HINT_REGEX = /\|(\d{1,5})(?:[xX](\d{1,5}))?\s*$/

/** Matches a bare display-size spec (the value that goes after the `|`): `300` or `300x200`. */
const DISPLAY_SIZE_REGEX = /^(\d{1,5})(?:[xX](\d{1,5}))?$/

/** Parse a bare display-size spec (no leading `|`) into its dimensions, or `null` when invalid. */
export function parseDisplaySize(spec: string): { width: number; height?: number } | null {
    const match = DISPLAY_SIZE_REGEX.exec(spec.trim())
    if (!match) return null
    const width = parseInt(match[1], 10)
    if (!Number.isFinite(width) || width < 1) return null
    if (match[2] === undefined) return { width }
    const height = parseInt(match[2], 10)
    if (!Number.isFinite(height) || height < 1) return null
    return { width, height }
}

/** Canonical form of a valid display-size spec (lower-case `x`, no whitespace), or `null` when invalid. */
export function normalizeDisplaySize(spec: string): string | null {
    const parsed = parseDisplaySize(spec)
    if (!parsed) return null
    return parsed.height === undefined ? `${parsed.width}` : `${parsed.width}x${parsed.height}`
}

export interface ParsedAlt {
    /** The alt text with any display-size hint stripped — what the user sees as the image label. */
    cleanAlt: string
    /** Maximum display width in px, when a valid hint is present (the image scales down to fit, never up). */
    maxWidth?: number
    /** Maximum display height in px, when the hint gives one. */
    maxHeight?: number
}

/** Parse the alt text into its clean label and any display-size hint. A width < 1 (or no hint) yields no dimensions. */
export function parseImageDisplaySizeHint(alt: string): ParsedAlt {
    const match = DISPLAY_SIZE_HINT_REGEX.exec(alt)
    if (!match) return { cleanAlt: alt }
    const maxWidth = parseInt(match[1], 10)
    if (!Number.isFinite(maxWidth) || maxWidth < 1) return { cleanAlt: alt }
    const cleanAlt = alt.slice(0, match.index)
    const parsed: ParsedAlt = { cleanAlt, maxWidth }
    if (match[2] !== undefined) {
        const maxHeight = parseInt(match[2], 10)
        if (Number.isFinite(maxHeight) && maxHeight >= 1) parsed.maxHeight = maxHeight
    }
    return parsed
}
