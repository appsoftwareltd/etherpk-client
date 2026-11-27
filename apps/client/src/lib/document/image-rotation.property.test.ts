/**
 * Properties of moving a rotated picture's references (`image-rotation.ts`), over any text holding
 * references to it, to other files, and other links:
 *
 * - **Undo puts every text back.** Moving the references to the rotated picture and back again leaves
 *   each text exactly as it was, words, size hints and every other link included.
 * - **Only its references move.** After the move no reference to the old picture is left, and every
 *   other link is as it was.
 *
 * Fixed seeds keep the suite deterministic in CI. To hunt for new counterexamples, run with
 * `DOCUMENT_FUZZ_SEED=<n>` (any integer) and optionally `DOCUMENT_FUZZ_RUNS=<n>`.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { moveReferenceEdits } from './image-rotation'

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261127 : Number(seed) }
}

const identify = (ref: string) => /\.\.\/assets\/([^)#?\s]+)/.exec(ref)?.[1] ?? null
const OLD = 'beds.a1b2c3d4.png'
const NEW_REF = '../assets/beds.e5f6a7b8.png'

const words = fc.constantFrom('water the beans', 'Beds|800', 'Garden plan', '', 'see', 'Shed|300x200', '[[Kitchen]]')
/**
 * A link's words. Not a wikilink: the link reader a rename uses (`markdown-link-target.ts`) does not
 * take `[[[Kitchen]]](…)` as a link, so a rotation, like a PDF's rename, leaves it as it is.
 */
const labels = fc.constantFrom('water the beans', 'Beds|800', 'Garden plan', '', 'see', 'Shed|300x200')
const piece = fc.oneof(
    labels.map((alt) => `![${alt}](../assets/${OLD})`),
    labels.map((label) => `[${label}](../assets/${OLD}#page=2)`),
    words.map((alt) => `![${alt}](../assets/shed.c9d0e1f2.png)`),
    words.map((label) => `[${label}](https://example.com/beds.png)`),
    words,
    fc.constantFrom('- ', '\n', '  - ', ' and ', '`![code](../assets/beds.a1b2c3d4.png)`'),
)
const text = fc.array(piece, { maxLength: 12 }).map((parts) => parts.join(''))

function applied(source: string, edits: { from: number; to: number; insert: string }[]): string {
    return edits.reduce((out, e) => out.slice(0, e.from) + e.insert + out.slice(e.to), source)
}

describe('moving a rotated picture’s references', () => {
    it('is put back exactly by moving them back', () => {
        fc.assert(
            fc.property(text, (source) => {
                const moved = applied(source, moveReferenceEdits(source, identify, OLD, NEW_REF))
                const back = applied(moved, moveReferenceEdits(moved, identify, identify(NEW_REF)!, `../assets/${OLD}`))
                expect(back).toBe(source)
            }),
            fuzz(500),
        )
    })

    it('leaves no reference to the old picture outside code, and every other link as it was', () => {
        fc.assert(
            fc.property(text, (source) => {
                const moved = applied(source, moveReferenceEdits(source, identify, OLD, NEW_REF))
                const outsideCode = (s: string) => s.replace(/`[^`]*`/g, '')
                expect(outsideCode(moved)).not.toContain(`../assets/${OLD}`)
                expect(moved.split('../assets/shed.c9d0e1f2.png').length).toBe(source.split('../assets/shed.c9d0e1f2.png').length)
                expect(moved.split('https://example.com/beds.png').length).toBe(source.split('https://example.com/beds.png').length)
            }),
            fuzz(500),
        )
    })
})
