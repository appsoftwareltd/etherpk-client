import { describe, expect, it } from 'vitest'

import { normalizeDisplaySize, parseDisplaySize, parseImageDisplaySizeHint } from './image-display-size'

describe('parseImageDisplaySizeHint', () => {
    it('returns the alt unchanged when there is no hint', () => {
        expect(parseImageDisplaySizeHint('a diagram')).toEqual({ cleanAlt: 'a diagram' })
    })

    it('parses a width-only hint and strips it from the alt', () => {
        expect(parseImageDisplaySizeHint('diagram|300')).toEqual({ cleanAlt: 'diagram', maxWidth: 300 })
    })

    it('parses a width x height hint (either case of x)', () => {
        expect(parseImageDisplaySizeHint('photo|640x480')).toEqual({ cleanAlt: 'photo', maxWidth: 640, maxHeight: 480 })
        expect(parseImageDisplaySizeHint('photo|640X480')).toEqual({ cleanAlt: 'photo', maxWidth: 640, maxHeight: 480 })
    })

    it('tolerates trailing whitespace after the hint', () => {
        expect(parseImageDisplaySizeHint('x|120 ')).toEqual({ cleanAlt: 'x', maxWidth: 120 })
    })

    it('ignores a zero width (no valid hint)', () => {
        expect(parseImageDisplaySizeHint('x|0')).toEqual({ cleanAlt: 'x|0' })
    })

    it('keeps an empty clean alt when the alt is only a hint', () => {
        expect(parseImageDisplaySizeHint('|200')).toEqual({ cleanAlt: '', maxWidth: 200 })
    })
})

describe('parseDisplaySize (bare spec, no leading pipe)', () => {
    it('parses width-only and width x height', () => {
        expect(parseDisplaySize('300')).toEqual({ width: 300 })
        expect(parseDisplaySize(' 640x480 ')).toEqual({ width: 640, height: 480 })
    })

    it('rejects junk, zero, and pipe-prefixed input', () => {
        expect(parseDisplaySize('abc')).toBeNull()
        expect(parseDisplaySize('0')).toBeNull()
        expect(parseDisplaySize('300x')).toBeNull()
        expect(parseDisplaySize('|300')).toBeNull()
    })
})

describe('normalizeDisplaySize', () => {
    it('canonicalises a valid spec (lower-case x, trimmed) and rejects invalid', () => {
        expect(normalizeDisplaySize('300')).toBe('300')
        expect(normalizeDisplaySize('640X480')).toBe('640x480')
        expect(normalizeDisplaySize('nope')).toBeNull()
    })
})
