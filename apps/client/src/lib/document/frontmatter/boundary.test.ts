/**
 * The seam between [[Frontmatter]] and body: the one edit shape that must never happen by
 * accident is body text joining onto the closing delimiter.
 */
import { describe, expect, it } from 'vitest'

import {
    crossesFrontmatterSeam as crosses,
    frontmatterWouldGrow,
    frontmatterWouldVanish,
    joinsFrontmatterDelimiter as joins,
    removesClosingDelimiter as removesCloser,
} from './boundary'

const DOC = '---\ntitle: Kanban\n---\nfirst line\nsecond'
const SEAM = DOC.indexOf('\nfirst') // the terminator that ends the closing delimiter
const BODY = SEAM + 1

/** Apply one or more deletions/replacements to `text`, last range first so offsets hold. */
function apply(text: string, changes: { from: number; to: number; insert?: string }[]): string {
    return [...changes]
        .sort((a, b) => b.from - a.from)
        .reduce((t, c) => t.slice(0, c.from) + (c.insert ?? '') + t.slice(c.to), text)
}

const crossesFrontmatterSeam = (text: string, changes: { from: number; to: number; insert?: string }[]) =>
    crosses(text, changes, () => apply(text, changes))

describe('crossesFrontmatterSeam', () => {
    it('refuses Backspace at the start of the first body line', () => {
        expect(crossesFrontmatterSeam(DOC, [{ from: SEAM, to: BODY }])).toBe(true)
    })

    it('refuses Delete at the end of the closing delimiter - the same join from the other side', () => {
        expect(crossesFrontmatterSeam(DOC, [{ from: SEAM, to: SEAM + 1 }])).toBe(true)
    })

    it('refuses a selection from inside the block into the body, deleted or replaced', () => {
        expect(crossesFrontmatterSeam(DOC, [{ from: 10, to: BODY + 3 }])).toBe(true)
    })

    it('allows a body-only edit, including deleting the whole first line', () => {
        expect(crossesFrontmatterSeam(DOC, [{ from: BODY, to: BODY + 'first line\n'.length }])).toBe(false)
        expect(crossesFrontmatterSeam(DOC, [{ from: BODY, to: BODY }])).toBe(false)
    })

    it('allows an edit inside the block, even one that breaks a delimiter while typing', () => {
        expect(crossesFrontmatterSeam(DOC, [{ from: 11, to: 17 }])).toBe(false)
        expect(crossesFrontmatterSeam(DOC, [{ from: SEAM, to: SEAM }])).toBe(false)
    })

    it('allows replacing the document from its start - the block goes whole, not joined', () => {
        expect(crossesFrontmatterSeam(DOC, [{ from: 0, to: DOC.length }])).toBe(false)
        expect(crossesFrontmatterSeam(DOC, [{ from: 0, to: BODY + 3 }])).toBe(false)
    })

    it('allows removing the terminator when nothing follows it - the block simply ends the document', () => {
        const bare = '---\ntitle: Kanban\n---\n'
        expect(crossesFrontmatterSeam(bare, [{ from: bare.length - 1, to: bare.length }])).toBe(false)
    })

    it('allows a deletion from inside the block to the very end, which dissolves the block on purpose', () => {
        expect(crossesFrontmatterSeam(DOC, [{ from: 10, to: DOC.length }])).toBe(false)
    })

    it('is inert with no block, and for a block that ends the document', () => {
        expect(crossesFrontmatterSeam('first\nsecond', [{ from: 5, to: 6 }])).toBe(false)
        expect(crossesFrontmatterSeam('---\ntitle: K\n---', [{ from: 12, to: 13 }])).toBe(false)
    })

    it('refuses deleting the closing delimiter line whole, terminator included', () => {
        const closer = DOC.indexOf('---\nfirst')
        expect(crossesFrontmatterSeam(DOC, [{ from: closer, to: BODY }])).toBe(true)
    })

    it('allows an undo that removes the terminator it inserted, leaving the one that was there', () => {
        // Enter at the end of the closing delimiter put a second terminator at the seam; undoing
        // it deletes one of the two and the block is intact. Undo is dispatched past the editor's
        // filters, so this must be allowed by the rule, not merely never reach it.
        const doubled = DOC.slice(0, SEAM) + '\n' + DOC.slice(SEAM)
        expect(crossesFrontmatterSeam(doubled, [{ from: SEAM, to: SEAM + 1 }])).toBe(false)
    })

    it('never materialises the new document for a change that leaves the seam alone', () => {
        let asked = false
        expect(crosses(DOC, [{ from: BODY, to: BODY + 2 }], () => ((asked = true), ''))).toBe(false)
        expect(asked).toBe(false)
    })

    it('judges every range of a multi-range change', () => {
        expect(crossesFrontmatterSeam(DOC, [{ from: BODY + 1, to: BODY + 2 }, { from: SEAM, to: BODY }])).toBe(true)
    })
})

