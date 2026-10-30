import { describe, expect, it } from 'vitest'

import { fencedBlocks } from './fenced-code'

import {
    applyLeaveListCuts,
    applyLineCuts,
    blockBodyEnd,
    branchRange,
    branchesWithin,
    branchRootsWithin,
    bulletContent,
    canIndent,
    canLeaveList,
    canOutdent,
    leaveListCuts,
    outdentTarget,
    computeMove,
    contentColumn,
    continuationColumn,
    continuationFloor,
    cutsAfterBulletIntoProse,
    cycleTask,
    firstChildSpot,
    indentBlock,
    keepsOutline,
    groupBounds,
    healAfterRangeDelete,
    healOrphanIndent,
    healSpan,
    isBulletLine,
    isHeadingLine,
    isMergeableSource,
    joinsBulletIntoProse,
    MARKER_WIDTH,
    mergeTargetAbove,
    opaqueLineFlags,
    mergeWouldStrand,
    markerLength,
    newBulletMarker,
    nextSiblingRange,
    ownerBulletIndex,
    parentIndex,
    prevSiblingRange,
    shiftLines,
    taskDone,
    treeRootIndex,
    withoutEdgeBlankLines,
} from './outliner'

const L = (s: string) => s.split('\n')

/** Apply a {@link computeMove} to a source doc and return the resulting text (or null if consumed). */
function move(src: string, bulletIndex: number, dir: 'up' | 'down'): string | null {
    const lines = L(src)
    const caretCol = lines[bulletIndex].length // caret at the end of the bullet line
    const edit = computeMove(lines, bulletIndex, bulletIndex, caretCol, dir)
    if (!edit) return null
    const out = [...lines.slice(0, edit.fromLine), ...edit.text.split('\n'), ...lines.slice(edit.toLine + 1)]
    return out.join('\n')
}

describe('content column and the Indent Unit (ADR 0020, ADR 0067)', () => {
    it('marker width is fixed at 2', () => {
        expect(MARKER_WIDTH).toBe(2)
    })
    it('content column is leading indent + marker width, regardless of task marker length', () => {
        expect(contentColumn('- hello')).toBe(2)
        expect(contentColumn('    - hello')).toBe(6) // 4 indent + 2 marker
        expect(contentColumn('  - [ ] task')).toBe(4) // 2 indent + 2 marker (NOT the 6-char task marker)
    })
    it('content column of a non-bullet line is its own leading indent', () => {
        expect(contentColumn('    plain continuation')).toBe(4)
        expect(contentColumn('text')).toBe(0)
    })
    it('canOutdent: any indented bullet outdents; outdentTarget is the parent’s indent, else 0', () => {
        expect(canOutdent(['  - a'], 0)).toBe(true)
        expect(canOutdent(['    - a'], 0)).toBe(true) // foreign four-space text outdents in one press
        expect(canOutdent(['- a'], 0)).toBe(false)
        expect(outdentTarget(L('- a\n    - b'), 1)).toBe(0)
        expect(outdentTarget(L('- a\n    - b\n          - c'), 2)).toBe(4) // onto the parent's own (foreign) indent
        expect(outdentTarget(L('- a\n\n    - b'), 2)).toBe(0) // an indented group start has no parent
    })
    it('continuationFloor returns the owning bullet content column, or 0 for prose', () => {
        expect(continuationFloor(['- bullet', '  cont'], 1)).toBe(2) // under a top-level bullet
        expect(continuationFloor(['  - nested', '    cont'], 1)).toBe(4) // under a nested bullet
        expect(continuationFloor(['- a', '  - b', '    cont'], 2)).toBe(4) // owned by the nearest shallower bullet
        expect(continuationFloor(['prose', '  more'], 1)).toBe(0) // under prose, not a bullet
        expect(continuationFloor(['  cont'], 0)).toBe(0) // nothing above
    })
    it('continuationColumn is the continued bullet’s content column once the line reaches it, and 0 for prose', () => {
        expect(continuationColumn(['- a', '  cont'], 1)).toBe(2)
        expect(continuationColumn(['- a', ' x'], 1)).toBe(0) // one space in: short of the column, prose
        expect(continuationColumn(['- a', '  - b', '   x'], 2)).toBe(0) // past a's column, short of b's
        expect(continuationColumn(['prose', '  more'], 1)).toBe(0)
        // The outline walk looks past a soft line, a `*` item or a closer to the bullet above them.
        expect(continuationColumn(['- a', '  cont', '    deeper'], 2)).toBe(2)
        expect(continuationColumn(['- a', '  * one', '    * two'], 2)).toBe(2)
        expect(continuationColumn(['- a', '  ```', '  code', '  ```', '    after'], 4)).toBe(2)
        // The floor looks past a blank line, which the walk does not.
        expect(continuationColumn(['- a', '  - b', '', '    x'], 3)).toBe(4)
        // After a form-1 block (the fence on the bullet line), as after a form-2 one.
        expect(continuationColumn(['- ```py', '  code', '  ```', '    after'], 3)).toBe(2)
    })
    it('continuationColumn reads a blank line as the line it becomes with text in it', () => {
        // Under a prose line short of the column, text is prose nested under that line, so the blank
        // line is prose too; under a soft line it is the bullet's, as the text below it is.
        expect(continuationColumn(['- a', ' p', '   ', '- b'], 2)).toBe(0)
        expect(continuationColumn(['- a', ' p', '   y', '- b'], 2)).toBe(0)
        expect(continuationColumn(['- a', '  cont', '    ', '    deeper'], 2)).toBe(2)
        expect(continuationColumn(['- a', '   '], 1)).toBe(2)
    })
})

