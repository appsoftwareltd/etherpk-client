/**
 * One entry in an inline **action cluster**: the row of small icon buttons that follows an
 * [[Asset Reference]] or a [[File Link]] in the editor and in a quoted line alike. The cluster
 * is drawn twice (an imperative widget inside CodeMirror, a Svelte component in the read-only
 * rows) but described once, by the list of these a surface is handed.
 */
export interface InlineAction {
    /** The [[Command]] to run. */
    command: string
    /** A name in the shared icon table (`surface/icons.ts`). */
    icon: string
    label: string
    /**
     * What to show in the button's place, briefly, once the Command has succeeded - for an action
     * whose effect is otherwise invisible (a copy). Absent where the outcome shows itself (the
     * image is gone, a tab has opened, the browser is saving a file).
     */
    confirm?: { icon: string; label: string }
}
