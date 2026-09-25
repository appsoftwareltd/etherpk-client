/**
 * Take an [[Asset Reference]] out of the open document — the half of a trash click that is
 * always allowed, whether or not the bytes go with it (ADR 0054).
 *
 * A `StateCommand`, like every structural editor operation here, so it is exercised over a real
 * `EditorState` with no DOM (Document Editor.md → *Test split*). It is an **ordinary undoable
 * edit**: Ctrl+Z brings the reference back. When the bytes went too that restores markdown over
 * nothing, and the image renders as the existing broken affordance showing its alt text — a
 * deliberate trade against silently breaking Ctrl+Z, which is the worse surprise.
 *
 * The reference is re-found on the line at dispatch time rather than trusted as a stored
 * offset: a widget's DOM outlives edits above it, and an offset baked in when the menu opened
 * would cut the wrong text. If it is no longer there, the command declines and changes nothing.
 */

import type { EditorState, StateCommand } from '@codemirror/state'

import { assetReferenceCut, findAssetReference } from '../asset-reference'
import { healAfterRangeDelete } from '../outliner'
import { minimalReplacement } from './minimal-replacement'

export interface AssetReferenceTarget {
    /** The reference exactly as the document writes it. */
    ref: string
    /** 1-based line number holding it, as of when the user acted. */
    line: number
    /** Which occurrence of `ref` on that line, 0-based. */
    occurrence: number
}

// Kept here for its existing callers; the helper itself is shared with the external-text path.
export { minimalReplacement }

/** Where the reference sits right now, or `null` when the document no longer holds it there. */
function locate(state: EditorState, target: AssetReferenceTarget) {
    if (target.line < 1 || target.line > state.doc.lines) return null
    const line = state.doc.line(target.line)
    const span = findAssetReference(line.text, target.ref, target.occurrence)
    return span && { line, cut: assetReferenceCut(line.text, span) }
}

/** True when this reference can still be found where the caller said it was. */
export function canRemoveAssetReference(state: EditorState, target: AssetReferenceTarget): boolean {
    return locate(state, target) !== null
}

export function removeAssetReference(target: AssetReferenceTarget): StateCommand {
    return ({ state, dispatch }) => {
        const found = locate(state, target)
        if (!found) return false
        const { line, cut } = found

        if (!cut.wholeLine) {
            const from = line.from + cut.from
            dispatch(
                state.update({
                    changes: { from, to: line.from + cut.to },
                    selection: { anchor: from },
                    userEvent: 'delete.asset',
                }),
            )
            return true
        }

        // The line goes, terminator included. A last line carries no trailing newline, so take
        // the one that precedes it instead — otherwise the document is left ending in a blank.
        const lastLine = line.number === state.doc.lines
        const from = lastLine ? Math.max(0, line.from - 1) : line.from
        const to = lastLine ? line.to : line.to + 1
        const removed = state.update({
            changes: { from, to },
            selection: { anchor: from },
            userEvent: 'delete.asset',
        })

        // Heal the outline exactly as a multi-line cut does (ADR 0021): a bullet holding nothing
        // but an image can have children, and taking its line away would otherwise leave them
        // floating a level below an ancestor that is gone.
        const after = removed.state
        const text = after.doc.toString()
        const caretLine = after.doc.lineAt(Math.min(from, after.doc.length)).number - 1
        const healed = healAfterRangeDelete(text.split('\n'), caretLine).lines.join('\n')
        const change = minimalReplacement(text, healed)
        if (!change) {
            dispatch(removed)
            return true
        }
        dispatch(removed)
        dispatch(after.update({ changes: change, userEvent: 'delete.asset' }))
        return true
    }
}
