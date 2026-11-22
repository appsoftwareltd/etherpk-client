import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { linkDestinations, pathAfter, rewriteLinks } from './link-rewrite'
import { relativeLink, resolveLink } from './plain-path'

/**
 * After a file or a directory is moved, a rewritten link must lead to the same file it led to
 * before, wherever the two files now are: that is all "the links still work" means. Checked over
 * any folder, any file holding the links, any targets and any move.
 *
 * Fixed seed and run count. `PLAIN_FUZZ_RUNS` and `PLAIN_FUZZ_SEED` change them.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.PLAIN_FUZZ_SEED
    return { numRuns: Number(process.env.PLAIN_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261121 : Number(seed) }
}

const name = fc.constantFrom('guide', 'notes', 'a', 'bed layout', 'x(1)', '園')
const file = fc.tuple(fc.array(name, { maxLength: 3 }), fc.constantFrom('soil.md', 'watering.md', 'README.md', 'bed 2.png')).map(([dirs, leaf]) => [...dirs, leaf].join('/'))

describe('links after a move', () => {
    it('each rewritten link leads to the same file as before, at its new path', () => {
        fc.assert(
            fc.property(file, fc.array(file, { minLength: 1, maxLength: 4 }), file, fc.array(name, { minLength: 1, maxLength: 3 }), fc.boolean(), (holder, targets, movedFile, toDirs, moveDirectory) => {
                // Move one file, or the directory it sits in.
                const from = moveDirectory && movedFile.includes('/') ? movedFile.slice(0, movedFile.lastIndexOf('/')) : movedFile
                const to = moveDirectory && movedFile.includes('/') ? toDirs.join('/') : `${toDirs.join('/')}/moved.md`
                fc.pre(to !== from && !to.startsWith(`${from}/`))
                const move = { from, to }
                const text = targets.map((target) => `[link](${relativeLink(holder, target)})`).join(' and ')
                const holderAfter = pathAfter(holder, move)

                const rewritten = rewriteLinks(text, holder, holderAfter, move).text
                const led = linkDestinations(rewritten).map((span) => resolveLink(holderAfter, span.href))
                expect(led).toEqual(targets.map((target) => ({ kind: 'file', path: pathAfter(target, move), fragment: null })))
            }),
            fuzz(1000),
        )
    })

    it('a text with no link the move touches comes back unchanged', () => {
        fc.assert(
            fc.property(file, fc.array(file, { maxLength: 4 }), (holder, targets) => {
                const text = targets.map((target) => `[link](${relativeLink(holder, target)})`).join(' ')
                const untouched = { from: 'elsewhere/never', to: 'elsewhere/moved' }
                expect(rewriteLinks(text, holder, holder, untouched)).toEqual({ text, changed: 0 })
            }),
            fuzz(500),
        )
    })
})
