/**
 * Undo grouping for the collaborative editor (Document Editor.md → Undo).
 *
 * In collab mode CodeMirror's history is replaced by `Y.UndoManager`, which groups edits into one
 * undo step by time alone: anything within `captureTimeout` (500ms) of the previous change joins
 * it, wherever in the document it landed. Type on one line, arrow down six lines and type again
 * within half a second, and one Mod-z rewinds both and drops the caret at the first line — an
 * "odd position, far from the caret". CodeMirror's own history joins only *adjacent* typing and
 * deleting (`@codemirror/commands`, `HistoryState.addChanges`), and never across a selection move,
 * so every other edit is its own step. This plugin holds the undo manager to the same rule: before
 * an edit that should not join the previous one reaches the Y.Text, it calls `stopCapturing()`,
 * and the change opens a new stack item.
 *
 * Ordering is load-bearing: the plugin must sit BEFORE `yCollab()` in the extension list, so its
 * `update` runs before y-codemirror's sync plugin pushes the change into the Y.Text (view plugins
 * update in extension order). The decision itself is pure ({@link joinsPreviousEdit}) and tested
 * headlessly; the ordering is what the browser spec proves.
 */

import { type ChangeDesc, type Extension, Transaction } from '@codemirror/state'
import { ViewPlugin } from '@codemirror/view'
import type * as Y from 'yjs'

import { joinsPreviousUndoStep } from './editor-history'

/** How long after an edit another adjacent edit still joins its undo step (CodeMirror's `newGroupDelay`). */
export const NEW_GROUP_DELAY = 500

/** The user events that may join a running step: typing and deleting, as CodeMirror's history joins. */
const JOINABLE_USER_EVENT = /^(input\.type|delete)($|\.)/

/** What is remembered of the last edit: when it happened and, in the document it produced, the ranges it touched. */
export interface RecordedEdit {
    time: number
    /** Flat `[from, to, from, to, …]` pairs in the document after the edit. */
    ranges: number[]
}

export interface NextEdit {
    time: number
    userEvent: string | undefined
    /** The change, over the document the previous edit produced. */
    changes: ChangeDesc
}

/** The ranges an edit touched, in the document it produced. */
export function recordEdit(time: number, changes: ChangeDesc): RecordedEdit {
    const ranges: number[] = []
    changes.iterChangedRanges((_fromA, _toA, fromB, toB) => ranges.push(fromB, toB))
    return { time, ranges }
}

/** Whether `changes` touches (overlaps or abuts) any range the previous edit produced. */
function isAdjacent(previous: RecordedEdit, changes: ChangeDesc): boolean {
    let adjacent = false
    changes.iterChangedRanges((fromA, toA) => {
        for (let i = 0; i < previous.ranges.length; i += 2) {
            if (fromA <= previous.ranges[i + 1] && toA >= previous.ranges[i]) adjacent = true
        }
    })
    return adjacent
}

/**
 * Whether `next` belongs to the same undo step as `previous`: a typing or deleting event (or a
 * command with no user event), within the group delay, touching what the previous edit touched, and
 * with the selection not moved on its own in between. Anything else starts a new step.
 */
export function joinsPreviousEdit(
    previous: RecordedEdit | null,
    next: NextEdit,
    selectionMovedSince: boolean,
    newGroupDelay = NEW_GROUP_DELAY,
): boolean {
    if (!previous || selectionMovedSince) return false
    if (next.userEvent && !JOINABLE_USER_EVENT.test(next.userEvent)) return false
    if (next.time - previous.time >= newGroupDelay) return false
    return isAdjacent(previous, next.changes)
}

/** The grouping plugin over the collab editor's undo manager; see the module comment for its placement. */
export function undoGrouping(undoManager: Pick<Y.UndoManager, 'stopCapturing'>): Extension {
    return ViewPlugin.define(() => {
        let previous: RecordedEdit | null = null
        let selectionMovedSince = false
        return {
            update(update) {
                if (!update.docChanged) {
                    if (update.selectionSet) selectionMovedSince = true
                    return
                }
                for (const tr of update.transactions) {
                    if (tr.changes.empty) continue
                    const time = tr.annotation(Transaction.time) ?? Date.now()
                    const next = { time, userEvent: tr.annotation(Transaction.userEvent), changes: tr.changes.desc }
                    // A transaction that belongs to the step before it (a Rich Paste's rewrite, ADR 0090) keeps
                    // the capture running whatever it touches; the history's joinNext opens the window for it.
                    const joins = tr.annotation(joinsPreviousUndoStep) === true || joinsPreviousEdit(previous, next, selectionMovedSince)
                    if (!joins) undoManager.stopCapturing()
                    previous = recordEdit(time, tr.changes.desc)
                    selectionMovedSince = false
                }
            },
        }
    })
}