describe('outliner line helpers', () => {
    it('recognises bullets and tasks', () => {
        expect(isBulletLine('- a')).toBe(true)
        expect(isBulletLine('  - a')).toBe(true)
        expect(isBulletLine('-nope')).toBe(false)
        expect(isBulletLine('prose')).toBe(false)
        expect(taskDone('- [ ] a')).toBe(false)
        expect(taskDone('- [x] a')).toBe(true)
        expect(taskDone('- a')).toBeUndefined()
    })

    it('measures the marker and extracts content', () => {
        expect(markerLength('- a')).toBe(2)
        expect(markerLength('- [ ] a')).toBe(6)
        expect(bulletContent('- hello')).toBe('hello')
        expect(bulletContent('  - [ ] task')).toBe('task')
        expect(bulletContent('- ')).toBe('')
    })

    it('picks the new-sibling marker', () => {
        expect(newBulletMarker('- a')).toBe('- ')
        expect(newBulletMarker('- [x] a')).toBe('- [ ] ')
    })
})

describe('branchRange', () => {
    it('covers the root plus everything more indented', () => {
        const lines = L('- a\n  - a1\n    cont\n  - a2\n- b')
        expect(branchRange(lines, 0)).toEqual({ start: 0, end: 3 })
    })

    it('a continuation line stays in the branch; a sibling ends it', () => {
        const lines = L('- a\n  cont\n- b')
        expect(branchRange(lines, 0)).toEqual({ start: 0, end: 1 })
        expect(branchRange(lines, 2)).toEqual({ start: 2, end: 2 })
    })
})

describe('branchRootsWithin (a block selection’s branches)', () => {
    it('picks every bullet not inside an earlier root’s branch', () => {
        const lines = ['- a', '- b', '  - c', '    - d', '  - e', '- f', '  - g']
        expect(branchRootsWithin(lines, 1, 6)).toEqual([1, 5])
    })

    it('starts wherever the span starts: a nested first line is a root of its own', () => {
        const lines = ['- a', '  - b', '  - c', '- d']
        expect(branchRootsWithin(lines, 2, 3)).toEqual([2, 3])
    })

    it('is nobody’s root on a blank, prose or heading line, and keeps a branch whole past the span', () => {
        const lines = ['- a', '', '# h', 'prose', '- b', '  - c']
        expect(branchRootsWithin(lines, 0, 4)).toEqual([0, 4])
        expect(branchRootsWithin(lines, 1, 3)).toEqual([])
    })

    it('gives each branch to its last descendant, past the span too', () => {
        const lines = ['- a', '  - b', '- c', '  - d', '    - e', '- f']
        expect(branchesWithin(lines, 0, 2)).toEqual([
            { start: 0, end: 1 },
            { start: 2, end: 4 },
        ])
    })

    it('takes no `- ` line inside code for a root, in a code sample or where the span starts in code', () => {
        const lines = ['- a', '```', '- x', '```', '- b']
        expect(branchesWithin(lines, 0, 4)).toEqual([
            { start: 0, end: 0 },
            { start: 4, end: 4 },
        ])
        expect(branchRootsWithin(lines, 2, 4)).toEqual([4])
    })
})

describe('indent / outdent guards', () => {
    it('cannot indent the first bullet at its level', () => {
        const lines = L('- a\n- b')
        expect(canIndent(lines, 0)).toBe(false) // nothing above
        expect(canIndent(lines, 1)).toBe(true) // sibling above
    })

    it('cannot indent the first child past its parent', () => {
        const lines = L('- a\n  - a1')
        expect(canIndent(lines, 1)).toBe(false) // parent is directly above
    })

    it('outdent needs indentation', () => {
        const lines = L('- a\n  - a1')
        expect(canOutdent(lines, 0)).toBe(false)
        expect(canOutdent(lines, 1)).toBe(true)
    })
})

/** `lines` after leaving the list from `root`, the cuts applied. */
function leaveList(src: string, root: number): string {
    const lines = L(src)
    for (const { line, count } of leaveListCuts(lines, root)) lines[line] = lines[line].slice(count)
    return lines.join('\n')
}

