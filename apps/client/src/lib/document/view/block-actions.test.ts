import { describe, expect, it } from 'vitest'

import { blockMarkdown, blockRange, caretSpec, deleteBlockSpec, duplicateBlockSpec, emptySiblingSpec, nestedBlockCount, outdentBlockSpec, structureSpec } from './block-actions'
import { indentBranch, moveBranchDown, moveBranchUp, outdentBranch } from './outliner-keymap'
import { editorFixture } from './testing/editor-state-fixture'

const tree = '- Garden|\n  - Beans\n    - water the beans\n  - Peas\n- Kitchen'

/** Apply a spec to a fixture and read it back in fixture notation. */
function after(text: string, spec: (state: ReturnType<typeof editorFixture>['state']) => object | null): string {
    const editor = editorFixture(text)
    const result = spec(editor.state)
    if (!result) return 'null'
    editor.dispatch(editor.state.update(result))
    return editor.fixture()
}

describe('the Block a bullet heads', () => {
    it('is the bullet with every line nested under it', () => {
        expect(blockRange(editorFixture(tree).state, 2)).toEqual({ start: 1, end: 2 })
    })

    it('is nothing on a line that is not a bullet', () => {
        expect(blockRange(editorFixture('Garden|\n- Beans').state, 1)).toBeNull()
    })

    it('counts the Blocks nested under it, not the soft lines', () => {
        expect(nestedBlockCount(editorFixture('- Garden|\n  soft line\n  - Beans\n    - water the beans').state, 1)).toBe(2)
        expect(nestedBlockCount(editorFixture(tree).state, 5)).toBe(0)
    })

    it('copies as markdown moved out to the margin', () => {
        expect(blockMarkdown(editorFixture(tree).state, 2)).toBe('- Beans\n  - water the beans')
    })
})

describe('the block rows', () => {
    it('Delete block takes the Block and its line break, and the caret goes to the next line', () => {
        expect(after(tree, (s) => deleteBlockSpec(s, 2))).toBe('- Garden\n  - |Peas\n- Kitchen')
    })

    it('Delete block on the last Block takes the line break before it', () => {
        expect(after(tree, (s) => deleteBlockSpec(s, 5))).toBe('- Garden\n  - Beans\n    - water the beans\n  - Peas|')
    })

    it('Duplicate writes a copy below the branch at the same depth', () => {
        expect(after(tree, (s) => duplicateBlockSpec(s, 2))).toBe('- Garden\n  - Beans\n    - water the beans\n  - Beans|\n    - water the beans\n  - Peas\n- Kitchen')
    })

    it('Paste before starts an empty sibling above the Block', () => {
        expect(after(tree, (s) => emptySiblingSpec(s, 2, 'before'))).toBe('- Garden\n  - |\n  - Beans\n    - water the beans\n  - Peas\n- Kitchen')
    })

    it('Paste after starts an empty sibling below the whole branch', () => {
        expect(after(tree, (s) => emptySiblingSpec(s, 2, 'after'))).toBe('- Garden\n  - Beans\n    - water the beans\n  - |\n  - Peas\n- Kitchen')
    })

    it('Cursor to start goes past the marker and a task’s checkbox; Cursor to end to the line’s end', () => {
        expect(after('- [ ] Order seed|', (s) => caretSpec(s, 1, 'start'))).toBe('- [ ] |Order seed')
        expect(after('- Garden|\n  - Beans', (s) => caretSpec(s, 2, 'end'))).toBe('- Garden\n  - Beans|')
    })

    it('Indent, Outdent and the moves act on the whole branch, as their keys do', () => {
        expect(after(tree, (s) => structureSpec(s, 4, indentBranch))).toBe('- Garden\n  - Beans\n    - water the beans\n    - |Peas\n- Kitchen')
        expect(after(tree, (s) => outdentBlockSpec(s, 2, outdentBranch))).toBe('- Garden\n- |Beans\n  - water the beans\n  - Peas\n- Kitchen')
        expect(after(tree, (s) => structureSpec(s, 2, moveBranchDown))).toBe('- Garden\n  - Peas\n  - |Beans\n    - water the beans\n- Kitchen')
    })

    it('a structural row that would change nothing is null, so the menu leaves it out', () => {
        const { state } = editorFixture(tree)
        expect(structureSpec(state, 1, moveBranchUp)).toBeNull()
        expect(structureSpec(state, 2, indentBranch)).toBeNull()
        // Shift+Tab on a top-level bullet makes it a paragraph: not an Outdent.
        expect(outdentBlockSpec(state, 1, outdentBranch)).toBeNull()
    })
})
