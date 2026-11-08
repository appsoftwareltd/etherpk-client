/**
 * The reading fonts an EBook can be set in, both under the SIL Open Font License. They come with the app, so
 * choosing one contacts nobody. The frame loads nothing itself, so the app reads each file, kept by the
 * service worker once fetched, and hands over the bytes.
 */
import type { EbookFont, FrameFont } from '#lib/document/ebook/ebook-settings.js'

import atkinson400 from '@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-normal.woff2?url&no-inline'
import atkinson400ext from '@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-ext-400-normal.woff2?url&no-inline'
import atkinson400i from '@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-italic.woff2?url&no-inline'
import atkinson700 from '@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-normal.woff2?url&no-inline'
import atkinson700ext from '@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-ext-700-normal.woff2?url&no-inline'
import literata400 from '@fontsource/literata/files/literata-latin-400-normal.woff2?url&no-inline'
import literata400ext from '@fontsource/literata/files/literata-latin-ext-400-normal.woff2?url&no-inline'
import literata400i from '@fontsource/literata/files/literata-latin-400-italic.woff2?url&no-inline'
import literata700 from '@fontsource/literata/files/literata-latin-700-normal.woff2?url&no-inline'
import literata700ext from '@fontsource/literata/files/literata-latin-ext-700-normal.woff2?url&no-inline'

/** From each font's own stylesheet: what a file covers, so that a browser takes a letter from the right one. */
const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
const LATIN_EXT = 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'

interface FontFile {
    url: string
    weight: number
    style: 'normal' | 'italic'
    unicodeRange: string
}

const FILES: Partial<Record<EbookFont, { family: string; files: FontFile[] }>> = {
    literata: {
        family: 'Literata',
        files: [
            { url: literata400, weight: 400, style: 'normal', unicodeRange: LATIN },
            { url: literata400ext, weight: 400, style: 'normal', unicodeRange: LATIN_EXT },
            { url: literata400i, weight: 400, style: 'italic', unicodeRange: LATIN },
            { url: literata700, weight: 700, style: 'normal', unicodeRange: LATIN },
            { url: literata700ext, weight: 700, style: 'normal', unicodeRange: LATIN_EXT },
        ],
    },
    atkinson: {
        family: 'Atkinson Hyperlegible',
        files: [
            { url: atkinson400, weight: 400, style: 'normal', unicodeRange: LATIN },
            { url: atkinson400ext, weight: 400, style: 'normal', unicodeRange: LATIN_EXT },
            { url: atkinson400i, weight: 400, style: 'italic', unicodeRange: LATIN },
            { url: atkinson700, weight: 700, style: 'normal', unicodeRange: LATIN },
            { url: atkinson700ext, weight: 700, style: 'normal', unicodeRange: LATIN_EXT },
        ],
    },
}

/** The files of a font that comes with the app, ready to hand to the frame, or none for any other. */
export async function loadEbookFont(font: EbookFont): Promise<FrameFont[]> {
    const held = FILES[font]
    if (!held) return []
    return Promise.all(
        held.files.map(async ({ url, weight, style, unicodeRange }) => ({
            family: held.family,
            weight,
            style,
            unicodeRange,
            bytes: await (await fetch(url)).arrayBuffer(),
        })),
    )
}
