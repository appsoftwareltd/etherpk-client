/**
 * The registry of Formatting Checks (ADR 0109) and the properties every check keeps: it never
 * throws, its fix rewrites lines in place or inserts lines, and a fixed text has nothing left for it
 * to fix.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { FORMATTING_CHECKS, findIssues } from './checks'
import { checkedText } from './finding'
import { lineSplices, splitLines } from './line-diff'

/** Text built from the pieces the checks read, so random documents hit their cases often. */
const documentText = fc
    .array(
        fc.constantFrom(
            '- ',
            '* ',
            '+ ',
            '1. ',
            '> ',
            '# ',
            '---',
            '```',
            '````',
            '```js',
            'a',
            'b ',
            ' ',
            '  ',
            '\t',
            '\u{a0}',
            '\u{3000}',
            '\n',
            '\r\n',
            '\r',
            '[ ] ',
        ),
        { maxLength: 60 },
    )
    .map((parts) => parts.join(''))

function applySplices(text: string, splices: readonly { from: number; to: number; insert: string }[]): string {
    let out = text
    for (const s of [...splices].reverse()) out = out.slice(0, s.from) + s.insert + out.slice(s.to)
    return out
}

describe('the registry', () => {
    it('lists the checks in the order a page shows their issues, the report-only one last', () => {
        expect(FORMATTING_CHECKS.map((c) => c.id)).toEqual(['no-break-space-indent', 'bullet-marker', 'indentation', 'blank-line-after-list', 'line-endings', 'unclosed-fence'])
    })

    it("finds a page's issues in that order", () => {
        const text = '* a\r\n\t- b\r\n- c\r\nd\r\n\u{a0}- e\r\n```js'
        expect(findIssues(text).map((f) => f.check)).toEqual(['no-break-space-indent', 'bullet-marker', 'indentation', 'blank-line-after-list', 'line-endings', 'unclosed-fence'])
    })

    it('finds nothing on a page EtherPK wrote', () => {
        expect(findIssues('---\ntitle: A\n---\n- a\n  - b\n    ```js\n    x\n    ```\n- c\n')).toEqual([])
    })
})

describe('every check', () => {
    it('reads any text without throwing', () => {
        fc.assert(
            fc.property(documentText, (text) => {
                for (const check of FORMATTING_CHECKS) check.find(checkedText(text))
            }),
        )
    })

    it('fixes by rewriting lines in place or inserting lines, keeping every other line, with splices that reproduce the fix', () => {
        fc.assert(
            fc.property(documentText, (text) => {
                for (const check of FORMATTING_CHECKS) {
                    const finding = check.find(checkedText(text))
                    if (finding?.fixed == null) continue
                    const was = splitLines(text)
                    const now = splitLines(finding.fixed)
                    if (now.length !== was.length) {
                        // Inserted lines, one before each flagged line: taking them out gives the page back.
                        const inserted = new Set(finding.lines.map((line, k) => line + k))
                        expect(now).toHaveLength(was.length + finding.lines.length)
                        expect(now.filter((_, i) => !inserted.has(i))).toEqual(was)
                    }
                    expect(applySplices(text, lineSplices(text, finding.fixed))).toBe(finding.fixed)
                }
            }),
        )
    })

    it('leaves nothing for itself to fix once its fix is applied', () => {
        fc.assert(
            fc.property(documentText, (text) => {
                for (const check of FORMATTING_CHECKS) {
                    const fixed = check.find(checkedText(text))?.fixed
                    if (fixed == null) continue
                    expect(check.find(checkedText(fixed)), `${check.id} on ${JSON.stringify(text)}`).toBeNull()
                }
            }),
        )
    })

    it('together settle: approving the first fixable issue each time leaves nothing within one fix per check', () => {
        // One fix can create work for another (a `*` item made a `-` bullet may be off the grid, and
        // a bullet put on the grid may need a blank line after its list), which is why a page is
        // re-checked after every fix; it must never go round for ever. One fix per check, as there is
        // one fix fewer than checks, leaves room for the indentation fix's second pass over some
        // off-grid pages (a known gap: the Roadmap's Formatting Scan items).
        fc.assert(
            fc.property(documentText, (text) => {
                let current = text
                for (let fix = 0; fix < FORMATTING_CHECKS.length; fix++) {
                    const next = findIssues(current).find((found) => found.finding.fixed !== null)
                    if (!next) return
                    current = next.finding.fixed!
                }
                expect(findIssues(current).filter((found) => found.finding.fixed !== null), JSON.stringify(text)).toEqual([])
            }),
        )
    })

    it('flags exactly the lines its fix changes, when it rewrites lines in place', () => {
        fc.assert(
            fc.property(documentText, (text) => {
                for (const check of FORMATTING_CHECKS) {
                    const finding = check.find(checkedText(text))
                    if (finding?.fixed == null) continue
                    const was = splitLines(text)
                    const now = splitLines(finding.fixed)
                    if (now.length !== was.length) continue // an insertion, flagged at the lines after it (above)
                    const changed = was.flatMap((line, i) => (line.text === now[i].text && line.ending === now[i].ending ? [] : [i]))
                    expect(finding.lines).toEqual(changed)
                }
            }),
        )
    })
})
