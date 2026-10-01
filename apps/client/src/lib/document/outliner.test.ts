import { describe, expect, it } from 'vitest'

import { fencedBlocks } from './fenced-code'

import {
    applyLineCuts,
    blockBodyEnd,
    branchRange,
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
    groupBounds,
    healOrphanIndent,
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

    it('cuts nothing for an indented bullet, or where its code at the margin would pair another fence', () => {
        expect(cutsAfterBulletIntoProse(L('prose\n  - a\n    - b'), 0, 1, 4)).toEqual([])
        expect(cutsAfterBulletIntoProse(L('```js\ntext\nprose\n- a\n  ```\n  x\n  ```'), 2, 3, 2)).toEqual([])
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