describe('leaving the list from a top-level bullet (Shift+Tab past the root, the bullet toggle)', () => {
    it('cuts the marker and any checkbox, takes its own lines to column 0 and brings its children up one level', () => {
        expect(leaveList('- a\n  soft\n  - b\n    - c', 0)).toBe('a\nsoft\n- b\n  - c')
        expect(leaveList('- [ ] a\n  - b', 0)).toBe('a\n- b')
        // Each child comes up by its own indent, so a four-space child lands at 0 too.
        expect(leaveList('- a\n    - b\n        - c', 0)).toBe('a\n- b\n    - c')
        // On a ragged grid a later, shallower child keeps its own lines: the soft line stays c's.
        expect(leaveList('- a\n      - b\n    - c\n      soft', 0)).toBe('a\n- b\n- c\n  soft')
        // A paragraph after the children is the root's own, and goes to the margin with it.
        expect(leaveList('- a\n  - b\n  after', 0)).toBe('a\n- b\nafter')
    })

    it('adds and removes no line, so a line keeps its index', () => {
        const lines = L('- a\n  ```\n  x\n  ```\n  - b\n- c')
        expect(leaveListCuts(lines, 0).every(({ line }) => line >= 0 && line <= 4)).toBe(true)
    })

    it('may leave where every fence keeps its pairing: a form-1 bullet\'s fences move to column 0 together', () => {
        expect(canLeaveList(L('- ```py\n  code\n  ```'), 0)).toBe(true)
        expect(canLeaveList(L('- a\n  ```\n  x\n  ```\n- b'), 0)).toBe(true)
    })

    it('may not where its text at the margin would pair with another fence, a task\'s included', () => {
        expect(canLeaveList(L('- ```py\ntext\n```\ncode\n```'), 0)).toBe(false)
        expect(canLeaveList(L('- [ ] ```py\ntext\n```\ncode\n```'), 0)).toBe(false)
        expect(canLeaveList(L('```js\ntext\n- ```'), 2)).toBe(false)
    })

    it('may not where its own code block at the margin would close an open prose fence above', () => {
        expect(canLeaveList(L('```js\ntext\n- a\n  ```\n  code\n  ```'), 2)).toBe(false)
    })

    it('may not where a `---` at the margin would close or open a frontmatter block', () => {
        expect(canLeaveList(L('---\ntitle: x\n- ---\nbody'), 2)).toBe(false)
        expect(canLeaveList(L('- ---\n\ntext\n\n---\nmore'), 0)).toBe(false)
        // Under a frontmatter block that is already closed it is a rule in the body.
        expect(canLeaveList(L('---\ntitle: x\n---\n- ---'), 3)).toBe(true)
    })
})

describe('cycleTask', () => {
    it('cycles plain → unchecked → checked → plain', () => {
        expect(cycleTask('- a')).toBe('- [ ] a')
        expect(cycleTask('- [ ] a')).toBe('- [x] a')
        expect(cycleTask('- [x] a')).toBe('- a')
    })

    it('preserves indentation and leaves non-bullets alone', () => {
        expect(cycleTask('  - a')).toBe('  - [ ] a')
        expect(cycleTask('prose')).toBe('prose')
    })
})

describe('sibling ranges (move up/down)', () => {
    const lines = L('- a\n  - a1\n- b\n  - b1\n- c')
    it('finds the previous sibling branch', () => {
        expect(prevSiblingRange(lines, 2)).toEqual({ start: 0, end: 1 }) // b's prev = a (+a1)
        expect(prevSiblingRange(lines, 0)).toBeNull()
    })
    it('finds the next sibling branch', () => {
        expect(nextSiblingRange(lines, 2)).toEqual({ start: 4, end: 4 }) // b's next = c
        expect(nextSiblingRange(lines, 4)).toBeNull()
    })
    it('does not treat a nested bullet as a sibling', () => {
        expect(prevSiblingRange(lines, 1)).toBeNull() // a1 is the first child of a
    })
})

describe('Outliner Block Group boundaries (ADR 0021)', () => {
    it('a heading is a boundary — never a sibling, parent, or branch member', () => {
        const lines = L('## H\n- a\n## G')
        expect(prevSiblingRange(lines, 1)).toBeNull() // the heading above is not a sibling
        expect(nextSiblingRange(lines, 1)).toBeNull() // the heading below is not a sibling
        expect(parentIndex(lines, 1)).toBeNull() // a heading is not a parent
        expect(canIndent(lines, 1)).toBe(false) // first bullet under a heading can't indent
        expect(branchRange(lines, 1)).toEqual({ start: 1, end: 1 }) // branch stops before the next heading
    })

    it('prose at the same indent bounds the group', () => {
        const lines = L('- a\nprose\n- b')
        expect(nextSiblingRange(lines, 0)).toBeNull() // prose below ends a's group
        expect(prevSiblingRange(lines, 2)).toBeNull() // prose above starts b's group
        expect(parentIndex(lines, 2)).toBeNull()
    })

    it('a bare blank line bounds the group; a fence-internal blank does not', () => {
        expect(nextSiblingRange(L('- a\n\n- b'), 0)).toBeNull() // blank between = two groups
        const fenced = L('- a\n  ```\n  x\n\n  y\n  ```\n- b')
        expect(branchRange(fenced, 0)).toEqual({ start: 0, end: 5 }) // fence (incl. its blank) stays in a's branch
        expect(nextSiblingRange(fenced, 0)).toEqual({ start: 6, end: 6 }) // b is still a's sibling
    })

    it('groupBounds is the maximal contiguous tree run', () => {
        const lines = L('## H\n- a\n  - a1\nprose')
        expect(groupBounds(lines, 1)).toEqual({ start: 1, end: 2 })
        expect(groupBounds(lines, 2)).toEqual({ start: 1, end: 2 })
    })

    it('isHeadingLine matches indented headings too', () => {
        expect(isHeadingLine('# h')).toBe(true)
        expect(isHeadingLine('   ### h')).toBe(true)
        expect(isHeadingLine('#nospace')).toBe(false)
        expect(isHeadingLine('- a')).toBe(false)
    })

    it('indent decides blankness (ADR 0021): soft lines stay in the block, bare blanks bound', () => {
        // A trailing indented soft line rides with its branch.
        expect(branchRange(L('- a\n  soft\n  \n- b'), 0)).toEqual({ start: 0, end: 2 })
        // A bare empty line bounds the branch and the sibling list.
        expect(branchRange(L('- a\n\n  - x'), 0)).toEqual({ start: 0, end: 0 })
        expect(nextSiblingRange(L('- a\n  \n- b'), 0)).toEqual({ start: 2, end: 2 }) // soft line consumed by a's branch
        expect(prevSiblingRange(L('- a\n  \n- b'), 2)).toEqual({ start: 0, end: 1 }) // scans up through the soft line
        expect(prevSiblingRange(L('- a\n\n- b'), 2)).toBeNull() // bare blank bounds
        expect(parentIndex(L('- p\n  \n  - c'), 2)).toBe(0) // soft line is transparent to parent lookup
        expect(parentIndex(L('- p\n\n  - c'), 2)).toBeNull() // bare blank bounds (the allowable orphan indent)
    })

    it('parentIndex finds the nearest shallower bullet', () => {
        const lines = L('- p\n  - a\n  - e')
        expect(parentIndex(lines, 2)).toBe(0)
        expect(parentIndex(lines, 1)).toBe(0)
        expect(parentIndex(lines, 0)).toBeNull()
    })

    it('ownerBulletIndex resolves a continuation line to its bullet', () => {
        const lines = L('- a\n  cont\n- b')
        expect(ownerBulletIndex(lines, 1)).toBe(0)
        expect(ownerBulletIndex(lines, 0)).toBe(0)
    })

    it('ownerBulletIndex gives a line after a form-1 block to that block’s bullet, as after a form-2 block', () => {
        // The form-1 opener is the bullet itself, not fenced content: the keys measure against it.
        expect(ownerBulletIndex(L('- ```py\n  code\n  ```\n  after'), 3)).toBe(0)
        expect(ownerBulletIndex(L('- ```py\n  code\n  ```\n    after'), 3)).toBe(0)
        expect(ownerBulletIndex(L('- p\n  - ```py\n    code\n    ```\n      after'), 4)).toBe(1)
        expect(ownerBulletIndex(L('- a\n  ```py\n  code\n  ```\n    after'), 4)).toBe(0)
        // Its code lines are still code, owned by nobody's continuation.
        expect(ownerBulletIndex(L('- ```py\n  code\n  ```'), 1)).toBe(0)
    })
})

