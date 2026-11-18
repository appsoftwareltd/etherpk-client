/**
 * Properties of the Indent Unit normaliser (ADR 0067), which import, paste and the Formatting
 * Scan's indentation fix all run: over outlines with bullets, headings, prose, fenced blocks and
 * blank lines at random indents of spaces and tabs, it changes only leading whitespace, keeps every
 * line, comes back unchanged on its own output, and leaves no section under a top-level heading
 * starting indented.
 *
 * Fixed seeds keep the suite deterministic in CI. To hunt for new counterexamples, run with
 * `EDITOR_FUZZ_SEED=<n>` (any integer) and optionally `EDITOR_FUZZ_RUNS=<n>`.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { dedentHeadingSections, normaliseIndentUnit, outlineLines } from './indent-unit'

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.EDITOR_FUZZ_SEED
    return { numRuns: Number(process.env.EDITOR_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261118 : Number(seed) }
}

const indent = fc.constantFrom('', '', ' ', '  ', '  ', '   ', '    ', '      ', '\t', '\t\t', ' \t')
const prose = ['- beans', '- ', '-', '## Shed', '### Paint', '# Garden', 'note', '- ## Porch', 'x', '- [ ] water', '']
const fences = ['```', '- ```', '~~~']
const outlineOf = (indents: fc.Arbitrary<string>, bodies: string[]) =>
    fc.array(fc.tuple(indents, fc.constantFrom(...bodies)), { maxLength: 24 }).map((lines) => lines.map(([lead, text]) => lead + text).join('\n'))
/** Outlines at any indent of spaces and tabs, with fence lines, paired or not. */
const outline = outlineOf(indent, [...prose, ...fences])

/**
 * Pages as they are written, one section after another: a heading at column 0 (or the start of the
 * page), then an outline whose bullets nest one level at a time, with soft lines and fenced blocks
 * at their bullet's content column, blank lines, sub-headings beside the bullets and bullets
 * shallower than the first, the whole section shifted right by 0, 2 or 4 columns, as a page edited
 * elsewhere can leave it.
 */
const item = fc.record({ depth: fc.nat(3), kind: fc.constantFrom('bullet', 'bullet', 'bullet', 'soft', 'fence', 'blank', 'subheading', 'outdent') })
// Two columns at a time: an odd indent is the known gap below.
const section = fc.record({ shift: fc.constantFrom(0, 2, 4), items: fc.array(item, { maxLength: 10 }) })
const page = fc.array(section, { minLength: 1, maxLength: 3 }).map((sections) =>
    sections
        .flatMap(({ shift, items }, n) => {
            // Every section is under a heading at column 0: a page that starts with an indented list
            // and no heading is the walk's alone, as it was before the heading rule.
            const lines = [n > 0 ? '## Shed' : '# Garden']
            const pad = (columns: number) => ' '.repeat(shift + columns)
            // Each section starts with a bullet, as one under a heading does.
            lines.push(`${pad(0)}- beans`)
            let depth = 0 // the last bullet's depth
            for (const { depth: wanted, kind } of items) {
                // A blank line empty or holding whitespace to some depth, as editors leave them.
                if (kind === 'blank') lines.push(pad(2 * (wanted % 3)).slice(0, wanted === 3 ? 0 : undefined))
                else if (kind === 'outdent') {
                    // A bullet shallower than the section's first, as a copied range can end.
                    lines.push(`${' '.repeat(Math.max(0, shift - 2))}- peas`)
                    depth = 0
                }
                else if (kind === 'subheading') {
                    lines.push(`${pad(0)}### Paint`)
                    depth = -1
                } else if (kind === 'bullet') {
                    depth = Math.min(wanted, depth + 1)
                    lines.push(`${pad(2 * depth)}- beans`)
                } else if (depth >= 0 && kind === 'soft') lines.push(`${pad(2 * depth + 2)}note`)
                else if (depth >= 0 && kind === 'fence') lines.push(`${pad(2 * depth + 2)}\`\`\``, `${pad(2 * depth + 2)}  x`, `${pad(2 * depth + 2)}\`\`\``)
            }
            return lines
        })
        .join('\n'),
)

/**
 * What the outline makes of a text, depth aside (a bullet under a heading is the heading's child to
 * the walk until it is moved): each bullet's parent bullet, and each other non-blank line's owner.
 */
function structure(text: string): string[] {
    const lines = text.split('\n')
    const outline = outlineLines(lines)
    const open: { depth: number; line: number }[] = []
    return lines.map((line, i) => {
        const { depth, owner } = outline[i]
        if (owner === i) {
            while (open.length && open[open.length - 1].depth >= depth) open.pop()
            const parent = open.length ? open[open.length - 1].line : -1
            open.push({ depth, line: i })
            return `bullet under ${parent}`
        }
        if (owner === -1) while (open.length && open[open.length - 1].depth >= depth) open.pop()
        return line.trim() === '' ? 'blank' : `owned by ${owner}`
    })
}

/** A text's lines without their leading spaces and tabs: what the normaliser must never change. */
const content = (text: string) => text.split('\n').map((line) => line.replace(/^[ \t]+/, ''))

describe('normaliseIndentUnit', () => {
    it('changes only leading whitespace and keeps every line', () => {
        fc.assert(
            fc.property(outline, (text) => {
                expect(content(normaliseIndentUnit(text))).toEqual(content(text))
            }),
            fuzz(2000),
        )
    })

    it('is idempotent on pages as they are written, and leaves each section under its heading at column 0', () => {
        fc.assert(
            fc.property(page, (text) => {
                const once = normaliseIndentUnit(text)
                expect(content(once)).toEqual(content(text))
                expect(normaliseIndentUnit(once), JSON.stringify(text)).toBe(once)
                // No bullet is left indented with no bullet above it: a section starts at column 0.
                const lines = once.split('\n')
                lines.forEach((line, i) => {
                    if (!/^ +- /.test(line)) return
                    const above = lines.slice(0, i).reverse().find((l) => l.trim() !== '')
                    expect(above === undefined || /^#/.test(above), JSON.stringify(text)).toBe(false)
                })
            }),
            fuzz(2000),
        )
    })

    // Known gap (Roadmap, Formatting Scan): at odd indents or tabs, a prose line is never re-led
    // while the bullets around it move, so some pages need a second pass, e.g. "- beans\n x\n - beans"
    // goes to "- beans\n x\n  - beans" and then to "- beans\n x\n   - beans"... It was there before
    // the heading rule. Turn this into `it` once the normaliser settles in one pass on any grid.
    it.fails('is idempotent at any indent of spaces and tabs', () => {
        fc.assert(
            fc.property(outline, (text) => {
                const once = normaliseIndentUnit(text)
                expect(normaliseIndentUnit(once), JSON.stringify(text)).toBe(once)
            }),
            fuzz(2000),
        )
    })

    it('keeps every bullet\'s parent bullet and every line\'s owner, on pages as they are written', () => {
        fc.assert(
            fc.property(page, (text) => {
                expect(structure(normaliseIndentUnit(text)), JSON.stringify(text)).toEqual(structure(text))
            }),
            fuzz(2000),
        )
    })

    it('leaves no section under a top-level heading to shift once it has run', () => {
        fc.assert(
            fc.property(outline, (text) => {
                const lines = normaliseIndentUnit(text).split('\n')
                expect(dedentHeadingSections(lines), JSON.stringify(text)).toBe(lines)
            }),
            fuzz(2000),
        )
    })
})
