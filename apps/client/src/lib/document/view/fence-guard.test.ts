import { describe, expect, it } from 'vitest'

import { EditorState } from '@codemirror/state'

import { deletionBreaksFence } from './fence-guard'
import { editorFixture } from './testing/editor-state-fixture'

describe('fence guard', () => {
    it('snaps a closer nudged right by a raw edit back to the fence column', () => {
        const editor = editorFixture('- ```\n  a|\n  ```')
        const closer = editor.state.doc.line(3)
        editor.dispatch(editor.state.update({ changes: { from: closer.from, insert: '  ' } })) // now 4 columns in
        expect(editor.text()).toBe('- ```\n  a\n  ```')
    })

    it('leaves an existing block alone when the edit is a new opener above it', () => {
        const editor = editorFixture('- a\n  |\n  - d\n    ```\n    x\n    ```')
        for (const ch of ['`', '`', '`']) editor.dispatch(editor.state.update(editor.state.replaceSelection(ch), { userEvent: 'input.type' }))
        // The block under `d` keeps its column-4 fences; the new opener is simply unclosed.
        expect(editor.text()).toBe('- a\n  ```\n  - d\n    ```\n    x\n    ```')
    })
})

/** Insert `text` at the start of each of the 1-based `lineNumbers`, in one raw edit. */
function nudge(editor: ReturnType<typeof editorFixture>, lineNumbers: number[], text = ' '): void {
    const changes = lineNumbers.map((n) => ({ from: editor.state.doc.line(n).from, insert: text }))
    editor.dispatch(editor.state.update({ changes }))
}

// A repair restores the pairing the strict scan read before the edit. After the edit the opener may
// pair with a stray fence further down, and that pairing is the nudge's doing, not one to keep.
describe('fence guard, a nudged closer beside other fences', () => {
    it('snaps the closer back with a stray fence below, so the prose between stays prose', () => {
        const editor = editorFixture('```js\nx\n|```\npara\n```')
        nudge(editor, [3])
        expect(editor.text()).toBe('```js\nx\n```\npara\n```')
    })

    it('in a bullet\'s block with a stray fence below in the same bullet', () => {
        const editor = editorFixture('- ```\n  a\n  ```|\n  b\n  ```')
        nudge(editor, [3], '  ')
        expect(editor.text()).toBe('- ```\n  a\n  ```\n  b\n  ```')
    })

    it('at depth 2', () => {
        const editor = editorFixture('- a\n  - ```\n    x\n    ```|\n    y\n    ```')
        nudge(editor, [4])
        expect(editor.text()).toBe('- a\n  - ```\n    x\n    ```\n    y\n    ```')
    })

    it('with a run of blocks below, which keep their own pairs', () => {
        const editor = editorFixture('```\nx\n|```\np\n```\ny\n```\nq\n```')
        nudge(editor, [3])
        expect(editor.text()).toBe('```\nx\n```\np\n```\ny\n```\nq\n```')
    })

    it('two closers nudged in one edit both snap back', () => {
        const editor = editorFixture('```\nx\n```|\np\n```\ny\n```')
        nudge(editor, [3, 7])
        expect(editor.text()).toBe('```\nx\n```\np\n```\ny\n```')
    })

    it('never takes an inner closer of a three-backtick sample for the sample\'s own when the inner opener goes', () => {
        const editor = editorFixture('```md\ntext\n  ```js|\n  x\n  ```\n```')
        const opener = editor.state.doc.line(3)
        editor.dispatch(editor.state.update({ changes: { from: opener.from, to: opener.to } }))
        expect(editor.text()).toBe('```md\ntext\n\n  x\n  ```\n```')
    })
})

// The tolerant scan pairs any two fences of one length up to three columns apart. Only an edit that
// wrote or moved the lower one left a closer to snap back.
describe('fence guard, two stray fences the edit did not touch', () => {
    it('leaves both where they are when a character is typed between them', () => {
        const editor = editorFixture('```\n- water the beans|\n ```')
        editor.type('x')
        expect(editor.fixture()).toBe('```\n- water the beansx|\n ```')
    })

    it('leaves both where they are when text is pasted into a bullet’s block between them', () => {
        const editor = editorFixture('````\n- a\n  ```\n  x|\n  ```\n  ````')
        editor.paste('one\ntwo')
        expect(editor.fixture()).toBe('````\n- a\n  ```\n  xone\n  two|\n  ```\n  ````')
    })

    it('still snaps back a closer typed a column right of an opener that had none', () => {
        const editor = editorFixture('- ```\n  a\n   ``|')
        editor.type('`')
        expect(editor.text()).toBe('- ```\n  a\n  ```')
    })

    it('keeps the caret on the fence column when a space typed there nudges the closer', () => {
        const editor = editorFixture('- a\n  ```\n  |```')
        editor.type(' ')
        expect(editor.fixture()).toBe('- a\n  ```\n  |```')
    })
})

describe('fence guard, keystroke by keystroke', () => {
    it('does not drag a nested block\'s opener left while a closer is being typed above it', () => {
        const editor = editorFixture('- a\n  ```\n  |\n  - b\n    - c\n  - d\n    ```\n    x\n    ```\n- e')
        for (const ch of '```') {
            editor.dispatch(editor.state.update(editor.state.replaceSelection(ch), { userEvent: 'input.type' }))
            expect(editor.state.doc.line(7).text).toBe('    ```') // the nested block's opener stays at column 4
        }
        expect(editor.text()).toBe('- a\n  ```\n  ```\n  - b\n    - c\n  - d\n    ```\n    x\n    ```\n- e')
    })
})

describe('deletionBreaksFence', () => {
    /** Whether deleting the text between `«` and `»` would break a fence. */
    const breaks = (fixture: string) => {
        const from = fixture.indexOf('«')
        const to = fixture.indexOf('»') - 1
        const doc = fixture.replace('«', '').replace('»', '')
        return deletionBreaksFence(EditorState.create({ doc }), from, to)
    }

    it('is a delete of a fence line’s indent, or a form-1 bullet’s marker, that moves the fence alone', () => {
        expect(breaks('- a\n«  »```\n  x\n  ```')).toBe(true)
        expect(breaks('«- »```py\n  x\n  ```')).toBe(true)
    })

    it('is a join of text onto a fence line, from above or below', () => {
        expect(breaks('```\nx«\n»```')).toBe(true) // the closer onto the code line
        expect(breaks('```\nx\n```«\n»p')).toBe(true) // the next line onto the closer
        expect(breaks('```\nx\n``` « \np»q')).toBe(true) // from the closer's trailing space
    })

    it('is not a delete that takes the fence’s own text, nor one that merges an empty line', () => {
        expect(breaks('`«`»`\nx\n```')).toBe(false) // a backtick
        expect(breaks('```j«s»\nx\n```')).toBe(false) // the info string
        expect(breaks('p\n«\n»```\nx\n```')).toBe(false) // an empty line above the opener
        expect(breaks('```\nx\n```«\n»')).toBe(false) // an empty line below the closer
    })

    it('is not a delete in prose or code away from a fence, nor at a fence-like line of the frontmatter', () => {
        expect(breaks('a«b\nc»d')).toBe(false)
        expect(breaks('```\nx«y\nz»\n```')).toBe(false)
        expect(breaks('---\ndesc: >\n«  »```\n  x\n  ```\n---\nbody')).toBe(false)
    })
})