describe('computeMove — Logseq jump-over move (ADR 0021)', () => {
    it('jumps over a sibling that has children, never diving in (down)', () => {
        expect(move('- p\n  - e\n  - b\n    - b1', 1, 'down')).toBe('- p\n  - b\n    - b1\n  - e')
    })
    it('jumps over a sibling that has children, never diving in (up)', () => {
        expect(move('- p\n  - a\n    - a1\n  - e', 3, 'up')).toBe('- p\n  - e\n  - a\n    - a1')
    })
    it('swaps with a leaf sibling', () => {
        expect(move('- a\n- b', 0, 'down')).toBe('- b\n- a')
        expect(move('- a\n- b', 1, 'up')).toBe('- b\n- a')
    })
    it('carries the whole branch when jumping', () => {
        expect(move('- a\n  - a1\n- b', 0, 'down')).toBe('- b\n- a\n  - a1')
    })
    it('promotes at a parent edge (down → the parent’s next sibling)', () => {
        expect(move('- p\n  - a\n  - e\n- next', 2, 'down')).toBe('- p\n  - a\n- e\n- next')
    })
    it('promotes at a parent edge (up → the parent’s previous sibling)', () => {
        expect(move('- parent\n  - e', 1, 'up')).toBe('- e\n- parent')
    })
    it('a first child promoted up carries its own subtree, keeps siblings under the parent', () => {
        expect(move('- parent\n  - e\n  - f', 1, 'up')).toBe('- e\n- parent\n  - f')
        expect(move('- p\n  - e\n    - e1', 1, 'up')).toBe('- e\n  - e1\n- p')
    })
    it('is consumed (null) at a group boundary', () => {
        expect(move('- a\n- b', 0, 'up')).toBeNull() // first top-level, nowhere up
        expect(move('- a\n- b', 1, 'down')).toBeNull() // last top-level, nowhere down
        expect(move('## H\n- a\n## G', 1, 'up')).toBeNull() // walled by headings
        expect(move('## H\n- a\n## G', 1, 'down')).toBeNull()
    })
    it('leaps a fenced-code sibling whole, never splitting it', () => {
        expect(move('- a\n- ```\n  code\n  ```', 0, 'down')).toBe('- ```\n  code\n  ```\n- a')
    })
    it('moves a branch containing a fence with a blank line without tearing it', () => {
        expect(move('- a\n  ```\n  x\n\n  y\n  ```\n- b', 0, 'down')).toBe('- b\n- a\n  ```\n  x\n\n  y\n  ```')
    })
    it('on over-nested text siblings share a parent whatever their indents, and a jump lands on the sibling’s indent (ADR 0067)', () => {
        const lines = L('- a\n      - b\n    - c')
        expect(prevSiblingRange(lines, 2)).toEqual({ start: 1, end: 1 }) // b (6) is c's (4) sibling: both children of a
        expect(nextSiblingRange(lines, 1)).toEqual({ start: 2, end: 2 })
        expect(canIndent(lines, 2)).toBe(true)
        expect(move('- a\n      - b\n    - c', 2, 'up')).toBe('- a\n      - c\n      - b') // c takes b's indent: still siblings
        expect(move('- a\n      - b\n    - c', 1, 'down')).toBe('- a\n    - c\n    - b')
        expect(move('- a\n    - b\n        - c', 2, 'up')).toBe('- a\n    - c\n    - b') // promote onto the parent's indent
    })

    it('down then up returns the block to its start (reversible)', () => {
        const start = '- parent\n  - a\n  - b\n- next\n  - n1'
        const d1 = move(start, 2, 'down')! // last child → promote out
        expect(d1).toBe('- parent\n  - a\n- b\n- next\n  - n1')
        const d2 = move(d1, 2, 'down')! // jump over next's whole subtree
        expect(d2).toBe('- parent\n  - a\n- next\n  - n1\n- b')
        expect(move(d2, 4, 'up')).toBe(d1) // and back
    })
    it('lands the caret at the end of the moved bullet (jump down)', () => {
        const lines = L('- a\n- b\n  - b1')
        const edit = computeMove(lines, 0, 0, 3, 'down')! // caret at end of "- a", jumps over b's subtree
        expect(edit.text).toBe('- b\n  - b1\n- a')
        expect(edit.caretOffset).toBe(edit.text.length) // caret at the end of the moved "- a"
    })
})

