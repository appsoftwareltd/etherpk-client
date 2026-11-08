/**
 * How a person likes an EBook's pages: text size, spacing, margins and so on. One set for the device,
 * because a size that suits a phone is wrong on a desktop, and every EBook takes it, as an e-reader's
 * settings do. The frame turns them into a stylesheet ({@link pageStyles}).
 */
export type EbookFlow = 'paginated' | 'scrolled'
export type EbookFont = 'original' | 'serif' | 'sans' | 'literata' | 'atkinson'
export type EbookPageTheme = 'app' | 'light' | 'dark'

export interface EbookSettings {
    flow: EbookFlow
    /** CSS pixels. */
    fontSize: number
    lineHeight: number
    /** The space beside the text, in CSS pixels. */
    margin: number
    justify: boolean
    hyphenate: boolean
    font: EbookFont
    /** Two pages side by side where the window has the room. */
    twoPages: boolean
    theme: EbookPageTheme
}

export const DEFAULT_EBOOK_SETTINGS: EbookSettings = {
    flow: 'paginated',
    fontSize: 18,
    lineHeight: 1.5,
    margin: 48,
    justify: false,
    hyphenate: false,
    font: 'original',
    twoPages: true,
    theme: 'app',
}

/** At least the 14px every piece of text in the app keeps to (ADR 0106). */
export const FONT_SIZE_RANGE = { min: 14, max: 40, step: 2 } as const
export const LINE_HEIGHT_RANGE = { min: 1.2, max: 2.2, step: 0.1 } as const
export const MARGIN_RANGE = { min: 8, max: 96, step: 8 } as const

type Range = { readonly min: number; readonly max: number }

const inRange = (value: unknown, range: Range, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(range.max, Math.max(range.min, value)) : fallback

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback)

const flag = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

/** Settings as stored on the device, which could hold anything: each is checked on its own. */
export function sanitizeEbookSettings(raw: unknown): EbookSettings {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const d = DEFAULT_EBOOK_SETTINGS
    return {
        flow: oneOf(r.flow, ['paginated', 'scrolled'], d.flow),
        fontSize: inRange(r.fontSize, FONT_SIZE_RANGE, d.fontSize),
        lineHeight: inRange(r.lineHeight, LINE_HEIGHT_RANGE, d.lineHeight),
        margin: inRange(r.margin, MARGIN_RANGE, d.margin),
        justify: flag(r.justify, d.justify),
        hyphenate: flag(r.hyphenate, d.hyphenate),
        font: oneOf(r.font, ['original', 'serif', 'sans', 'literata', 'atkinson'], d.font),
        twoPages: flag(r.twoPages, d.twoPages),
        theme: oneOf(r.theme, ['app', 'light', 'dark'], d.theme),
    }
}

/** The app's colours the frame draws pages in. It cannot read them for itself, having no way into the app. */
export interface PageColours {
    background: string
    text: string
    link: string
    dark: boolean
}

export const LIGHT_PAGE: PageColours = { background: '#ffffff', text: '#171717', link: '#1d4ed8', dark: false }
export const DARK_PAGE: PageColours = { background: '#171717', text: '#e5e5e5', link: '#93c5fd', dark: true }

const SERIF = "Georgia, 'Times New Roman', Times, serif"
const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"

const FONTS: Record<Exclude<EbookFont, 'original'>, string> = {
    serif: SERIF,
    sans: SANS,
    // Each covers Latin alphabets, and an EBook in another script falls back letter by letter.
    literata: `Literata, ${SERIF}`,
    atkinson: `'Atkinson Hyperlegible', ${SANS}`,
}

/** One file of a font that comes with the app, handed to the frame, which can fetch nothing itself. */
export interface FrameFont {
    family: string
    weight: number
    style: 'normal' | 'italic'
    unicodeRange: string
    bytes: ArrayBuffer
}

