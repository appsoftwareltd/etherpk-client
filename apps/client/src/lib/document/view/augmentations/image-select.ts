/**
 * The **selected image**: the one rendered image whose controls a tap has raised.
 *
 * At rest a picture has nothing over it. A mouse shows its actions and resize handle while it is over
 * the picture, and a click opens the picture's markdown (image-embed.ts), so a mouse selects nothing.
 * A finger or a pen has no hover, so its tap **selects** the picture: its actions and resize handle
 * show, Edit as text first among them, and the markdown stays hidden. The keyboard stays as it was,
 * up or down. A second tap puts the controls away, and so does a press anywhere else in the editor or
 * the caret moving.
 *
 * A tap leaves the caret where it was, with one exception. The caret on another image line shows that
 * line's markdown, and only the caret leaving the line draws the picture again. So a tap while the
 * caret is on such a line moves the caret to the tapped picture's `!` and **parks** it there: the
 * tapped picture's line is drawn as its picture although the caret is on it, and the caret is not
 * drawn. The reveal policy leaves the line unrevealed (reveal-policy.ts → lineKeptDrawn). The park
 * ends when the caret moves, which then shows that line's markdown if the caret is still on it, as
 * any caret does, or when the line stops being an image line. A key that would write or delete at the parked caret opens the picture as
 * text instead and writes nothing (image-embed.ts → parkedKeySpec).
 *
 * Both are editor state, positions of an image's `!`, so they follow the image through edits around
 * it (a line written above, an indent or an outdent) and the rules are read in Node
 * (`outliner-keymap.rules.test.ts`, `image-select.property.test.ts`). The selection never names a
 * line that is not drawn as its picture: one that was deleted, written into something else, revealed,
 * or folded away.
 */

import { foldedRanges } from '@codemirror/language'
import { type EditorState, MapMode, StateEffect, StateField, type Transaction, type TransactionSpec } from '@codemirror/state'

import { analysisFor } from '../analysis/editor-analysis'
import { lineKeptDrawn, lineRevealed, revealedLines } from './reveal-policy'

/** Select the image whose `!` is at the position, or none for null. */
const selectImage = StateEffect.define<number | null>()

/** Park the caret on the image whose `!` is at the position, or end the park for null. */
const parkCaret = StateEffect.define<number | null>()

/**
 * Whether the 1-based line `n` is one the image embed renders: a standalone image or a bullet's
 * only content, outside code. The analysis decides, as it does for the embed's decorations.
 */
export function isRenderedImageLine(state: EditorState, n: number): boolean {
    return analysisFor(state).imageLines.some((image) => image.line === n)
}

/** Where an edit leaves the position of an image's `!`, or null when the edit took the `!` itself. */
function mappedBang(pos: number | null, tr: Transaction): number | null {
    return pos === null ? null : tr.changes.mapPos(pos, 1, MapMode.TrackAfter)
}

/** Whether the transaction puts the caret somewhere of its own: elsewhere than the change left it, or by the pointer, even where it already was. */
export function caretPlaced(tr: Transaction): boolean {
    return (tr.selection !== undefined && !tr.selection.eq(tr.startState.selection.map(tr.changes))) || tr.isUserEvent('select.pointer')
}

/** Whether the caret is still parked on the image line holding `pos`: one empty caret on that line, which is still an image line. */
function stillParked(state: EditorState, pos: number): boolean {
    const { ranges } = state.selection
    const line = state.doc.lineAt(pos)
    return ranges.length === 1 && ranges[0].empty && state.doc.lineAt(ranges[0].head).number === line.number && isRenderedImageLine(state, line.number)
}

/**
 * The image the caret is parked on, by its `!`, or null. Read it through {@link parkedImageLine}. It
 * gives its line to the reveal policy as the line kept drawn (reveal-policy.ts → lineKeptDrawn), so
 * every reveal kind leaves that line unrevealed.
 */
