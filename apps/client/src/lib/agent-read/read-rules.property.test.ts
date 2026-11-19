/**
 * Property tests over `textWindow`, the paging an agent reads a long document with: following
 * `nextOffset` from 0 must give back the whole text, in windows no longer than the cap that end
 * on a whole line wherever a line fits, each numbered from the line it starts on.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { textWindow } from './read-rules'

/** A fixed seed keeps CI deterministic; `READ_FUZZ_SEED` and `READ_FUZZ_RUNS` hunt for more. */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.READ_FUZZ_SEED
    return { numRuns: Number(process.env.READ_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261118 : Number(seed) }
}

/** Lines of the shapes a document holds, with long ones (a drawing's JSON) and surrogate pairs. */
const lineArb = fc.oneof(
    fc.constantFrom('', '- water the beans', '  - [ ] #P1 feed the hens', '```excalidraw.drawing', '🌱🌱', '- a 🌱 b'),
    fc.string({ unit: fc.constantFrom('a', ' ', '{', '"', '🌱', 'é'), maxLength: 40 }),
)
const textArb = fc.array(lineArb, { maxLength: 30 }).map((lines) => lines.join('\n'))

/** Every window of `text`, following `nextOffset` from 0. */
function windows(text: string, cap: number) {
    const out = [textWindow(text, 0, cap)]
    while (out.at(-1)!.nextOffset !== undefined) {
        out.push(textWindow(text, out.at(-1)!.nextOffset!, cap))
        if (out.length > text.length + 2) throw new Error('the windows do not move on')
    }
    return out
}

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff

describe('textWindow properties', () => {
    it('gives the whole text back, window after window, each at most the cap', () => {
        fc.assert(
            fc.property(textArb, fc.integer({ min: 2, max: 50 }), (text, cap) => {
                const all = windows(text, cap)
                expect(all.map((w) => w.text).join('')).toBe(text)
                for (const w of all) expect(w.text.length).toBeLessThanOrEqual(cap)
                expect(all.at(-1)!.truncated).toBe(false)
                expect(all.slice(0, -1).every((w) => w.truncated)).toBe(true)
            }),
            fuzz(500),
        )
    })

    it('numbers each window from the line it starts on, and never ends one inside a character', () => {
        fc.assert(
            fc.property(textArb, fc.integer({ min: 2, max: 50 }), (text, cap) => {
                for (const w of windows(text, cap)) {
                    expect(w.startLine).toBe(text.slice(0, w.offset).split('\n').length - 1)
                    if (w.text.length > 0) expect(isHighSurrogate(w.text.charCodeAt(w.text.length - 1))).toBe(false)
                }
            }),
            fuzz(500),
        )
    })

    it('ends a cut window after a line break whenever the window holds one', () => {
        fc.assert(
            fc.property(textArb, fc.integer({ min: 2, max: 50 }), (text, cap) => {
                for (const w of windows(text, cap)) {
                    if (w.truncated && w.text.includes('\n')) expect(w.text.endsWith('\n')).toBe(true)
                }
            }),
            fuzz(500),
        )
    })
})
