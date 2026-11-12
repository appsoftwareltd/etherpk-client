import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

/** A path relative to `apps/client/static`. */
const fromStatic = (path: string) => fileURLToPath(new URL(`../static/${path}`, import.meta.url))

type Pixels = { width: number; height: number; alphaAt: (x: number, y: number) => number }

/**
 * Decodes an 8-bit RGBA, non-interlaced PNG: the one shape the icon generator writes, and enough
 * to read alpha at a point without a PNG library in the Client's dependencies.
 */
function decodePng(path: string): Pixels {
    const file = readFileSync(path)
    let offset = 8
    let width = 0
    let height = 0
    const data: Buffer[] = []
    while (offset < file.length) {
        const length = file.readUInt32BE(offset)
        const type = file.toString('latin1', offset + 4, offset + 8)
        const body = file.subarray(offset + 8, offset + 8 + length)
        if (type === 'IHDR') {
            width = body.readUInt32BE(0)
            height = body.readUInt32BE(4)
            // Bit depth 8, colour type 6 (RGBA), interlace 0.
            expect([body[8], body[9], body[12]], `${path} is 8-bit RGBA, not interlaced`).toEqual([8, 6, 0])
        }
        if (type === 'IDAT') data.push(body)
        offset += 12 + length
    }
    const raw = inflateSync(Buffer.concat(data))
    const stride = width * 4
    const pixels = Buffer.alloc(stride * height)
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)]
        for (let x = 0; x < stride; x++) {
            const value = raw[y * (stride + 1) + 1 + x]
            const left = x >= 4 ? pixels[y * stride + x - 4] : 0
            const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
            const upLeft = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0
            let predicted = 0
            if (filter === 1) predicted = left
            else if (filter === 2) predicted = up
            else if (filter === 3) predicted = (left + up) >> 1
            else if (filter === 4) {
                const p = left + up - upLeft
                const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)]
                predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
            }
            pixels[y * stride + x] = (value + predicted) & 0xff
        }
    }
    return { width, height, alphaAt: (x, y) => pixels[y * stride + x * 4 + 3] }
}

type ManifestIcon = { src: string; sizes: string; purpose?: string }
const manifest = JSON.parse(readFileSync(fromStatic('site.webmanifest'), 'utf8')) as { icons: ManifestIcon[] }

/** The alpha at each corner pixel, and at the centre. */
function cornersAndCentre({ width, height, alphaAt }: Pixels) {
    const corners = [alphaAt(0, 0), alphaAt(width - 1, 0), alphaAt(0, height - 1), alphaAt(width - 1, height - 1)]
    return { corners, centre: alphaAt(width >> 1, height >> 1) }
}

describe('app icons', () => {
    // A desktop launcher (GNOME, Windows, macOS) shows a `purpose: any` icon as drawn, with no
    // mask, so a full-bleed square shows as a square with sharp corners. These icons are the same
    // full-bleed white tile with only its corners rounded off: they fill the canvas, so they sit at
    // the same size as other apps' icons, and Android can still cut one to a circle without any
    // edge or transparent margin showing inside it.
    const launcherIcons = manifest.icons.filter((icon) => (icon.purpose ?? 'any').split(' ').includes('any'))

    it('declares a 192px and a 512px launcher icon', () => {
        expect(launcherIcons.map((icon) => icon.sizes).sort()).toEqual(['192x192', '512x512'])
    })

    it.each(launcherIcons.map((icon) => [icon.src, icon] as const))('%s has clear corners and is opaque everywhere else', (_src, icon) => {
        const pixels = decodePng(fromStatic(icon.src.replace(/^\//, '')))
        const { width, height, alphaAt } = pixels
        expect(`${width}x${height}`).toBe(icon.sizes)
        const { corners, centre } = cornersAndCentre(pixels)
        expect(corners).toEqual([0, 0, 0, 0])
        expect(centre).toBe(255)
        // The tile reaches every edge: no margin, so the icon is not drawn smaller than its neighbours.
        const midEdges = [alphaAt(width >> 1, 0), alphaAt(width >> 1, height - 1), alphaAt(0, height >> 1), alphaAt(width - 1, height >> 1)]
        expect(midEdges).toEqual([255, 255, 255, 255])
        // Every pixel of the inscribed circle is opaque, so a circular crop shows no edge at all.
        const radius = width / 2
        let transparentInCircle = 0
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const inside = Math.hypot(x + 0.5 - radius, y + 0.5 - radius) < radius - 1
                if (inside && alphaAt(x, y) !== 255) transparentInCircle++
            }
        }
        expect(transparentInCircle).toBe(0)
    })

    // Android cuts a maskable icon to its own shape, and iOS rounds the apple-touch-icon itself and
    // fills any transparency with black, so both stay full-bleed squares.
    it.each(['icon-maskable-512.png', 'apple-touch-icon.png'])('%s stays a full-bleed square', (file) => {
        const { corners, centre } = cornersAndCentre(decodePng(fromStatic(file)))
        expect(corners).toEqual([255, 255, 255, 255])
        expect(centre).toBe(255)
    })
})
