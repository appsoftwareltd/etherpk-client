/**
 * Property tests for a [[Block View]] (ADR 0209): what must hold after any run of the person's keys
 * on any Block of any outline, for any link to a Block, and for any line's title. The examples are
 * rows in `outliner-keymap.rules.test.ts`, `block-view-range.test.ts`, `block-link.test.ts` and
 * `block-title.test.ts`.
 *
 * - The lines outside the Block never change under the person's own keys, and a refused key changes
 *   nothing.
 * - The Block's own line keeps its indent, and stays the first line shown.
 * - A link to a Block finds that Block again, at its line when nothing changed, and as the same Block
 *   after lines are added above it.
 * - A title is never longer than its limit, and holds none of the markdown it reads past.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { blockFingerprintAt, findBlock } from '../block-link'
import { BLOCK_TITLE_LIMIT, blockTitleText } from '../block-title'
import { lineIndent } from '../outliner'
import { blockViewRange } from './block-view-range'
import { anchorLine, lineAnchor } from './line-anchor'
import { shownRange, shownRangeIn } from './shown-range'
import { collectRefusals, editorFixture, type HeadlessEditor } from './testing/editor-state-fixture'

/** A fixed seed keeps the suite deterministic; `EDITOR_FUZZ_SEED` and `EDITOR_FUZZ_RUNS` hunt. */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.EDITOR_FUZZ_SEED
    return { numRuns: Number(process.env.EDITOR_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261126 : Number(seed) }
}

// ── Generators ───────────────────────────────────────────────────────────────────────────────

/**
 * An outline: each bullet one level deeper than the one before it at most, every line's words its
 * own (`w3`) except a `Comments` bullet now and then, which journals repeat under many tasks.
 */
const outline: fc.Arbitrary<string[]> = fc
    .array(fc.record({ step: fc.integer({ min: -2, max: 1 }), comments: fc.boolean(), task: fc.boolean() }), { minLength: 2, maxLength: 10 })
    .map((rows) => {
        let depth = 0
        return rows.map(({ step, comments, task }, i) => {
            depth = i === 0 ? 0 : Math.max(0, depth + step)
            const words = comments && depth > 0 ? 'Comments' : `w${i}`
            return `${'  '.repeat(depth)}- ${task ? '[ ] ' : ''}${words}`
        })
    })

const KEYS = ['Backspace', 'Delete', 'Tab', 'Shift-Tab', 'Alt-ArrowUp', 'Alt-ArrowDown', 'Enter', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'Mod-a'] as const

/** An editor showing the Block on 1-based `line` of `lines`, and every refusal it dispatches. */
function showing(lines: string[], line: number): { editor: HeadlessEditor; refusals: ReturnType<typeof collectRefusals> } {
    const editor = editorFixture(`|${lines.join('\n')}`, { extensions: [lineAnchor(), shownRange(blockViewRange())] })
    editor.dispatch(editor.state.update({ effects: anchorLine.of(editor.state.doc.line(line).from) }))
    return { editor, refusals: collectRefusals(editor) }
}

/** The lines outside the Block, in order: every line once the Block has gone. */
function hiddenLines(editor: HeadlessEditor): string[] {
    const range = shownRangeIn(editor.state)
    const lines = editor.text().split('\n')
    if (!range) return lines
    const first = editor.state.doc.lineAt(range.from).number - 1
    const last = editor.state.doc.lineAt(range.to).number - 1
    return [...lines.slice(0, first), ...lines.slice(last + 1)]
}

/** Put the caret on a shown line, a fraction `at` of the way down, at its start or end. */
function placeCaret(editor: HeadlessEditor, at: number, atEnd: boolean): void {
    const range = shownRangeIn(editor.state)
    if (!range) return
    const first = editor.state.doc.lineAt(range.from).number
    const last = editor.state.doc.lineAt(range.to).number
    const line = editor.state.doc.line(first + Math.floor(at * (last - first + 1)))
    editor.select(atEnd ? line.to : line.from + line.text.indexOf('- ') + 2)
}

