/**
 * Undo and redo as Commands, whichever history the editor holds (Document Editor.md → Undo).
 *
 * A [[Filesystem Backend]] editor keeps CodeMirror's own history and binds Mod-z / Mod-y to its
 * `undo` / `redo`; a synced graph's editor replaces it with a Y.UndoManager and binds the same
 * keys to y-codemirror.next's. A surface that holds only a view - the mobile [[Command Bar]]'s
 * undo and redo buttons, a future keybinding - cannot know which, so the editor declares its
 * history here and {@link undoCommand} / {@link redoCommand} run exactly what the keystroke
 * would. The depths feed the buttons' greying, the way `bodyWritable` feeds the editing ones.
 */

import { history, redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import { Annotation, type EditorState, type Extension, Facet, StateField, Transaction, type TransactionSpec } from '@codemirror/state'
import type { Command } from '@codemirror/view'
import { yUndoManagerKeymap } from 'y-codemirror.next'
import type * as Y from 'yjs'

/** The undo and redo Commands the editor's history keymap runs, and how deep each stack is. */
export interface EditorHistory {
    undo: Command
    redo: Command
    undoDepth: (state: EditorState) => number
    redoDepth: (state: EditorState) => number
    /**
     * Run `dispatch` so that the changes it makes join the undo step before them, however long ago
     * that was ({@link dispatchIntoPreviousUndoStep}). Absent, the annotation alone does it (the local
     * history reads it); the collaborative history needs its capture window opened for the dispatch.
     */
    joinNext?: (dispatch: () => void) => void
}

/**
 * The user event of the transaction that opens a **joinable undo step**: a [[Rich Paste]], whose
 * reference rewrites land seconds later and must undo with it, never as steps of their own (ADR
 * 0090). A user event rather than an annotation because the paste filter reshapes a paste into a
 * new transaction and keeps only its user event; `isUserEvent('input.paste')` still matches it.
 */
export const RICH_PASTE_USER_EVENT = 'input.paste.rich'

/** A transaction that belongs to the joinable step before it: a Rich Paste's reference rewrite. */
export const joinsPreviousUndoStep = Annotation.define<boolean>()

/**
 * Whether the last joinable step is still the last step: nothing has changed the document since
 * except its own rewrites, and the selection has not moved on its own. Any other edit, an undo, or a
 * caret move closes it, on either history alike, and a rewrite arriving after that is a step of its
 * own - joining it onto whatever step happened to be last would undo that step with it.
 */
export const joinableUndoStepField = StateField.define<boolean>({
    create: () => false,
    update(open, tr) {
        if (tr.isUserEvent(RICH_PASTE_USER_EVENT)) return true
        if (tr.annotation(joinsPreviousUndoStep)) return open
        if (tr.docChanged || tr.selection) return false
        return open
    },
})

/**
 * CodeMirror's own history, joining a transaction marked {@link joinsPreviousUndoStep} onto the step
 * before it. The history joins only within its group delay, so such a transaction also carries a
 * time of 0, which is always "within" it; the step then ends, since the next real edit is far from 0.
 */
export function localHistoryExtension(): Extension {
    return [history({ joinToEvent: (tr, adjacent) => adjacent || tr.annotation(joinsPreviousUndoStep) === true }), joinableUndoStepField]
}

/** What {@link dispatchIntoPreviousUndoStep} needs of a view: an `EditorView`, or a test's stand-in over a state. */
export interface UndoStepTarget {
    state: EditorState
    dispatch(spec: TransactionSpec): void
}

/**
 * Dispatch `spec` so its changes join the joinable undo step before them, on whichever history `view`
 * holds - or as a step of their own when that step has been closed since ({@link joinableUndoStepField}).
 */
export function dispatchIntoPreviousUndoStep(view: UndoStepTarget, spec: TransactionSpec): void {
    if (!view.state.field(joinableUndoStepField, false)) {
        // A step of its own: with a user event the history never joins onto typing, so a rewrite landing
        // within the group delay of a keystroke does not fold into that keystroke's step either.
        view.dispatch({ ...spec, userEvent: spec.userEvent ?? 'input.complete' })
        return
    }
    const given = spec.annotations === undefined ? [] : Array.isArray(spec.annotations) ? spec.annotations : [spec.annotations]
    const joined: TransactionSpec = { ...spec, annotations: [...given, joinsPreviousUndoStep.of(true), Transaction.time.of(0)] }
    const editorHistoryOf = view.state.facet(editorHistory)
    if (editorHistoryOf.joinNext) editorHistoryOf.joinNext(() => view.dispatch(joined))
    else view.dispatch(joined)
}

/** CodeMirror's own history: what an editor has unless it declares otherwise. */
const localHistory: EditorHistory = { undo, redo, undoDepth, redoDepth }

/** The editor's history; absent, CodeMirror's own (`history()`), whose keymap binds the same Commands. */
export const editorHistory = Facet.define<EditorHistory, EditorHistory>({
    combine: (values) => values[values.length - 1] ?? localHistory,
})

/**
 * The collaborative editor's history over `undoManager`. y-codemirror.next exports its undo and
 * redo only through its keymap (v0.3.5), so they are taken from the bindings the editor installs -
 * which is also the guarantee that a button and Mod-z do the same thing.
 */
export function collabEditorHistory(undoManager: Pick<Y.UndoManager, 'undoStack' | 'redoStack' | 'captureTimeout'>): EditorHistory {
    const binding = (key: string): Command => {
        const found = yUndoManagerKeymap.find((b) => b.key === key)?.run
        if (!found) throw new Error(`y-codemirror.next binds no ${key}`)
        return found
    }
    return {
        undo: binding('Mod-z'),
        redo: binding('Mod-y'),
        undoDepth: () => undoManager.undoStack.length,
        redoDepth: () => undoManager.redoStack.length,
        // The manager merges a change into the last stack item only within its capture window; opening
        // the window for the dispatch joins the change to that item however long ago it was made. The
        // grouping plugin (undo-grouping.ts) leaves a marked transaction's capture running for the same
        // reason. The sync into the Y.Text is synchronous inside the dispatch, so the window closes again
        // before anything else can fall into it.
        joinNext: (dispatch) => {
            const captureTimeout = undoManager.captureTimeout
            undoManager.captureTimeout = Number.POSITIVE_INFINITY
            try {
                dispatch()
            } finally {
                undoManager.captureTimeout = captureTimeout
            }
        },
    }
}

/** Undo the last step of whichever history the view holds; what Mod-z does. */
export const undoCommand: Command = (view) => view.state.facet(editorHistory).undo(view)

/** Redo the last undone step of whichever history the view holds; what Mod-y does. */
export const redoCommand: Command = (view) => view.state.facet(editorHistory).redo(view)

/** Whether there is a step to undo (the Command Bar's undo button greys otherwise). */
export function canUndo(state: EditorState): boolean {
    return state.facet(editorHistory).undoDepth(state) > 0
}

/** Whether there is an undone step to redo. */
export function canRedo(state: EditorState): boolean {
    return state.facet(editorHistory).redoDepth(state) > 0
}
