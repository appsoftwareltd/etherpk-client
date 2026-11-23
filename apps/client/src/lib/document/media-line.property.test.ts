/**
 * Properties of the three readers of image syntax on a line of its own: `embed-line.ts` (the
 * shape), `image-line.ts` (a picture) and `media-line.ts` (a recording). The editor draws a
 * picture for one and a player for the other, so a line both claim would be drawn twice, and a
 * line the shape rejects must be neither. Then of what is done to such a line: the resize handle's
 * write (`resize-handle.ts`), and where a player goes among folds (`media-embed.ts`).
 *
 * Fixed seeds keep the suite deterministic in CI. To hunt for new counterexamples, run with
 * `DOCUMENT_FUZZ_SEED=<n>` (any integer) and optionally `DOCUMENT_FUZZ_RUNS=<n>`.
 */

import { undo } from '@codemirror/commands'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { AUDIO_EXTS, VIDEO_EXTS, assetNameFromRef, buildAssetMarkdown, mimeTypeForExt } from '#lib/storage/fs/asset-store.js'

import { parseEmbedLine } from './embed-line'
import { isImageLine, parseImageLine } from './image-line'
import { isMediaLine, mediaKindOfTarget, parseMediaLine } from './media-line'
import { parseImageDisplaySizeHint } from './view/augmentations/image-display-size'
import { mediaLineOfPlayer, mediaWidgetPos } from './view/augmentations/media-embed'
import { allFolds, outlineFolds, toggleBulletFoldSpec } from './view/augmentations/outline-folds'
import { clampDisplayWidth, displayWidthChange } from './view/augmentations/resize-handle'
import { editorFixture } from './view/testing/editor-state-fixture'

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

describe('resizing a line of image syntax', () => {
    const embedLine = fc.tuple(fc.constantFrom('', '  ', '- ', '  - ', '- [ ] ', '    - [x] '), alt, fc.constantFrom('../assets/clip.webm', '../assets/walk_(1).mp4', '../assets/chart.png', 'https://example.com/chart.png'), fc.constantFrom('', ' '))
    const width = fc.option(fc.integer({ min: 48, max: 4000 }), { nil: null })

    it('keeps the line what it is, with its words, and says the width asked for', () => {
        fc.assert(
            fc.property(embedLine, width, fc.constantFrom('', '- water the beans\n'), ([lead, label, url, end], px, above) => {
                const text = `${lead}![${label}](${url})${end}`
                const before = parseEmbedLine(text)
                fc.pre(before !== null)
                const editor = editorFixture(`${above}${text}\nafter§`, { caret: '§' })
                const spec = displayWidthChange(editor.state, above.length, url, px)
                if (spec) editor.dispatch(editor.state.update(spec))
                const line = editor.state.doc.lineAt(above.length).text
                const after = parseEmbedLine(line)!
                // The same file, in the same shape, at the same place.
                expect({ ...after, alt: '' }, line).toEqual({ ...before!, alt: '' })
                expect(isMediaLine(line)).toBe(isMediaLine(text))
                expect(isImageLine(line)).toBe(isImageLine(text))
                const size = parseImageDisplaySizeHint(after.alt)
                expect(size.maxWidth ?? null, line).toBe(px)
                expect(size.maxHeight, line).toBeUndefined()
                expect(size.cleanAlt, line).toBe(parseImageDisplaySizeHint(before!.alt).cleanAlt)
                // Nothing else of the document moves, and asking again changes nothing.
                expect(editor.state.doc.toString()).toBe(`${above}${line}\nafter`)
                expect(displayWidthChange(editor.state, above.length, url, px)).toBeNull()
                if (!spec) return
                undo(editor)
                expect(editor.state.doc.toString()).toBe(`${above}${text}\nafter`)
            }),
            fuzz(500),
        )
    })

    it('keeps a drag between its narrowest and its widest, on a whole pixel, and in order', () => {
        const px = fc.double({ min: -2000, max: 6000, noNaN: true })
        fc.assert(
            fc.property(px, px, fc.integer({ min: 1, max: 400 }), fc.double({ min: 1, max: 3000, noNaN: true }), (a, b, narrowest, widest) => {
                const at = (value: number) => clampDisplayWidth(value, { narrowest, widest })
                expect(Number.isInteger(at(a))).toBe(true)
                expect(at(a)).toBeLessThanOrEqual(Math.max(1, widest))
                expect(at(a)).toBeGreaterThanOrEqual(Math.min(narrowest, Math.floor(widest)))
                if (a <= b) expect(at(a)).toBeLessThanOrEqual(at(b))
            }),
            fuzz(1000),
        )
    })
})

describe('players among folds', () => {
    /** An outline of words and media lines, the same recording more than once, some bullets folded. */
    const outline = fc.array(fc.tuple(fc.integer({ min: 0, max: 3 }), fc.constantFrom('beans', '![clip](../assets/clip.mp4)', '![walk](../assets/walk.webm)')), { minLength: 1, maxLength: 10 })

    it('every player stands at a place of its own, and is found back from it to its line', () => {
        fc.assert(
            fc.property(outline, fc.array(fc.nat({ max: 9 }), { maxLength: 6 }), (rows, folds) => {
                // A row nests at most one level under the row above it.
                let depth = -1
                const text = rows.map(([level, words]) => `${'  '.repeat((depth = Math.min(level, depth + 1)))}- ${words}`).join('\n')
                const editor = editorFixture(`${text}§`, { caret: '§', extensions: [outlineFolds()] })
                // The caret opens a fold that would hide it, and a fold moves it out: both are the editor's own rules.
                for (const n of folds) {
                    const spec = n < rows.length ? toggleBulletFoldSpec(editor.state, n + 1) : null
                    if (spec) editor.dispatch(editor.state.update(spec))
                }
                const { state } = editor
                const shut = allFolds(state)
                const taken = new Set<number>()
                for (let n = 1; n <= state.doc.lines; n++) {
                    const line = state.doc.line(n)
                    const media = parseMediaLine(line.text)
                    if (!media) continue
                    const pos = mediaWidgetPos(line.to, shut)
                    // A line has a player when no fold hides it: one that starts above it and reaches its end.
                    const hidden = shut.some((fold) => fold.from < line.from && line.to <= fold.to)
                    expect(pos === null, `${text}\nline ${n}`).toBe(hidden)
                    if (pos === null) continue
                    expect(taken.has(pos), `${text}\ntwo players at ${pos}`).toBe(false)
                    taken.add(pos)
                    expect(mediaLineOfPlayer(state, pos, media.url), `${text}\nline ${n}`).toBe(line.from)
                }
            }),
            fuzz(500),
        )
    })
})
