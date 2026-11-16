/**
 * Property tests over the pure fence scan, `fencedBlocks` (Editor Content Rules → Fenced Code Blocks
 * → "Inside a block": column-scoped pairing). The rows in `fenced-code.test.ts` pin the documented
 * cases one at a time; these state the pairing rules as sentences that must hold for any text, and
 * let fast-check look for text that breaks them.
 *
 * The generated lines are the shapes that broke the pairing before: bare and info fences of three to
 * five backticks at several columns, bullet fences (`- \`\`\``), blank lines written empty or as
 * spaces, tab indents, text that dedents below a fence, and the same text with CRLF line ends.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { type FencedBlockRange, fencedBlocks, fenceLineInfo } from './fenced-code'

/**
 * Fixed seeds keep the suite deterministic in CI. To hunt for new counterexamples, run with
 * `EDITOR_FUZZ_SEED=<n>` (any integer) and optionally `EDITOR_FUZZ_RUNS=<n>`.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.EDITOR_FUZZ_SEED
    return {
        numRuns: Number(process.env.EDITOR_FUZZ_RUNS ?? runs),
        seed: seed === undefined ? 20261116 : Number(seed),
    }
}

// ── Generators ───────────────────────────────────────────────────────────────────────────────

const indentArb = fc.constantFrom('', '', ' ', '  ', '  ', '   ', '    ', '      ', '\t')
const runArb = fc.constantFrom('```', '```', '````', '`````')
const infoArb = fc.constantFrom('', '', 'py', 'js', 'md')
const wordArb = fc.constantFrom('water the beans', 'Garden', 'return 1', '- x', '# c', '- [ ] buy seeds', 'if x:')

/** One line of text, weighted towards fence lines so that pairing decisions happen often. */
const lineArb: fc.Arbitrary<string> = fc.oneof(
    { weight: 4, arbitrary: fc.tuple(indentArb, runArb, infoArb).map(([i, r, info]) => `${i}${r}${info}`) },
    { weight: 1, arbitrary: fc.tuple(indentArb, runArb, infoArb).map(([i, r, info]) => `${i}- ${r}${info}`) },
    { weight: 3, arbitrary: fc.tuple(indentArb, wordArb).map(([i, w]) => `${i}${w}`) },
    { weight: 1, arbitrary: fc.tuple(indentArb, wordArb).map(([i, w]) => `${i}- ${w}`) },
    { weight: 2, arbitrary: fc.constantFrom('', '  ', '    ') },
)

const linesArb = fc.array(lineArb, { minLength: 0, maxLength: 14 })

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

const indentOf = (line: string) => line.length - line.trimStart().length
const key = (b: FencedBlockRange) => `${b.start}:${b.end}:${b.fenceColumn}`

/** A line that would close an open fence `open`: a bare, non-bullet fence of the same length. */
function wouldClose(line: string, open: string): boolean {
    const f = fenceLineInfo(line)
    const o = fenceLineInfo(open)
    return f !== null && o !== null && f.info === '' && !f.bullet && f.char === o.char && f.len === o.len && f.col === o.col
}