describe('refusing an edit that would make the frontmatter vanish', () => {
    const before = '---\ntitle: Bank\n---\nbody'
    const prefix = '---\ntitle: Bank\n---\n'.length

    it('refuses deleting a delimiter', () => {
        const after = '---\ntitle: Bank\nbody'
        expect(frontmatterWouldVanish(before, [{ from: prefix - 4, to: prefix }], () => after)).toBe(true)
    })

    it('allows editing the title, and closing the block early', () => {
        expect(frontmatterWouldVanish(before, [{ from: 11, to: 15 }], () => '---\ntitle: Savings\n---\nbody')).toBe(false)
        expect(frontmatterWouldVanish(before, [{ from: 4, to: 4 }], () => '---\n---\ntitle: Bank\n---\nbody')).toBe(false)
    })

    it('never materialises the new document for an edit below the block', () => {
        let asked = false
        expect(
            frontmatterWouldVanish(before, [{ from: prefix + 2, to: prefix + 2 }], () => {
                asked = true
                return ''
            }),
        ).toBe(false)
        expect(asked).toBe(false)
    })

    it('is inert for a document that had no block', () => {
        expect(frontmatterWouldVanish('body', [{ from: 0, to: 0 }], () => '')).toBe(false)
    })
})

describe('the block may hold only text typed into it', () => {
    const before = '---\ntitle: Bank\n---\nsecret line\n---\nmore'
    const closer = before.indexOf('---\nsecret') // the closing delimiter's start

    it('refuses deleting the closing delimiter when a rule below would close the block instead', () => {
        const after = '---\ntitle: Bank\nsecret line\n---\nmore'
        expect(frontmatterWouldGrow(before, [{ from: closer, to: closer + 4, inserted: 0 }], () => after)).toBe(true)
    })

    it('allows typing inside the block, which grows it by exactly what was typed', () => {
        const after = '---\ntitle: Bank\naliases: [B]\n---\nsecret line\n---\nmore'
        expect(frontmatterWouldGrow(before, [{ from: 15, to: 15, inserted: 13 }], () => after)).toBe(false)
    })

    it('allows a block to appear where there was none', () => {
        expect(frontmatterWouldGrow('secret\n---\nmore', [{ from: 0, to: 0, inserted: 4 }], () => '---\nsecret\n---\nmore')).toBe(false)
    })

    it('ignores edits below the block', () => {
        let asked = false
        expect(frontmatterWouldGrow(before, [{ from: 30, to: 30, inserted: 1 }], () => { asked = true; return '' })).toBe(false)
        expect(asked).toBe(false)
    })

    // Reported: the text a page was created with could not be deleted once the page was
    // protected. Backspace on its first character starts exactly at the block's end, and the
    // guard counted that as touching the block - the block had not grown, but the change's net
    // length was negative, so "no larger than before plus net" read as growth.
    it('allows deleting the first body character', () => {
        const page = '---\ntitle: Router\n---\nabc'
        const bodyStart = '---\ntitle: Router\n---\n'.length
        const after = '---\ntitle: Router\n---\nbc'
        expect(frontmatterWouldVanish(page, [{ from: bodyStart, to: bodyStart + 1 }], () => after)).toBe(false)
        expect(frontmatterWouldGrow(page, [{ from: bodyStart, to: bodyStart + 1, inserted: 0 }], () => after)).toBe(false)
    })

    it('allows deleting the whole body from its first character', () => {
        const page = '---\ntitle: Router\n---\nabc'
        const bodyStart = '---\ntitle: Router\n---\n'.length
        const after = '---\ntitle: Router\n---\n'
        expect(frontmatterWouldGrow(page, [{ from: bodyStart, to: bodyStart + 3, inserted: 0 }], () => after)).toBe(false)
    })

    it('still refuses a change inside the block that closes it further down', () => {
        const page = '---\ntitle: Router\n---\nabc\n---\nmore'
        const closer = page.indexOf('---\nabc')
        const after = '---\ntitle: Router\nabc\n---\nmore'
        expect(frontmatterWouldGrow(page, [{ from: closer, to: closer + 4, inserted: 0 }], () => after)).toBe(true)
    })
})

