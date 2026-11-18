/**
 * Properties of the three readers of image syntax on a line of its own: `embed-line.ts` (the
 * shape), `image-line.ts` (a picture) and `media-line.ts` (a recording). The editor draws a
 * picture for one and a player for the other, so a line both claim would be drawn twice, and a
 * line the shape rejects must be neither.
 *
 * Fixed seeds keep the suite deterministic in CI. To hunt for new counterexamples, run with
 * `DOCUMENT_FUZZ_SEED=<n>` (any integer) and optionally `DOCUMENT_FUZZ_RUNS=<n>`.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { AUDIO_EXTS, VIDEO_EXTS, assetNameFromRef, buildAssetMarkdown, mimeTypeForExt } from '#lib/storage/fs/asset-store.js'

import { parseEmbedLine } from './embed-line'
import { isImageLine, parseImageLine } from './image-line'
import { isMediaLine, mediaKindOfTarget, parseMediaLine } from './media-line'

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261118 : Number(seed) }
}

const extension = fc.constantFrom(...VIDEO_EXTS, ...AUDIO_EXTS, 'png', 'jpg', 'svg', 'webp', 'pdf', 'epub', 'mov', 'txt', 'MP4', 'Mp3', '')
const stem = fc.constantFrom('clip', 'voice-note', 'Garden%20walk', 'walk_(1)', 'a.b', 'chart.a1b2c3d4', 'x')
const base = fc.constantFrom('../assets/', '../../assets/', 'assets/', './', '', 'https://example.com/', '//example.com/', 'file:///home/me/', '../assets/nested/')
const target = fc.tuple(base, stem, extension, fc.constantFrom('', '?x=1', '#t=3')).map(([b, s, e, tail]) => `${b}${s}${e ? `.${e}` : ''}${tail}`)
const alt = fc.constantFrom('', 'clip', 'A voice note', 'Garden|300', 'a [b] c', 'x|640x480')
const lead = fc.constantFrom('', '  ', '- ', '  - ', '- [ ] ', '    - [x] ', '* ', '1. ', '> ')
const bang = fc.constantFrom('!', '!', '!', '')
const trail = fc.constantFrom('', '', ' ', ' and more', ' ![b](../assets/b.mp4)')

/** A line that is, or nearly is, one piece of image syntax. */
const line = fc.tuple(lead, bang, alt, target, trail).map(([l, b, a, t, end]) => `${l}${b}[${a}](${t})${end}`)
/** Any line at all, for what the generators above would never think of. */
const anything = fc.oneof(line, fc.string({ maxLength: 60 }), fc.string({ maxLength: 60, unit: 'grapheme' }))

describe('a line of image syntax', () => {
    it('is a picture or a recording, never both', () => {
        fc.assert(
            fc.property(anything, (text) => {
                expect(isImageLine(text) && isMediaLine(text), text).toBe(false)
            }),
            fuzz(2000),
        )
    })

    it('is a picture or a recording only when it has the shape, and keeps what the shape read', () => {
        fc.assert(
            fc.property(anything, (text) => {
                const embed = parseEmbedLine(text)
                const image = parseImageLine(text)
                const media = parseMediaLine(text)
                if (embed === null) {
                    expect(image, text).toBeNull()
                    expect(media, text).toBeNull()
                    return
                }
                if (image) expect(image).toEqual(embed)
                if (media) expect({ kind: media.kind, alt: media.alt, url: media.url, imageStart: media.imageStart }).toEqual(embed)
                // The embed is where it says it is.
                expect(text.slice(embed.imageStart, embed.imageStart + 2)).toBe('![')
            }),
            fuzz(2000),
        )
    })

    it("is a recording only when the Asset Store can find the file: an Asset Reference, with a type it can name", () => {
        fc.assert(
            fc.property(target, (written) => {
                const kind = mediaKindOfTarget(written)
                if (kind === null) return
                const name = assetNameFromRef(written)
                expect(name, written).not.toBeNull()
                const type = mimeTypeForExt(name!.slice(name!.lastIndexOf('.') + 1))
                expect(type.startsWith(`${kind}/`), `${written} is ${type}`).toBe(true)
            }),
            fuzz(1000),
        )
    })

    it('a saved recording is written as a line that draws its player, and any other file is not', () => {
        fc.assert(
            fc.property(stem, extension, (name, ext) => {
                fc.pre(ext !== '')
                const ref = `../assets/${name}.${ext}`
                const markdown = buildAssetMarkdown({ ref, stem: 'file', isImage: false })
                expect(isMediaLine(markdown), markdown).toBe(mediaKindOfTarget(ref) !== null)
                expect(isImageLine(markdown), markdown).toBe(false)
            }),
            fuzz(500),
        )
    })
})