describe('the fence scan pairs openers and closers by the documented rules', () => {
    it('an opener pairs only with a bare closer at its own column, of exactly its own length', () => {
        // "An opener pairs only with a bare closer (no info-string) at its own column and of exactly
        // its own length." and "An info-bearing fence and a bullet fence can never close anything."
        fc.assert(
            fc.property(linesArb, (lines) => {
                for (const b of fencedBlocks(lines)) {
                    const opener = fenceLineInfo(lines[b.start])
                    const closer = fenceLineInfo(lines[b.end])
                    expect(opener, JSON.stringify({ lines, b })).not.toBeNull()
                    expect(closer, JSON.stringify({ lines, b })).not.toBeNull()
                    expect(b.start).toBeLessThan(b.end)
                    expect(opener!.col).toBe(b.fenceColumn)
                    expect(closer!.col).toBe(b.fenceColumn)
                    expect(closer!.len).toBe(opener!.len)
                    expect(closer!.info).toBe('')
                    expect(closer!.bullet).toBe(false)
                }
            }),
            fuzz(1000),
        )
    })

    it('a closer is consumed once, and blocks nest or are disjoint, a nested one in a deeper column', () => {
        // "A closer is consumed once." Blocks nest or are disjoint, never overlap partly
        // (fencedBlockTree), and a fence nested in a block sits deeper than its fence column.
        fc.assert(
            fc.property(linesArb, (lines) => {
                const blocks = fencedBlocks(lines)
                const fenceLines = blocks.flatMap((b) => [b.start, b.end])
                expect(new Set(fenceLines).size, JSON.stringify(lines)).toBe(fenceLines.length)
                for (const a of blocks) {
                    for (const b of blocks) {
                        if (a === b) continue
                        const disjoint = a.end < b.start || b.end < a.start
                        const aInB = b.start < a.start && a.end < b.end
                        const bInA = a.start < b.start && b.end < a.end
                        expect(disjoint || aInB || bInA, JSON.stringify({ lines, a, b })).toBe(true)
                        if (aInB) expect(a.fenceColumn).toBeGreaterThan(b.fenceColumn)
                    }
                }
            }),
            fuzz(1000),
        )
    })

    it('no non-blank line inside a block sits left of its fence column', () => {
        // "A non-blank line that dedents below an open fence's column abandons that fence (its closer
        // must live in the same outliner block)." The left clamp in the scan's own terms.
        fc.assert(
            fc.property(linesArb, (lines) => {
                for (const b of fencedBlocks(lines)) {
                    for (let i = b.start + 1; i < b.end; i++) {
                        if (lines[i].trim() === '') continue
                        expect(indentOf(lines[i]), JSON.stringify({ lines, b, i })).toBeGreaterThanOrEqual(b.fenceColumn)
                    }
                }
            }),
            fuzz(1000),
        )
    })

    it('pairing is first-with-next: no line inside a block could have closed it earlier', () => {
        // A closer is the NEXT bare fence at the opener's column and length; one sitting inside the
        // block would have closed it there.
        fc.assert(
            fc.property(linesArb, (lines) => {
                for (const b of fencedBlocks(lines)) {
                    for (let i = b.start + 1; i < b.end; i++) {
                        expect(wouldClose(lines[i], lines[b.start]), JSON.stringify({ lines, b, i })).toBe(false)
                    }
                }
            }),
            fuzz(1000),
        )
    })

    it('an unterminated opener yields no block: an opener with nothing that can close it below is in none', () => {
        // "An unterminated opener yields no block — its region stays plain text until completed."
        fc.assert(
            fc.property(linesArb, (lines) => {
                const blocks = fencedBlocks(lines)
                lines.forEach((line, i) => {
                    const f = fenceLineInfo(line)
                    if (!f) return
                    const closable = lines.slice(i + 1).some((l) => wouldClose(l, line))
                    if (closable) return
                    // Nothing below can close it: it opens no block (it may still be content of one).
                    expect(blocks.some((b) => b.start === i), JSON.stringify({ lines, i })).toBe(false)
                })
            }),
            fuzz(1000),
        )
    })

    it('a line added after a block never changes it: the scan reads each block from the text above its closer', () => {
        // "Stray or orphaned backticks elsewhere in a document can never interfere with a block" holds
        // for everything below a block's closer without condition: every block of a prefix of the
        // text is a block of the whole.
        fc.assert(
            fc.property(linesArb, linesArb, (head, tail) => {
                const whole = new Set(fencedBlocks([...head, ...tail]).map(key))
                for (const b of fencedBlocks(head)) expect(whole.has(key(b)), JSON.stringify({ head, tail, b })).toBe(true)
            }),
            fuzz(1000),
        )
    })

    it('a stray fence outside every block, at another column or past a dedent, leaves every block as it was', () => {
        // "Fences outside the block simply do not count toward its balance." Above a block the scan
        // reads first-with-next, so the stray must be one the block's own opener cannot meet: in another
        // column, cut off by a line that dedents below it, or shorter than the block's run (a longer
        // run replaces it: "A ```` block therefore stays whole beneath a dangling ```").
        fc.assert(
            fc.property(linesArb, fc.nat(), fc.tuple(indentArb, runArb, infoArb, fc.boolean()), (lines, at, [indent, run, info, bullet]) => {
                const blocks = fencedBlocks(lines)
                // Insert between two lines that no block spans.
                const gaps = Array.from({ length: lines.length + 1 }, (_, k) => k).filter((k) => !blocks.some((b) => b.start < k && k <= b.end))
                const gap = gaps[at % gaps.length]
                const stray = bullet ? `${indent}- ${run}${info}` : `${indent}${run}${info}`
                const strayInfo = fenceLineInfo(stray)!
                const after = [...lines.slice(0, gap), stray, ...lines.slice(gap)]
                const found = new Set(fencedBlocks(after).map(key))
                for (const b of blocks) {
                    const shifted = { ...b, start: b.start >= gap ? b.start + 1 : b.start, end: b.end >= gap ? b.end + 1 : b.end }
                    const below = gap <= b.start
                    if (below) {
                        const own = fenceLineInfo(lines[b.start])!
                        const cutOff = lines.slice(gap, b.start).some((l) => l.trim() !== '' && indentOf(l) < strayInfo.col)
                        const meets = strayInfo.col === b.fenceColumn && !cutOff && strayInfo.len >= own.len
                        if (meets) continue
                    }
                    expect(found.has(key(shifted)), JSON.stringify({ lines, stray, gap, b })).toBe(true)
                }
            }),
            fuzz(1000),
        )
    })

    it('CRLF line ends pair exactly as LF ones do', () => {
        // A file written on Windows reaches the Derived Index with `\r` at the end of each line once
        // split on `\n`; the scan must read the same blocks the editor (which normalises) reads.
        fc.assert(
            fc.property(linesArb, (lines) => {
                expect(fencedBlocks(lines.map((l) => `${l}\r`)), JSON.stringify(lines)).toEqual(fencedBlocks(lines))
            }),
            fuzz(1000),
        )
    })
})
