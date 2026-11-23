/**
 * The **selected image**: the one rendered image whose controls a tap has raised.
 *
 * A mouse shows a picture's actions and resize handle while it is over the picture, and its click
 * then reveals the markdown (image-embed.ts). A finger has no hover, so a tap with a finger or a
 * pen selects the picture instead: its controls show, with Edit as text among them, and the
 * markdown stays hidden with the caret, and the keyboard, where they were. A second tap on it, a
 * press anywhere else in the editor, or the caret moving puts them away.
 *
 * The selection is editor state, the position of the image's `!`, so it follows the image through
 * edits around it (a line written above, an indent or an outdent) and the rule is read in Node
 * (`outliner-keymap.rules.test.ts`, `image-select.property.test.ts`). It never names a line that
 * is not drawn as its picture: one that was deleted, written into something else, revealed, or
 * folded away.
 */

import { foldedRanges } from '@codemirror/language'
import { type EditorState, MapMode, StateEffect, StateField, type TransactionSpec } from '@codemirror/state'

import { analysisFor } from '../analysis/editor-analysis'
import { lineRevealed } from './reveal-policy'

/** Select the image whose `!` is at this position, or none for null. */
const selectImage = StateEffect.define<number | null>()

/**
 * Whether the 1-based line `n` is one the image embed renders: a standalone image or a bullet's
 * only content, outside code. The analysis decides, as it does for the embed's decorations.
 */
export function isRenderedImageLine(state: EditorState, n: number): boolean {
    return analysisFor(state).imageLines.some((image) => image.line === n)
}

/** Whether the line holding `pos` is an image line drawn as its picture now. */
function drawnAsPicture(state: EditorState, pos: number): boolean {
    const line = state.doc.lineAt(pos)
    if (lineRevealed(state, line.number) || !isRenderedImageLine(state, line.number)) return false
    // Inside a fold that starts on a line above it, the picture is not on the page.
    let folded = false
    foldedRanges(state).between(line.from, line.to, (from) => {
        if (from < line.from) folded = true
    })
    return !folded
}

/** The position of the selected image's `!`, or null. Read it through {@link selectedImageLine}. */
export const selectedImageField = StateField.define<number | null>({
    create: () => null,
    update(pos, tr) {
        // An edit elsewhere carries the selection along with its image. The image's own deletion
        // deselects: its `!` going is what says so, as the position would otherwise land on the
        // line that follows, and select that line's picture when it has one.
        let next = pos === null ? null : tr.changes.mapPos(pos, 1, MapMode.TrackAfter)
        // The caret put somewhere other than where the change left it: the person is in the text now.
        if (tr.selection && !tr.selection.eq(tr.startState.selection.map(tr.changes))) next = null
        for (const effect of tr.effects) if (effect.is(selectImage)) next = effect.value
        return next !== null && drawnAsPicture(tr.state, next) ? next : null
    },
})

/** The 1-based line of the selected image, or null. Null too where the editor has no image augmentation. */
export function selectedImageLine(state: EditorState): number | null {
    const pos = state.field(selectedImageField, false) ?? null
    return pos === null ? null : state.doc.lineAt(pos).number
}

/**
 * What a tap on the rendered image at the line starting `lineFrom` dispatches: the image selected,
 * or deselected when it was the selected one. The caret does not move.
 */
export function imageTapSpec(state: EditorState, lineFrom: number): TransactionSpec {
    const line = state.doc.lineAt(lineFrom)
    const bang = line.from + Math.max(0, line.text.indexOf('!['))
    return { effects: selectImage.of(selectedImageLine(state) === line.number ? null : bang) }
}

/** What a press anywhere but on the selected image dispatches: no image selected. */
export function imageDeselectSpec(): TransactionSpec {
    return { effects: selectImage.of(null) }
}
