/**
 * Module accessor for the **active editor view** — the focused document's CodeMirror
 * `EditorView` (Dual Mode Editor.md → *Command Menu*, "Editor plumbing"). Mirrors the
 * other `getActive*` singletons. Command Menu handlers (date insertion, table edits) and
 * any future keybindings reach the live editor through this, rather than the menu passing
 * the view — because a keybinding invoker holds no view. Handlers no-op when it is null
 * (focus is not in an editor).
 *
 * "Active" is singular today (one focused editor at a time); a multi-graph-open future
 * would make this graph-scoped, like the rest of the surface (ADR 0014).
 */

import type { EditorView } from '@codemirror/view'

let active: EditorView | null = null

export function setActiveEditorView(view: EditorView | null): void {
    active = view
}

/** The focused editor's view, or null when focus is not in a document editor. */
export function getActiveEditorView(): EditorView | null {
    return active
}

/** Clear the accessor only if `view` is still the active one (safe on unmount). */
export function clearActiveEditorView(view: EditorView): void {
    if (active === view) active = null
}