describe('joinsFrontmatterDelimiter', () => {
    const joinsFrontmatterDelimiter = (text: string, changes: { from: number; to: number; insert?: string }[]) =>
        joins(text, changes, () => apply(text, changes))
    const BEFORE_CLOSER = DOC.indexOf('\n---\nfirst') // the line break before the closing delimiter
    const AFTER_OPENER = DOC.indexOf('\n') // the line break that ends the opening delimiter

    it('refuses joining the closing delimiter onto the block’s last line, from either side of the break', () => {
        expect(joinsFrontmatterDelimiter(DOC, [{ from: BEFORE_CLOSER, to: BEFORE_CLOSER + 1 }])).toBe(true)
    })

    it('refuses joining the block’s first line onto the opening delimiter', () => {
        expect(joinsFrontmatterDelimiter(DOC, [{ from: AFTER_OPENER, to: AFTER_OPENER + 1 }])).toBe(true)
    })

    it('refuses a selection inside the block that ends at the closing delimiter, deleted or replaced', () => {
        expect(joinsFrontmatterDelimiter(DOC, [{ from: 6, to: BEFORE_CLOSER + 1 }])).toBe(true)
        expect(joinsFrontmatterDelimiter(DOC, [{ from: 6, to: BEFORE_CLOSER + 1, insert: 'x' }])).toBe(true)
    })

    it('refuses the join in an empty block, and in a block that ends the document', () => {
        const empty = '---\n---\nbody'
        expect(joinsFrontmatterDelimiter(empty, [{ from: 3, to: 4 }])).toBe(true)
        const bare = '---\ntitle: K\n---'
        expect(joinsFrontmatterDelimiter(bare, [{ from: 12, to: 13 }])).toBe(true)
    })

    it('allows editing a delimiter’s dashes, and an edit inside the block', () => {
        const closer = DOC.indexOf('---\nfirst')
        expect(joinsFrontmatterDelimiter(DOC, [{ from: closer + 2, to: closer + 3 }])).toBe(false)
        expect(joinsFrontmatterDelimiter(DOC, [{ from: 11, to: 17 }])).toBe(false)
    })

    it('allows removing the block from the document start, or everything to the end', () => {
        expect(joinsFrontmatterDelimiter(DOC, [{ from: 0, to: BEFORE_CLOSER + 1 }])).toBe(false)
        expect(joinsFrontmatterDelimiter(DOC, [{ from: 6, to: DOC.length }])).toBe(false)
    })

    it('refuses a change through the closing line too, which deletes the break before it (the removal rule names it first)', () => {
        const closerLine = BEFORE_CLOSER + '\n---'.length
        expect(joinsFrontmatterDelimiter(DOC, [{ from: BEFORE_CLOSER, to: closerLine }])).toBe(true)
        expect(joinsFrontmatterDelimiter(DOC, [{ from: BEFORE_CLOSER, to: closerLine - 1 }])).toBe(true)
    })

    it('is inert with no block, and when the block survives (a break inside the block that keeps both delimiters)', () => {
        expect(joinsFrontmatterDelimiter('first\nsecond', [{ from: 5, to: 6 }])).toBe(false)
        const two = '---\ntitle: K\ntags: x\n---\nbody'
        expect(joinsFrontmatterDelimiter(two, [{ from: 12, to: 13 }])).toBe(false) // joins two YAML lines
    })
})