describe('merge guards (ADR 0021)', () => {
    it('mergeTargetAbove allows a bullet or continuation above, refuses boundaries', () => {
        expect(mergeTargetAbove(L('- a\n- b'), 1)).toBe(true) // bullet above
        expect(mergeTargetAbove(L('- a\n  cont'), 1)).toBe(true) // continuation above (dive into deep neighbour)
        expect(mergeTargetAbove(L('- a\n- b'), 0)).toBe(false) // nothing above
        expect(mergeTargetAbove(L('## H\n- b'), 1)).toBe(false) // heading boundary
        expect(mergeTargetAbove(L('prose\n- b'), 1)).toBe(false) // standalone prose boundary
        expect(mergeTargetAbove(L('- a\n\n- b'), 2)).toBe(false) // bare blank boundary
        expect(mergeTargetAbove(L('- ```\n  code\n  ```\n- b'), 3)).toBe(false) // closing fence above — don't merge into code
    })
    it('isMergeableSource accepts bullets/continuations, rejects boundaries', () => {
        expect(isMergeableSource(L('- a\n- b'), 1)).toBe(true)
        expect(isMergeableSource(L('- a\n## H'), 1)).toBe(false)
        expect(isMergeableSource(L('- a\n'), 1)).toBe(false) // blank
        expect(isMergeableSource(L('- a\n  ```\n  x\n  ```'), 1)).toBe(false) // fence opener
    })
    it('healOrphanIndent clamps level-jumps to one level below the parent, leaves valid lines', () => {
        expect(healOrphanIndent(L('- a\n    - b'), 0, 1)).toEqual(L('- a\n  - b')) // depth-2 jump → depth-1
        expect(healOrphanIndent(L('- a\n      - b'), 0, 1)).toEqual(L('- a\n  - b')) // depth-3 jump → depth-1
        expect(healOrphanIndent(L('- a\n  - b\n    - c'), 0, 2)).toEqual(L('- a\n  - b\n    - c')) // well-formed → untouched
        expect(healOrphanIndent(L('- a\n    - b\n      - c'), 0, 2)).toEqual(L('- a\n  - b\n    - c')) // jump + its child ride down together
    })
    it('mergeWouldStrand flags a merge that jumps a grandchild, allows a clean re-parent', () => {
        // removing "  - b" (idx1) into target indent 0 leaves "    - c" (indent 4) 2 levels below → strand
        expect(mergeWouldStrand(L('- a\n  - b\n    - c'), 1, 0)).toBe(true)
        // removing "- b" (idx1) into target 0 leaves "  - c" (indent 2) exactly one level below → fine
        expect(mergeWouldStrand(L('- a\n- b\n  - c'), 1, 0)).toBe(false)
        expect(mergeWouldStrand(L('- a\n- b'), 1, 0)).toBe(false) // no child
        expect(mergeWouldStrand(L('- a\n  - b'), 0, 0)).toBe(false) // next line is the child of the KEPT block, not removed's
    })
})

describe('blockBodyEnd', () => {
    it('ends before the first child bullet', () => {
        expect(blockBodyEnd(L('- a\n  soft\n  more\n  - c'), 0)).toBe(2)
        expect(blockBodyEnd(L('- a\n- b'), 0)).toBe(0)
    })

    it('treats a bullet-looking line inside a fence as code and a blank line as body', () => {
        expect(blockBodyEnd(L('- a\n  ```\n  - x\n  ```\n  - c'), 0)).toBe(3)
        expect(blockBodyEnd(L('- a\n  \n  soft'), 0)).toBe(2)
    })

    it('reads a bullet after an unterminated opener as a child', () => {
        expect(blockBodyEnd(L('- a\n  ```\n  - c'), 0)).toBe(1)
    })
})

describe('shiftLines', () => {
    it('shifts by delta, never below column 0, blank lines keeping only indent', () => {
        expect(shiftLines(['  a', '    b', '  '], 2)).toEqual(['    a', '      b', '    '])
        expect(shiftLines(['  a', 'b', ''], -4)).toEqual(['a', 'b', ''])
    })
})