/**
 * A note shows over the page when its reference is pressed. Written both ways because foliate shows a
 * section as HTML, where `epub:type` is an attribute with a colon in its name, and an XHTML section keeps
 * it in a namespace.
 */
const NOTE_KINDS = ['endnote', 'footnote', 'note', 'rearnote']
const NOTES_HIDDEN = `${NOTE_KINDS.flatMap((kind) => [`aside[epub|type~="${kind}"]`, `aside[epub\\:type~="${kind}"]`]).join(', ')} { display: none; }`

/**
 * Marks a paragraph the EBook leaves aligned to the side its text starts from, or justified, so that the
 * person's choice of alignment can go above the EBook's own rule for it. A centred or right-aligned line
 * is the EBook's design, and keeps it. The frame sets it once a section loads, which changes no CFI.
 */
export const ALIGNABLE = 'data-etherpk-align'

export const isAlignable = (textAlign: string): boolean => textAlign === 'start' || textAlign === 'left' || textAlign === 'justify'

/**
 * Marks what an EBook floats inside a paragraph, set by the frame once a section loads. `inline` is a first
 * letter no bigger than the paragraph's words: a layout program's one-line drop cap, floated only so it can
 * be styled. Floated, it sits off the line by the EBook's own margins, and the browser drops the space after
 * it, so it goes back in line with the words. `own` is anything else floated, such as a drop cap or a
 * picture: it lays out lines of its own, and keeps the EBook's spacing for them.
 */
export const FLOATED = 'data-etherpk-float'

export type Floated = 'inline' | 'own'

/** Up to three characters (a letter, perhaps with quotation marks) at most a fifth bigger than the words. */
export function floatedAs(text: string, fontSize: number, wordsFontSize: number): Floated {
    const characters = text.trim().length
    return characters > 0 && characters <= 3 && fontSize <= wordsFontSize * 1.2 ? 'inline' : 'own'
}

/**
 * The stylesheet for an EBook's pages. The person's line spacing and hyphenation go above the EBook's
 * own, and so does their alignment, for text the EBook does not centre or set to one side. The words in a
 * paragraph take its line spacing, and what the EBook floats keeps its own (`FLOATED`). An EBook's
 * own colours would be unreadable on a dark page, so on one they give way to the page's, and pictures stay
 * as they are. Its fonts stay unless the person chose one.
 */
export function pageStyles(settings: EbookSettings, colours: PageColours): string {
    const textAlign = settings.justify ? 'justify' : 'start'
    const hyphens = settings.hyphenate ? 'auto' : 'manual'
    const font = settings.font === 'original' ? '' : `body, body * { font-family: ${FONTS[settings.font]} !important; }`
    const darkOverride = colours.dark ? 'body, body *:not(svg, svg *) { color: inherit !important; background-color: transparent !important; border-color: currentColor; }' : ''
    return `
@namespace epub "http://www.idpf.org/2007/ops";
html { color-scheme: ${colours.dark ? 'dark' : 'light'}; font-size: ${settings.fontSize}px !important; color: ${colours.text}; background: ${colours.background}; }
body { font-size: 1rem; }
p, li, blockquote, dd { line-height: ${settings.lineHeight} !important; text-align: ${textAlign}; hyphens: ${hyphens} !important; -webkit-hyphens: ${hyphens} !important; widows: 2; orphans: 2; }
:is(p, li, blockquote, dd) :not(sup, sub, [${FLOATED}="own"]) { line-height: inherit !important; }
[${FLOATED}="inline"] { float: none !important; }
[${ALIGNABLE}] { text-align: ${textAlign} !important; }
[align="left"] { text-align: left; }
[align="right"] { text-align: right; }
[align="center"] { text-align: center; }
[align="justify"] { text-align: justify; }
pre { white-space: pre-wrap !important; }
img, svg { max-width: 100%; }
${NOTES_HIDDEN}
${darkOverride}
a:link, a:visited { color: ${colours.link} !important; }
${font}
`
}