describe('removesClosingDelimiter', () => {
    const removesClosingDelimiter = (text: string, changes: { from: number; to: number; insert?: string }[]) =>
        removesCloser(text, changes, () => apply(text, changes))
    const CLOSER = DOC.indexOf('---\nfirst') // the closing delimiter's line

    it('refuses taking the closing line out whole, with the line break before it or after it, deleted or typed over', () => {
        // A cut makes the first shape; the keymap's smallest change for Backspace or Delete over the line, the second.
        expect(removesClosingDelimiter(DOC, [{ from: CLOSER - 1, to: CLOSER + 3 }])).toBe(true)
        expect(removesClosingDelimiter(DOC, [{ from: CLOSER, to: CLOSER + 4 }])).toBe(true)
        expect(removesClosingDelimiter(DOC, [{ from: CLOSER - 1, to: CLOSER + 3, insert: 'x' }])).toBe(true)
    })

    it('allows deleting the dashes, which leaves the line, and a removal that leaves a block for the growth rule', () => {
        expect(removesClosingDelimiter(DOC, [{ from: CLOSER, to: CLOSER + 3 }])).toBe(false)
        const ruled = `${DOC}\n---\nmore`
        expect(removesClosingDelimiter(ruled, [{ from: CLOSER, to: CLOSER + 4 }])).toBe(false)
    })

    it('refuses a selection from anywhere in the block through the closing line, as Shift+Down from inside the last key makes', () => {
        expect(removesClosingDelimiter(DOC, [{ from: DOC.indexOf('anban'), to: CLOSER + 3 }])).toBe(true)
        const two = '---\na: 1\nb: 2\n---\nbody'
        expect(removesClosingDelimiter(two, [{ from: two.indexOf('1'), to: two.indexOf('---\nbody') + 3 }])).toBe(true)
    })

    it('refuses it on a page with no body, and on a block that ends the document', () => {
        const empty = '---\ntitle: K\n---\n'
        expect(removesClosingDelimiter(empty, [{ from: 13, to: 17 }])).toBe(true) // the line and the break after it, to the end
        expect(removesClosingDelimiter(empty, [{ from: 12, to: 16 }])).toBe(true)
        // The keymap's tidy takes the blank line a delete would leave there, so the change takes both line breaks.
        expect(removesClosingDelimiter(empty, [{ from: 12, to: 17 }])).toBe(true)
        const bare = '---\ntitle: K\n---'
        expect(removesClosingDelimiter(bare, [{ from: 12, to: 16 }])).toBe(true)
        // With a body after, that change joins the body onto the last key: the seam rule's to refuse.
        expect(removesClosingDelimiter(DOC, [{ from: CLOSER - 1, to: CLOSER + 4 }])).toBe(false)
        expect(crossesFrontmatterSeam(DOC, [{ from: CLOSER - 1, to: CLOSER + 4 }])).toBe(true)
    })

    it('allows removing the block from its start, and is inert with no block', () => {
        expect(removesClosingDelimiter(DOC, [{ from: 0, to: CLOSER + 3 }])).toBe(false)
        expect(removesClosingDelimiter('first\n---\nsecond', [{ from: 5, to: 9 }])).toBe(false)
    })
})
