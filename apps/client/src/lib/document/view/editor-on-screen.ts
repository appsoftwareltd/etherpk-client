/**
 * Whether anyone can see an editor: its tab in front of its Pane, its Pane not collapsed, and the
 * browser tab shown, as the View holding it is told (view-visibility.ts). The desktop keeps a tab
 * behind another mounted and hidden, so nothing in the editor's own DOM can tell.
 *
 * The View says so (`setEditorOnScreen`, and `editorOnScreen.init` for the editor it creates), and
 * a widget that holds something costly while it is drawn reads it: the interactive fences pass it to
 * their widgets (`InteractiveFenceContext.onScreen`), so a Map Block behind another tab lets its
 * WebGL context go. An editor no View tells about is on screen, as every editor was before.
 */
import { type EditorState, StateEffect, StateField } from '@codemirror/state'

/** The View's word that its editor came on screen (true) or went out of sight (false). */
export const setEditorOnScreen = StateEffect.define<boolean>()

export const editorOnScreen = StateField.define<boolean>({
    create: () => true,
    update(onScreen, tr) {
        for (const effect of tr.effects) if (effect.is(setEditorOnScreen)) onScreen = effect.value
        return onScreen
    },
})

/** Whether the editor is on screen: true where no View says otherwise. */
export function editorIsOnScreen(state: EditorState): boolean {
    return state.field(editorOnScreen, false) ?? true
}