// ── Properties ───────────────────────────────────────────────────────────────────────────────

describe('a Block View, under any keys', () => {
    it('never changes a line outside the Block, never moves its own line, and a refused key changes nothing', () => {
        fc.assert(
            fc.property(
                outline,
                fc.nat(),
                fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
                fc.boolean(),
                fc.array(fc.constantFrom(...KEYS), { minLength: 1, maxLength: 6 }),
                (lines, pick, at, atEnd, keys) => {
                    const root = (pick % lines.length) + 1
                    const { editor, refusals } = showing(lines, root)
                    const indent = lineIndent(lines[root - 1])
                    placeCaret(editor, at, atEnd)
                    for (const key of keys) {
                        const range = shownRangeIn(editor.state)
                        // Everything shown was deleted: the View says the Block is gone, and takes no keys.
                        if (!range) break
                        const hidden = hiddenLines(editor)
                        const text = editor.text()
                        const refusedBefore = refusals.length
                        editor.key(key)
                        expect(hiddenLines(editor), `${key} changed a hidden line`).toEqual(hidden)
                        if (refusals.length > refusedBefore) expect(editor.text(), `${key} was refused but changed the text`).toBe(text)
                        const after = shownRangeIn(editor.state)
                        if (after) {
                            const own = editor.state.doc.lineAt(after.from)
                            expect(own.number, `${key} moved the Block's own line`).toBe(after.nestedUnder)
                            expect(lineIndent(own.text), `${key} changed the Block's indent`).toBe(indent)
                        }
                    }
                },
            ),
            fuzz(300),
        )
    })
})

describe('a link to a Block', () => {
    it('finds the Block at its line when nothing changed', async () => {
        await fc.assert(
            fc.asyncProperty(outline, fc.nat(), async (lines, pick) => {
                const line = pick % lines.length
                const fingerprint = (await blockFingerprintAt(lines, line))!
                const found = await findBlock(lines, line, fingerprint)
                // A repeated bullet nearer the line could be taken, but the line itself always matches.
                expect(found).toEqual({ line, foundBy: 'at_line' })
            }),
            fuzz(200),
        )
    })

    it('finds the same Block after top-level lines are added above it', async () => {
        await fc.assert(
            fc.asyncProperty(outline, fc.nat(), fc.integer({ min: 1, max: 4 }), async (lines, pick, added) => {
                const line = pick % lines.length
                const fingerprint = (await blockFingerprintAt(lines, line))!
                const later = [...Array.from({ length: added }, (_, i) => `- added${i}`), ...lines]
                const found = await findBlock(later, line, fingerprint)
                expect(found).not.toBeNull()
                // The Block or one that reads exactly as it does, under a parent that reads as its parent does.
                expect(await blockFingerprintAt(later, found!.line)).toBe(fingerprint)
            }),
            fuzz(200),
        )
    })
})

describe("a Block View's title", () => {
    /** Pieces of a line: words, links, nested links, marks, images and tags. */
    const piece = fc.constantFrom('beans', 'the shed', '[[Garden]]', '[[[[Garden]] Beds]]', '**bold**', '==mark==', '`code`', '~~old~~', '[shop](https://shop.example)', '![plan|300](../assets/plan.0a1b2c3d.png)', '#tag', 'a_b', '*it*')

    it('is never longer than its limit, and holds none of the markdown it reads past', () => {
        fc.assert(
            fc.property(fc.array(piece, { minLength: 1, maxLength: 40 }), fc.boolean(), (pieces, task) => {
                const title = blockTitleText(`- ${task ? '[ ] #P1 ' : ''}${pieces.join(' ')}`)
                expect(title.length).toBeLessThanOrEqual(BLOCK_TITLE_LIMIT)
                for (const marker of ['[[', ']]', '**', '==', '`', '~~', '](']) expect(title, marker).not.toContain(marker)
            }),
            fuzz(300),
        )
    })
})