describe('treeRootIndex', () => {
    it('climbs to the topmost ancestor within the group', () => {
        const lines = L('- a\n  - b\n    - c\n  - d\n- e\n\n  - f')
        expect(treeRootIndex(lines, 2)).toBe(0)
        expect(treeRootIndex(lines, 3)).toBe(0)
        expect(treeRootIndex(lines, 4)).toBe(4)
        expect(treeRootIndex(lines, 6)).toBe(6) // a group whose first bullet is indented is its own root
    })
})

describe('the heals read whitespace-only lines as the outline walk does (indent decides, ADR 0021)', () => {
    it('healSpan ends at a bare blank line or a heading, not at an indented soft line or a fence’s own blank line', () => {
        const lines = L('- a\n  - b\n    \n    soft\n\n- c\n## H\n- d')
        expect(healSpan(lines, 1)).toEqual({ start: 0, end: 3 })
        expect(healSpan(lines, 5)).toEqual({ start: 5, end: 5 })
        expect(healSpan(L('- a\n  ```\n\n  ```\n  - b'), 0)).toEqual({ start: 0, end: 4 })
    })
    it('healOrphanIndent ends every branch at a bare blank line, as at a heading', () => {
        expect(healOrphanIndent(L('- a\n\n    - b'), 0, 2)).toEqual(L('- a\n\n- b'))
    })
    it('healOrphanIndent moves an indented soft line with its bullet, and reads it as closing the branches it is not deeper than', () => {
        expect(healOrphanIndent(L('- a\n      - b\n        \n        soft\n      - c'), 0, 4)).toEqual(L('- a\n  - b\n    \n    soft\n  - c'))
        // Short of b's text, the soft line is a's: the bullet after it is a's child too, on the grid.
        expect(healOrphanIndent(L('- a\n  - b\n  \n    - c'), 0, 3)).toEqual(L('- a\n  - b\n  \n  - c'))
    })
    it('healAfterRangeDelete heals only the group above a bare blank line or a heading at the deletion point', () => {
        expect(healAfterRangeDelete(L('- a\n\n\n  p\n    - b'), 1)).toEqual({ lines: L('- a\n\n  p\n    - b'), caretLine: 1 })
        expect(healAfterRangeDelete(L('\n\n  p\n    - b'), 0)).toEqual({ lines: L('\n  p\n    - b'), caretLine: 0 })
        expect(healAfterRangeDelete(L('- a\n    - x\n\n## H\n    - b'), 2)).toEqual({ lines: L('- a\n  - x\n## H\n    - b'), caretLine: 2 })
    })
    it('healAfterRangeDelete heals after a heading the deletion started in, its blocks a group of their own', () => {
        expect(healAfterRangeDelete(L('# Garden\n  - check the soil'), 0)).toEqual({ lines: L('# Garden\n- check the soil'), caretLine: 0 })
    })
    it('healAfterRangeDelete keeps the line after whole lines deleted, a blank one included', () => {
        expect(healAfterRangeDelete(L('- a\n\n  note\n    - b'), 1, true)).toEqual({ lines: L('- a\n\n  note\n    - b'), caretLine: 1 })
        expect(healAfterRangeDelete(L('- a\n      - b'), 1, true)).toEqual({ lines: L('- a\n  - b'), caretLine: 1 })
    })
    it('healOrphanIndent moves a form-2 block with the bullet whose content column it reaches, not the last bullet healed', () => {
        expect(healOrphanIndent(L('- a\n      - b\n  ```\n  x\n  ```'), 0, 4)).toEqual(L('- a\n  - b\n  ```\n  x\n  ```'))
        expect(healOrphanIndent(L('- a\n      - b\n  \n  ```\n    x\n  ```'), 0, 5)).toEqual(L('- a\n  - b\n  \n  ```\n    x\n  ```'))
    })
    it('healOrphanIndent moves a blank line as its nearest open bullet moves, wherever its column', () => {
        // Short of b's text, the blank line still closes c and is b's: x after it stays b's soft line.
        expect(healOrphanIndent(L('- a\n      - b\n          - c\n       \n          x'), 0, 4)).toEqual(L('- a\n  - b\n    - c\n   \n      x'))
    })
})

describe('healOrphanIndent moves fenced blocks with their owner', () => {
    it('shifts a form-1 block by its bullet’s correction and a form-2 block by its owner’s', () => {
        const form1 = L('    - ```\n      x\n      ```\n    - b')
        expect(healOrphanIndent(form1, 0, 3)).toEqual(L('- ```\n  x\n  ```\n- b'))
        const form2 = L('    - a\n      ```\n      x\n      ```\n    - b')
        expect(healOrphanIndent(form2, 0, 4)).toEqual(L('- a\n  ```\n  x\n  ```\n- b'))
    })
})

describe('opaqueLineFlags', () => {
    it('flags fenced blocks and the frontmatter, nothing else', () => {
        const lines = ['---', 'title: A', '---', '- a', '```', 'x', '```', '- b']
        expect(opaqueLineFlags(lines, fencedBlocks(lines))).toEqual([true, true, true, false, true, true, true, false])
    })
})

