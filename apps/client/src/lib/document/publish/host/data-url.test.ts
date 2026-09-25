import { describe, expect, it } from 'vitest'

import { decodeDataUrl } from './data-url'

describe('decodeDataUrl', () => {
    it('decodes a base64 data url to its bytes', () => {
        // "wOF2" is the woff2 magic, as an inlined KaTeX font starts.
        expect(decodeDataUrl('data:font/woff2;base64,d09GMg==')).toEqual(new Uint8Array([0x77, 0x4f, 0x46, 0x32]))
    })

    it('decodes a percent-encoded data url', () => {
        expect(new TextDecoder().decode(decodeDataUrl('data:text/plain,hi%20there')!)).toBe('hi there')
    })

    it('answers null for an ordinary url, so the caller fetches it', () => {
        expect(decodeDataUrl('/assets/KaTeX_Main-Regular.woff2')).toBeNull()
        expect(decodeDataUrl('https://example.com/font.woff2')).toBeNull()
    })
})
