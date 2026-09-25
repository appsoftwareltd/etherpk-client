/**
 * The seam between [[Frontmatter]] and body: the one edit shape that must never happen by
 * accident is body text joining onto the closing delimiter.
 */
import { describe, expect, it } from 'vitest'

import { crossesFrontmatterSeam as crosses, frontmatterWouldGrow, frontmatterWouldVanish } from './boundary'

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