describe('a deletion from prose that takes a bullet into it', () => {
    const doc = L('prose\n- a\n  cont\n  - b\n    - c')

    it('is one from a prose line over a bullet’s marker, never one starting in another bullet’s text', () => {
        expect(joinsBulletIntoProse(doc, 0, 1, 2)).toBe(true) // to after `- `
        expect(joinsBulletIntoProse(doc, 0, 1, 0)).toBe(false) // ends before the marker
        expect(joinsBulletIntoProse(L('- x\n- a\n  - b'), 0, 1, 2)).toBe(false) // a bullet merges into a bullet
        expect(joinsBulletIntoProse(L('- x\n  soft\n- a'), 1, 2, 2)).toBe(false) // a continuation is the bullet's
        expect(joinsBulletIntoProse(L('```\nx\n- a\n```'), 1, 2, 2)).toBe(false) // code
    })

    it('makes the bullet leave the list: its own lines to the margin, its children up a level', () => {
        const cuts = cutsAfterBulletIntoProse(doc, 0, 1, 2)
        expect(cuts).toEqual([
            { line: 2, count: 2 },
            { line: 3, count: 2 },
            { line: 4, count: 2 },
        ])
        // After the deletion the two lines are one: each cut lands a line earlier.
        expect(applyLineCuts(L('proa\n  cont\n  - b\n    - c'), cuts, -1)).toEqual(L('proa\ncont\n- b\n  - c'))
    })

    it('cuts nothing for an indented bullet', () => {
        expect(cutsAfterBulletIntoProse(L('prose\n  - a\n    - b'), 0, 1, 4)).toEqual([])
    })

    it('applies the cuts only where the edited text keeps every fence paired', () => {
        // The bullet's own code, at the margin, would close the open fence above it.
        const before = L('```js\ntext\nprose\n- a\n  ```\n  x\n  ```')
        const after = L('```js\ntext\nprosea\n  ```\n  x\n  ```')
        expect(applyLeaveListCuts(after, cutsAfterBulletIntoProse(before, 2, 3, 2), -1)).toEqual(after)
        // A form-1 bullet's fence went into the prose line with its marker: its old closer at the margin
        // would pair with the next block's opener.
        const form1 = L('prose\n- ```py\n  code\n  ```\n\n```\nz\n```')
        const joined = L('pro`py\n  code\n  ```\n\n```\nz\n```')
        expect(applyLeaveListCuts(joined, cutsAfterBulletIntoProse(form1, 0, 1, 4), -1)).toEqual(joined)
    })
})

describe('prevSiblingRange across a code block', () => {
    it('reads a code block at the margin between two bullets as prose that ends the group', () => {
        expect(prevSiblingRange(L('- a\n```\nx\n```\n- b'), 4)).toBeNull()
    })

    it('reads a parent’s own block between two of its children as closing the one above', () => {
        expect(prevSiblingRange(L('- p\n  - a\n  ```\n  x\n  ```\n  - b'), 5)).toBeNull()
    })

    it('still finds a sibling whose own block sits deeper, and a form-1 sibling', () => {
        expect(prevSiblingRange(L('- a\n  ```\n  x\n  ```\n- b'), 4)).toEqual({ start: 0, end: 3 })
        expect(prevSiblingRange(L('- ```py\n  x\n  ```\n- b'), 3)).toEqual({ start: 0, end: 2 })
    })
})

// A block put in beneath a line (an inline panel's save, `insertBlock` at the caret) may add to the
// outline and never rearrange it (Editor Content Rules → Inline panels, ADR 0147 amended 2026-10-20).
describe('a block put into the outline', () => {
    const keeps = (doc: string, at: number, removed: number, block: string) => keepsOutline(L(doc), at, removed, L(block))

    it('keeps the outline with prose and a list beneath a bullet, a wrapped paragraph and an indented code line', () => {
        expect(keeps('- Kitchen\n- Shed', 1, 0, '  Intro\n  - water the beans\n  - pick the peas')).toBe(true)
        expect(keeps('- Kitchen\n- Shed', 1, 0, '  Steps\n      indented code')).toBe(true)
        expect(keeps('- Kitchen\n- Shed', 1, 0, '  Para one\n    wrapped line')).toBe(true)
    })

    it('keeps the outline taking the place of an empty bullet that has children', () => {
        expect(keeps('- Garden\n  - \n    - beans\n- Shed', 1, 1, '  - Agent Chat\n    - What?')).toBe(true)
        expect(keeps('- Garden\n  - \n    - beans\n- Shed', 1, 1, '  - ```sh\n    water\n    ```')).toBe(true)
    })

    it('keeps a heading at the top level, where a heading belongs', () => {
        expect(keeps('- Garden', 1, 0, '# Notes\nA line of prose.')).toBe(true)
    })

    it('refuses an indented heading anywhere in the block, at its root\'s indentation too, since the keys end every branch at one', () => {
        expect(keeps('- Garden\n  - Kitchen\n- Pantry', 2, 0, '    - Agent Chat\n    ## Sowing')).toBe(false)
        expect(keeps('- Garden\n  - Kitchen\n- Pantry', 2, 0, '    - Agent Chat\n      ## Sowing')).toBe(false)
    })

    it('refuses a block that would end the branch it sits in, leaving later bullets with another parent', () => {
        expect(keeps('- Garden\n  - Kitchen\n    - beans\n    - peas\n  - Shed', 3, 0, '      - Agent Chat\n\n          2. Sow')).toBe(false)
    })

    it('refuses a block that would take the lines after it as its own', () => {
        expect(keeps('- Kitchen\n    - beans\n- Shed', 1, 0, '  - Agent Chat')).toBe(false)
    })
})

