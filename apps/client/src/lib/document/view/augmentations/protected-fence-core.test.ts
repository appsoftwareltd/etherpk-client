import { describe, expect, it } from 'vitest'

import { CIPHER_FENCE_INFO } from '$lib/document/protection/fence-info'

import {
    changeTouchesProtected,
    clampOutsideFence,
    lockedCaretHome,
    protectedRanges,
    protectionWouldVanish,
} from './protected-fence-core'

const BODY = 'AQQAAAGZaLmAAGZha2UtZW52ZWxvcGU'

function doc(...lines: string[]): string {
    return lines.join('\n')
}

const FENCE = doc(`\`\`\`${CIPHER_FENCE_INFO}`, BODY, '```')
/** A Protected Document: frontmatter in the clear, the body one fence. */
const PROTECTED = doc('---', 'title: Bank', '---', FENCE)

describe('locating the protected range', () => {
    it('covers the whole-body fence, opener and closer included', () => {
        const [range] = protectedRanges(PROTECTED)

        expect(PROTECTED.slice(range.from, range.to)).toBe(FENCE)
    })

    it('covers a fence that is the entire document, with no frontmatter', () => {
        const [range] = protectedRanges(FENCE)

        expect([range.from, range.to]).toEqual([0, FENCE.length])
    })

    it('finds nothing in a document with no protected fence', () => {
        expect(protectedRanges(doc('# Notes', '```ts', 'const a = 1', '```'))).toEqual([])
    })

    // Protection is whole-document only (ADR 0060). A fence among other content is ordinary
    // markdown — a code block that happens to hold base64 — and gets no card and no guard.
    it('finds nothing in a document where the fence is not the whole body', () => {
        expect(protectedRanges(doc('# Notes', FENCE, 'after'))).toEqual([])
        expect(protectedRanges(doc(FENCE, 'prose', FENCE))).toEqual([])
    })

    it('ignores an unterminated fence, so a half-typed opener is still editable text', () => {
        expect(protectedRanges(doc(`\`\`\`${CIPHER_FENCE_INFO}`, BODY))).toEqual([])
    })
})

describe('refusing edits inside the fence (ADR 0028)', () => {
    // A single stray character typed into ciphertext makes the envelope undecryptable, so the
    // fence is atomic for EVERYONE — the key holder included, who edits through unlock and
    // re-encrypt instead.
    const ranges = protectedRanges(PROTECTED)
    const at = (needle: string) => PROTECTED.indexOf(needle)

    it('blocks a keystroke landing in the ciphertext', () => {
        const inside = at(BODY) + 3

        expect(changeTouchesProtected(ranges, [{ from: inside, to: inside }])).toBe(true)
    })

    it('blocks an edit to the opening fence line', () => {
        const inside = at(CIPHER_FENCE_INFO)

        expect(changeTouchesProtected(ranges, [{ from: inside, to: inside + 1 }])).toBe(true)
    })

    it('blocks a selection replacement that spans the fence', () => {
        expect(changeTouchesProtected(ranges, [{ from: 0, to: PROTECTED.length }])).toBe(true)
    })

    it('allows an edit entirely within the frontmatter above the fence', () => {
        const title = at('Bank')

        expect(changeTouchesProtected(ranges, [{ from: title, to: title + 4 }])).toBe(false)
    })

    it('allows a new line typed at either boundary', () => {
        const [range] = ranges

        expect(changeTouchesProtected(ranges, [{ from: range.from, to: range.from }])).toBe(false)
        expect(changeTouchesProtected(ranges, [{ from: range.to, to: range.to }])).toBe(false)
    })

    // Deleting the fence whole is how you delete a Protected Document's body, and it needs no
    // key — the same as any other member being able to delete content they cannot read.
    it('allows a deletion that exactly spans the fence and nothing else', () => {
        const [range] = ranges

        expect(changeTouchesProtected(ranges, [{ from: range.from, to: range.to }], { allowWholeFence: true })).toBe(
            false,
        )
    })

    it('still blocks a partial deletion when whole-fence removal is allowed', () => {
        const [range] = ranges

        expect(
            changeTouchesProtected(ranges, [{ from: range.from + 1, to: range.to }], { allowWholeFence: true }),
        ).toBe(true)
    })

    it('blocks a multi-range transaction if any range touches the fence', () => {
        const inside = at(BODY) + 1

        expect(changeTouchesProtected(ranges, [{ from: 1, to: 2 }, { from: inside, to: inside + 1 }])).toBe(true)
    })
})

// The frontmatter is editable in both states (ADR 0061); what it may not do on a Protected
// Document is vanish, because the title line would then be sealed into the ciphertext.
describe('where the caret may rest while locked', () => {
    const doc = '---\ntitle: Bank\n---\n```etherpk-cipher\nAAAA\n```'
    const ranges = protectedRanges(doc)
    const fenceFrom = doc.indexOf('```')
    const home = lockedCaretHome(doc, ranges)!

    it('goes home to the end of the last content line of the frontmatter', () => {
        expect(home).toBe('---\ntitle: Bank'.length)
        expect(lockedCaretHome('---\ntitle: Bank\naliases: [B]\n---\n```etherpk-cipher\nAAAA\n```')).toBe(
            '---\ntitle: Bank\naliases: [B]'.length,
        )
    })

    it('leaves a caret inside the frontmatter alone', () => {
        expect(clampOutsideFence(ranges, 0, home)).toBe(0)
        expect(clampOutsideFence(ranges, 7, home)).toBe(7)
        expect(clampOutsideFence(ranges, fenceFrom - 1, home)).toBe(fenceFrom - 1)
    })

    it('pulls a caret at or beyond the fence back home', () => {
        expect(clampOutsideFence(ranges, fenceFrom, home)).toBe(home)
        expect(clampOutsideFence(ranges, doc.length, home)).toBe(home)
    })

    it('rests at the start when there is no frontmatter', () => {
        const bare = '```etherpk-cipher\nAAAA\n```'
        expect(lockedCaretHome(bare)).toBe(0)
        expect(clampOutsideFence(protectedRanges(bare), 12, 0)).toBe(0)
    })

    it('does nothing for an ordinary document', () => {
        expect(lockedCaretHome('- prose')).toBeNull()
        expect(clampOutsideFence([], 12, 0)).toBe(12)
    })
})

describe('a locked document must stay protected', () => {
    const doc = '```etherpk-cipher\nAAAA\n```'

    it('refuses a character in front of the fence', () => {
        expect(protectionWouldVanish(doc, [{ from: 0, to: 0, inserted: 1 }], () => 'x' + doc)).toBe(true)
    })

    it('allows deleting the whole fence', () => {
        expect(protectionWouldVanish(doc, [{ from: 0, to: doc.length, inserted: 0 }], () => '')).toBe(false)
    })

    it('allows editing the frontmatter above it', () => {
        const withBlock = '---\ntitle: Bank\n---\n' + doc
        expect(protectionWouldVanish(withBlock, [{ from: 15, to: 15, inserted: 1 }], () => '---\ntitle: Banks\n---\n' + doc)).toBe(false)
    })

    it('is inert for an ordinary document', () => {
        expect(protectionWouldVanish('prose', [{ from: 0, to: 0, inserted: 1 }], () => 'xprose')).toBe(false)
    })
})
