/**
 * The **selected image**: the one rendered image whose controls a tap or a click has raised.
 *
 * At rest a picture has nothing over it. A tap with a finger or a pen, or a click of a mouse, selects
 * it: its actions and resize handle show, Edit as text first among them, and the markdown stays
 * hidden with the caret where it was. A press anywhere else in the editor, or the caret moving, puts
 * them away.
 *
 * The two differ in the keyboard. A tap leaves it as it was, up or down, and a second tap puts the
 * controls away. A clicked picture **holds the keyboard** (image-keyboard.ts): with a hardware
 * keyboard, a key pressed at a selected picture would otherwise write at a caret that may be off
 * screen. It leaves the keyboard alone where giving it to the editor would do something else: a table
 * cell being written would take it, and a part of the Task Editor whose caret is on the picture's line
 * would show the markdown. A second click leaves the controls showing, so that a double click, which is Edit as text,
 * does not flash them.
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
import { cellHasKeyboard, lineRevealed } from './reveal-policy'

/** The image whose `!` is at `pos`, selected. */
interface SelectedImage {
    readonly pos: number
    /** A click selected it, so the picture holds the keyboard. A tap leaves the keyboard alone. */
    readonly keyboard: boolean
}

/** Select an image, or none for null. */
const selectImage = StateEffect.define<SelectedImage | null>()

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

/** The selected image, or null. Read it through {@link selectedImageLine}. */
export const selectedImageField = StateField.define<SelectedImage | null>({
    create: () => null,
    update(selected, tr) {
        // An edit elsewhere carries the selection along with its image. The image's own deletion
        // deselects: its `!` going is what says so, as the position would otherwise land on the
        // line that follows, and select that line's picture when it has one.
        let next = selected === null ? null : carried(selected, tr.changes.mapPos(selected.pos, 1, MapMode.TrackAfter))
        // The caret put somewhere other than where the change left it, or put by the pointer, even where
        // it already was: the person is in the text now.
        if (tr.selection && !tr.selection.eq(tr.startState.selection.map(tr.changes))) next = null
        if (tr.isUserEvent('select.pointer')) next = null
        for (const effect of tr.effects) if (effect.is(selectImage)) next = effect.value
        return next !== null && drawnAsPicture(tr.state, next.pos) ? next : null
    },
})

/** `selected` at `pos`, the same object when it has not moved, so a field that kept its value says so. */
function carried(selected: SelectedImage, pos: number | null): SelectedImage | null {
    if (pos === null) return null
    return pos === selected.pos ? selected : { ...selected, pos }
}

/** The 1-based line of the selected image, or null. Null too where the editor has no image augmentation. */
export function selectedImageLine(state: EditorState): number | null {
    const selected = state.field(selectedImageField, false) ?? null
    return selected === null ? null : state.doc.lineAt(selected.pos).number
}

/** Whether an image is selected and holds the keyboard: a click selected it. */
export function selectedImageHoldsKeyboard(state: EditorState): boolean {
    return state.field(selectedImageField, false)?.keyboard ?? false
}

/** The position of the `!` of the image on the line starting `lineFrom`. */
function bangOf(state: EditorState, lineFrom: number): number {
    const line = state.doc.lineAt(lineFrom)
    return line.from + Math.max(0, line.text.indexOf('!['))
}

/**
 * What a tap on the rendered image at the line starting `lineFrom` dispatches: the image selected,
 * or deselected when it was the selected one. The caret does not move.
 */
export function imageTapSpec(state: EditorState, lineFrom: number): TransactionSpec {
    const again = selectedImageLine(state) === state.doc.lineAt(lineFrom).number
    return { effects: selectImage.of(again ? null : { pos: bangOf(state, lineFrom), keyboard: false }) }
}

/**
 * What a mouse's click on the rendered image at the line starting `lineFrom` dispatches: the image
 * selected, holding the keyboard unless the editor has something else to do with it. The caret does
 * not move.
 */
export function imagePressSpec(state: EditorState, lineFrom: number): TransactionSpec {
    const line = state.doc.lineAt(lineFrom)
    const caretOnLine = state.selection.ranges.some((range) => range.from <= line.to && range.to >= line.from)
    return { effects: selectImage.of({ pos: bangOf(state, lineFrom), keyboard: !caretOnLine && !cellHasKeyboard(state) }) }
}

/** What a press anywhere but on the selected image dispatches: no image selected. */
export function imageDeselectSpec(): TransactionSpec {
    return { effects: selectImage.of(null) }
}