describe('indentBlock', () => {
    it('gives a blank line the indentation of the next line with text, and leaves one in a fence bare', () => {
        expect(indentBlock(L('- a\n\n  b\n```\nx\n\ny\n```'), '  ')).toEqual(L('  - a\n    \n    b\n  ```\n  x\n\n  y\n  ```'))
    })

    it('reads only fences as opaque: a block that starts and ends with --- is no frontmatter', () => {
        expect(indentBlock(L('---\na\n\nb\n---'), '  ')).toEqual(L('  ---\n  a\n  \n  b\n  ---'))
    })
})

describe('firstChildSpot (ADR 0019)', () => {
    it("is after the bullet's own lines, at its children's indentation, or its content column with none", () => {
        expect(firstChildSpot(L('- Kitchen\n  more\n    - beans\n- Shed'), 0)).toEqual({ after: 1, indent: 4 })
        expect(firstChildSpot(L('- Kitchen\n  more\n- Shed'), 0)).toEqual({ after: 1, indent: 2 })
    })

    it('reads a heading deeper than the bullet as no child of it', () => {
        expect(firstChildSpot(L('- Kitchen\n    ## Sowing\n- Shed'), 0)).toEqual({ after: 0, indent: 2 })
    })
})

describe('markers with more than one space, and prose that only looks like one', () => {
    it('reads a task whose dash is followed by more than one space', () => {
        expect(taskDone('-  [x] water the beans')).toBe(true)
        expect(markerLength('-  [ ] water the beans')).toBe(7)
        expect(bulletContent('-  [ ] water the beans')).toBe('water the beans')
    })

    it('measures a task marker with no space before its content', () => {
        expect(markerLength('- [ ]beans')).toBe(5)
        expect(markerLength('- [x]beans')).toBe(5)
    })

    it('finds no marker or task in prose that has a dash and brackets part way along', () => {
        expect(taskDone('Garden - [x] beans')).toBeUndefined()
        expect(markerLength('Garden - [ ] beans')).toBe(0)
        expect(markerLength('Garden - beans')).toBe(0)
        expect(newBulletMarker('Garden - [ ] beans')).toBe('- ')
    })

    it('cycles a task whose dash is followed by more than one space, or none before its content', () => {
        expect(cycleTask('-  water the beans')).toBe('- [ ] water the beans')
        expect(cycleTask('-  [ ] water the beans')).toBe('-  [x] water the beans')
        expect(cycleTask('-  [x] water the beans')).toBe('-  water the beans')
        expect(cycleTask('- [x]beans')).toBe('- beans')
    })
})

describe('computeMove places the caret where its text went', () => {
    /** The moved text with `|` at the caret, for a caret at `caretCol` of line `caretLine`. */
    function moveWithCaret(src: string, bulletIndex: number, caretLine: number, caretCol: number, dir: 'up' | 'down'): string | null {
        const edit = computeMove(L(src), bulletIndex, caretLine, caretCol, dir)
        if (!edit) return null
        return edit.text.slice(0, edit.caretOffset) + '|' + edit.text.slice(edit.caretOffset)
    }

    it('keeps the caret in its word when a promote takes the indent away', () => {
        expect(moveWithCaret('- Garden\n  - water', 1, 1, 6, 'up')).toBe('- wa|ter\n- Garden')
    })

    it('keeps the caret in its word when a jump adds indent', () => {
        // Shed sits deeper than its sibling Barn, so Barn jumping above it takes Shed's indent.
        expect(moveWithCaret('- Garden\n    - Shed\n  - Barn', 2, 2, 5, 'up')).toBe('    - B|arn\n    - Shed')
    })

    it('keeps the caret on a continuation line of the moved branch', () => {
        expect(moveWithCaret('- Garden\n  - water\n    the beans\n  - Shed', 1, 2, 7, 'down')).toBe('  - Shed\n  - water\n    the| beans')
    })

    it('keeps a caret in the indent at the start of the line when a promote removes more than it', () => {
        expect(moveWithCaret('- Garden\n  - water', 1, 1, 1, 'up')).toBe('|- water\n- Garden')
    })
})

describe('indentBlock and the edges of a block', () => {
    it('reads a line of spaces as blank, taking the indentation of the next line with text', () => {
        expect(indentBlock(['- a', '   ', '- b'], '  ')).toEqual(['  - a', '  ', '  - b'])
        expect(indentBlock(['- a', '', '    - b'], '  ')).toEqual(['  - a', '      ', '      - b'])
    })

    it('leaves a blank line with no text after it bare', () => {
        expect(indentBlock(['- a', '  ', ''], '  ')).toEqual(['  - a', '', ''])
    })

    it('drops blank and whitespace-only lines from both ends, and makes an all-blank block one empty line', () => {
        expect(withoutEdgeBlankLines(['  ', '', '- water the beans', '', '\t'])).toEqual(['- water the beans'])
        expect(withoutEdgeBlankLines([' ', '\t'])).toEqual([''])
        expect(withoutEdgeBlankLines(['- a', '', '- b'])).toEqual(['- a', '', '- b'])
    })

    it('shifting by nothing returns a copy, not the caller’s array', () => {
        const lines = ['- a']
        const out = shiftLines(lines, 0)
        expect(out).toEqual(lines)
        expect(out).not.toBe(lines)
    })

    it('putting in only blank lines always keeps the outline', () => {
        expect(keepsOutline(L('- Garden\n  - Kitchen'), 1, 0, ['', '  '])).toBe(true)
    })
})
