import { describe, expect, it } from 'vitest'

import { imagePixelSize } from './image-size'

/** Bytes from numbers and strings, in order. */
function bytes(...parts: (number | string)[]): Uint8Array {
    return new Uint8Array(parts.flatMap((part) => (typeof part === 'string' ? [...part].map((c) => c.charCodeAt(0)) : [part])))
}

describe("an image's size in pixels", () => {
    it('reads a PNG', () => {
        const png = bytes(0x89, 'PNG\r\n', 0x1a, '\n', 0, 0, 0, 13, 'IHDR', 0, 0, 2, 128, 0, 0, 1, 144)
        expect(imagePixelSize(png)).toEqual({ width: 640, height: 400 })
    })

    it('reads a GIF', () => {
        expect(imagePixelSize(bytes('GIF89a', 128, 2, 144, 1))).toEqual({ width: 640, height: 400 })
    })

    it('reads a JPEG, past the segments before its frame', () => {
        const app0 = [0xff, 0xe0, 0, 4, 1, 2]
        const frame = [0xff, 0xc0, 0, 11, 8, 1, 144, 2, 128, 3, 1]
        expect(imagePixelSize(bytes(0xff, 0xd8, ...app0, ...frame))).toEqual({ width: 640, height: 400 })
    })

    it('reads a progressive JPEG', () => {
        expect(imagePixelSize(bytes(0xff, 0xd8, 0xff, 0xc2, 0, 11, 8, 1, 144, 2, 128, 3, 1))).toEqual({ width: 640, height: 400 })
    })

    it('reads each kind of WebP', () => {
        const riff = (chunk: string, ...rest: number[]) => bytes('RIFF', 0, 0, 0, 0, 'WEBP', chunk, 0, 0, 0, 0, ...rest)
        // A lossy frame: three bytes of tag, the start code, then 14 bits of each size.
        expect(imagePixelSize(riff('VP8 ', 0, 0, 0, 0x9d, 0x01, 0x2a, 128, 2, 144, 1))).toEqual({ width: 640, height: 400 })
        // Lossless: a signature, then 14 bits of width minus one and 14 of height minus one, low bits first.
        const bits = 639 | (399 << 14)
        expect(imagePixelSize(riff('VP8L', 0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff))).toEqual({ width: 640, height: 400 })
        // Extended: flags, then 24 bits of width minus one and of height minus one.
        expect(imagePixelSize(riff('VP8X', 0, 0, 0, 0, 0x7f, 2, 0, 0x8f, 1, 0))).toEqual({ width: 640, height: 400 })
    })

    it('reads a BMP', () => {
        const bmp = new Uint8Array(26)
        bmp.set([0x42, 0x4d])
        new DataView(bmp.buffer).setInt32(18, 640, true)
        new DataView(bmp.buffer).setInt32(22, -400, true)
        expect(imagePixelSize(bmp)).toEqual({ width: 640, height: 400 })
    })

    it('has no answer for anything else, or for an image cut short', () => {
        expect(imagePixelSize(bytes('%PDF-1.7'))).toBeNull()
        expect(imagePixelSize(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
        expect(imagePixelSize(bytes(0x89, 'PNG\r\n', 0x1a, '\n', 0, 0, 0, 13, 'IHDR', 0))).toBeNull()
        expect(imagePixelSize(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 200))).toBeNull()
        expect(imagePixelSize(new Uint8Array())).toBeNull()
    })
})
