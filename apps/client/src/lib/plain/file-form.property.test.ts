import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { lineFeedsOnly } from '../document/line-endings'

import { decodeFile, encodeFile, placeEdits, splitLines } from './file-form'

/**
 * A file in a [[Plain Folder]] was written elsewhere and is often under git, so a save must leave
 * every line the person did not edit exactly as it was, whatever the file's line endings, byte
 * order mark or final newline (ADR 0196).
 *
 * Fixed seed and run count. `PLAIN_FUZZ_RUNS` and `PLAIN_FUZZ_SEED` change them.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.PLAIN_FUZZ_SEED
    return { numRuns: Number(process.env.PLAIN_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261121 : Number(seed) }
}

const lineText = fc.string({ unit: fc.constantFrom('a', 'b', ' ', '-', '*', '1', '.', '\t', '#', 'é'), maxLength: 6 })
const ending = fc.constantFrom('\n', '\r\n', '\r')
/** A file as lines with an ending each; the last line may have none. */
const file = fc
    .tuple(fc.array(fc.tuple(lineText, ending), { maxLength: 12 }), lineText)
    .map(([lines, last]) => lines.map(([text, eol]) => text + eol).join('') + last)

describe('saving a file of a Plain Folder', () => {
    it('writes back exactly the bytes it read when nothing was edited', () => {
        fc.assert(
            fc.property(file, fc.boolean(), (text, bom) => {
                const original = encodeFile(text, { bom, eol: '\n' })
                const read = decodeFile(original)
                if (!read.ok) throw new Error('generated text is UTF-8')
                const saved = placeEdits(read.text, lineFeedsOnly(read.text), read.form)
                expect(encodeFile(saved, read.form)).toEqual(original)
            }),
            fuzz(1000),
        )
    })

    it('saves what the buffer holds: reading the result gives the buffer back', () => {
        fc.assert(
            fc.property(file, file, (disk, other) => {
                const read = decodeFile(encodeFile(disk, { bom: false, eol: '\n' }))
                if (!read.ok) throw new Error('generated text is UTF-8')
                const buffer = lineFeedsOnly(other)
                expect(lineFeedsOnly(placeEdits(read.text, buffer, read.form))).toBe(buffer)
            }),
            fuzz(1000),
        )
    })

    it('an edit to one line leaves every other line, and its ending, as it was', () => {
        fc.assert(
            fc.property(file, fc.nat(), (disk, pick) => {
                const before = splitLines(disk)
                const at = pick % before.length
                const lines = lineFeedsOnly(disk).split('\n')
                lines[at] = `${lines[at]} edited`
                const after = splitLines(placeEdits(disk, lines.join('\n'), { bom: false, eol: '\n' }))
                expect(after).toHaveLength(before.length)
                after.forEach((line, index) => {
                    if (index !== at) expect(line).toEqual(before[index])
                })
                expect(after[at].text).toBe(`${before[at].text} edited`)
            }),
            fuzz(1000),
        )
    })
})