export const parkedImageField = StateField.define<number | null>({
    create: () => null,
    update(parked, tr) {
        // The caret placed anywhere else, or by the pointer, ends it, and so does a key typed or deleted
        // at it: the person is in the text now.
        let next = caretPlaced(tr) || (tr.docChanged && tr.selection !== undefined) ? null : mappedBang(parked, tr)
        for (const effect of tr.effects) if (effect.is(parkCaret)) next = effect.value
        return next !== null && stillParked(tr.state, next) ? next : null
    },
    provide: (field) => lineKeptDrawn.compute([field], (state) => parkedImageLine(state)),
})

/** The 1-based line the caret is parked on, drawn as its picture, or null. Null too where the editor has no image augmentation. */
export function parkedImageLine(state: EditorState): number | null {
    const parked = state.field(parkedImageField, false) ?? null
    return parked === null ? null : state.doc.lineAt(parked).number
}

/** Whether the line holding `pos` is an image line drawn as its picture now. */
export function drawnAsPicture(state: EditorState, pos: number): boolean {
    const line = state.doc.lineAt(pos)
    if (lineRevealed(state, line.number) || !isRenderedImageLine(state, line.number)) return false
    // Inside a fold that starts on a line above it, the picture is not on the page.
    let folded = false
    foldedRanges(state).between(line.from, line.to, (from) => {
        if (from < line.from) folded = true
    })
    return !folded
}

/** The selected image, by its `!`, or null. Read it through {@link selectedImageLine}. */
export const selectedImageField = StateField.define<number | null>({
    create: () => null,
    update(selected, tr) {
        // An edit elsewhere carries the selection along with its image. The image's own deletion
        // deselects: its `!` going is what says so, as the position would otherwise land on the
        // line that follows, and select that line's picture when it has one. A caret placed puts the
        // controls away: the person is in the text now.
        let next = caretPlaced(tr) ? null : mappedBang(selected, tr)
        for (const effect of tr.effects) if (effect.is(selectImage)) next = effect.value
        return next !== null && drawnAsPicture(tr.state, next) ? next : null
    },
})

/** The 1-based line of the selected image, or null. Null too where the editor has no image augmentation. */
export function selectedImageLine(state: EditorState): number | null {
    const selected = state.field(selectedImageField, false) ?? null
    return selected === null ? null : state.doc.lineAt(selected).number
}

/** The position of the `!` of the image on the line starting `lineFrom`. */
function bangOf(state: EditorState, lineFrom: number): number {
    const line = state.doc.lineAt(lineFrom)
    return line.from + Math.max(0, line.text.indexOf('!['))
}

/** Whether a selection range is on an image line, other than line `except`, that shows its markdown. */
function caretOnOtherRevealedImage(state: EditorState, except: number): boolean {
    const active = revealedLines(state)
    for (const n of active) if (n !== except && isRenderedImageLine(state, n)) return true
    return false
}

/**
 * What a tap on the rendered image at the line starting `lineFrom` dispatches: the image selected, or
 * deselected when it was the selected one. The caret stays where it was, unless it is on another
 * image line showing its markdown: then it is parked on the tapped image, so that line is drawn again
 * and the tapped one stays a picture.
 */
export function imageTapSpec(state: EditorState, lineFrom: number): TransactionSpec {
    const n = state.doc.lineAt(lineFrom).number
    const bang = bangOf(state, lineFrom)
    if (caretOnOtherRevealedImage(state, n)) return { selection: { anchor: bang }, effects: [parkCaret.of(bang), selectImage.of(bang)] }
    return { effects: selectImage.of(selectedImageLine(state) === n ? null : bang) }
}

/** What a press anywhere but on the selected image dispatches: no image selected. A parked caret stays parked. */
export function imageDeselectSpec(): TransactionSpec {
    return { effects: selectImage.of(null) }
}

/** The effects that end the selection and the park, for a transaction that puts the caret into an image's markdown. */
export function leavePictureEffects(): StateEffect<unknown>[] {
    return [selectImage.of(null), parkCaret.of(null)]
}
