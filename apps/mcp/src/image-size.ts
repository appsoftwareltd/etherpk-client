/**
 * An image's size in pixels, read from the start of its bytes, for an agent placing an image in a
 * drawing, which has to say how big it is (ADR 0180). The Headless Client decodes no images, and each
 * of these formats states its size near the start of the file. Null for anything else, an SVG
 * included, whose size depends on what draws it.
 */
export interface PixelSize {
    width: number
    height: number
}

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
    for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false
    return true
}

function size(width: number, height: number): PixelSize | null {
    return width > 0 && height > 0 ? { width, height } : null
}

function pngSize(view: DataView): PixelSize | null {
    return view.byteLength >= 24 ? size(view.getUint32(16), view.getUint32(20)) : null
}

function gifSize(view: DataView): PixelSize | null {
    return view.byteLength >= 10 ? size(view.getUint16(6, true), view.getUint16(8, true)) : null
}

/** The first frame header's size, stepping over the segments before it, each of which states its length. */
function jpegSize(view: DataView): PixelSize | null {
    let at = 2
    while (at + 9 <= view.byteLength) {
        if (view.getUint8(at) !== 0xff) return null
        const marker = view.getUint8(at + 1)
        // A run of 0xff is padding before a marker.
        if (marker === 0xff) {
            at += 1
            continue
        }
        // Start of frame, every kind, but not the three markers in that range that are something else.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return size(view.getUint16(at + 7), view.getUint16(at + 5))
        at += 2 + view.getUint16(at + 2)
    }
    return null
}

function webpSize(bytes: Uint8Array, view: DataView): PixelSize | null {
    if (ascii(bytes, 12, 'VP8 ') && view.byteLength >= 30) return size(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff)
    if (ascii(bytes, 12, 'VP8L') && view.byteLength >= 25) {
        const bits = view.getUint32(21, true)
        return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
    }
    if (ascii(bytes, 12, 'VP8X') && view.byteLength >= 30) {
        const width = view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16)
        const height = view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16)
        return size(width + 1, height + 1)
    }
    return null
}

/** Its height is negative when its rows run top to bottom. */
function bmpSize(view: DataView): PixelSize | null {
    return view.byteLength >= 26 ? size(view.getInt32(18, true), Math.abs(view.getInt32(22, true))) : null
}

export function imagePixelSize(bytes: Uint8Array): PixelSize | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (ascii(bytes, 1, 'PNG\r\n')) return pngSize(view)
    if (ascii(bytes, 0, 'GIF8')) return gifSize(view)
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(view)
    if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return webpSize(bytes, view)
    if (ascii(bytes, 0, 'BM')) return bmpSize(view)
    return null
}
