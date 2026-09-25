import { describe, expect, it } from 'vitest'

import { branchEnds } from './outline-guides-core'

/** Indices of lines that get a guide thread (a bullet whose branch extends past itself). */
const threaded = (text: string) => {
    const ends = branchEnds(text.split('\n'))
    return ends.map((end, i) => (end > i ? i : -1)).filter((i) => i >= 0)
}

describe('branchEnds — outline thread structure', () => {
    it('a flat list has no threads', () => {
        expect(threaded('- a\n- b\n- c')).toEqual([])
    })

    it('a parent with children threads from the parent', () => {
        // Each bullet's end is the last line of its branch (its own index when childless); non-bullets
        // are -1. Only `end > i` draws a thread.
        expect(branchEnds('- parent\n  - c1\n  - c2'.split('\n'))).toEqual([2, 1, 2])
        expect(threaded('- parent\n  - c1\n  - c2')).toEqual([0])
    })

    it('nested parents each get their own thread', () => {
        // 0 "- a" → end 4; 1 "  - b" → end 4; 2..4 are b's childless leaves (end == own index)
        const doc = ['- a', '  - b', '    - c', '    - d', '    - e']
        expect(branchEnds(doc)).toEqual([4, 4, 2, 3, 4])
        expect(threaded(doc.join('\n'))).toEqual([0, 1])
    })

    it("a sibling at the parent's level ends the branch before it", () => {
        // "- p" owns lines 1..2; line 3 "- q" is a childless sibling → no thread
        expect(branchEnds('- p\n  - c1\n  - c2\n- q'.split('\n'))).toEqual([2, 1, 2, 3])
        expect(threaded('- p\n  - c1\n  - c2\n- q')).toEqual([0])
    })

    it('a bare empty line is a group boundary — the thread breaks at a Ctrl-Enter split (ADR 0021)', () => {
        // The column-0 empty line at line 2 bounds the group: p's thread ends at c1, and c2 starts a
        // fresh group below the split (the "odd but allowable" orphan indent).
        expect(branchEnds('- p\n  - c1\n\n  - c2'.split('\n'))).toEqual([1, 1, -1, 3])
        expect(threaded('- p\n  - c1\n\n  - c2')).toEqual([0]) // thread p → c1 only
    })

    it('an indented soft line (Shift-Enter multiline) keeps the thread — indent decides, not blankness', () => {
        // Line 2 is whitespace-only but indented to c1's content column → part of c1's block; p's
        // branch still spans to c2.
        expect(branchEnds('- p\n  - c1\n    \n  - c2'.split('\n'))).toEqual([3, 1, -1, 3])
        expect(threaded('- p\n  - c1\n    \n  - c2')).toEqual([0])
    })

    it('a blank inside a fenced block never cuts the thread (fence-opaque)', () => {
        const doc = '- p\n  - c1\n  - ```\n\n    ```\n  - c2'
        expect(threaded(doc)).toEqual([0]) // p threads across the fence (incl. its bare internal blank) to c2
        expect(branchEnds(doc.split('\n'))[0]).toBe(5)
    })

    it('a blank line between top-level bullets still keeps them separate (indentation decides)', () => {
        expect(threaded('- A\n\n- B')).toEqual([]) // neither parents the other
    })

    it('a bullet whose only deeper lines are its own continuations gets NO thread', () => {
        // The continuation is part of p's block, not a child bullet → p is not a parent → no thread.
        expect(branchEnds('- p\n  continuation'.split('\n'))).toEqual([0, -1])
        expect(threaded('- p\n  continuation')).toEqual([])
    })

    it("a thread spans down to the last child's own continuation row", () => {
        // p has a child bullet (c), whose continuation is the last line of p's branch → p's thread
        // reaches line 2; c itself has no sub-bullet, so it collapses to its own index (no thread).
        expect(branchEnds('- p\n  - c\n    cont'.split('\n'))).toEqual([2, 1, -1])
        expect(threaded('- p\n  - c\n    cont')).toEqual([0])
    })
})

describe('fenced content is opaque to guide threads', () => {
    it('a bullet-looking line inside a fence opens no thread and does not end the owner’s', () => {
        const lines = ['- owner', '  - ```', '    - a bullet in code', '      - [ ] task in code', '    # heading in code', '    ```', '- after']
        const ends = branchEnds(lines)
        expect(ends[0]).toBe(5) // owner's thread reaches the closer
        expect(ends[1]).toBe(1) // the form-1 opener parents nothing
        expect(ends[2]).toBe(-1) // code, not a bullet
        expect(ends[3]).toBe(-1)
    })
})

describe('branchEnds — frontmatter is opaque', () => {
    it('a YAML list in the frontmatter opens no branch and gets no thread', () => {
        const doc = ['---', 'title: A', 'aliases:', '  - B', '  - C', '---', '- parent', '  - child']
        const ends = branchEnds(doc)
        expect(ends.slice(0, 6)).toEqual([-1, -1, -1, -1, -1, -1])
        expect(ends[6]).toBe(7) // the body's outline is unaffected
    })
})
