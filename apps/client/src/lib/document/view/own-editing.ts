import type { Transaction } from '@codemirror/state'

/**
 * Typing, deleting, pasting, dragging, moving lines, undoing: what CodeMirror marks as the user's
 * own doing. Read the user event, never "has any user event": a caret move carries `select`, and
 * leave-tidy adds its trailing-space trim to that same transaction (leave-tidy.ts), so a click can
 * change the document without the user editing anything. A collaborator's change, an external
 * write and a file read landing carry no user event at all.
 */
export function isOwnEditing(tr: Transaction): boolean {
    return ['input', 'delete', 'move', 'undo', 'redo'].some((event) => tr.isUserEvent(event))
}
