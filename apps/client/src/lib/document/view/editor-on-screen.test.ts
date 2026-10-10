import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { editorIsOnScreen, editorOnScreen, setEditorOnScreen } from './editor-on-screen'

// Whether anyone can see an editor, as the View holding it says (view-visibility.ts): a widget that
// holds something costly while drawn reads it, so a map behind another tab lets its WebGL go.

describe('whether an editor is on screen', () => {
    it('is on screen when no View says otherwise, with or without the field', () => {
        expect(editorIsOnScreen(EditorState.create({ doc: '' }))).toBe(true)
        expect(editorIsOnScreen(EditorState.create({ doc: '', extensions: [editorOnScreen] }))).toBe(true)
    })

    it('starts as the View says, and follows what it says after', () => {
        const hidden = EditorState.create({ doc: '', extensions: [editorOnScreen.init(() => false)] })
        expect(editorIsOnScreen(hidden)).toBe(false)
        const shown = hidden.update({ effects: setEditorOnScreen.of(true) }).state
        expect(editorIsOnScreen(shown)).toBe(true)
        expect(editorIsOnScreen(shown.update({ effects: setEditorOnScreen.of(false) }).state)).toBe(false)
        // Any other change leaves it as it was.
        expect(editorIsOnScreen(shown.update({ changes: { from: 0, insert: 'Garden' } }).state)).toBe(true)
    })
})
