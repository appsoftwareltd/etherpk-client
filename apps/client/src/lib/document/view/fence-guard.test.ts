import { describe, expect, it } from 'vitest'

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
