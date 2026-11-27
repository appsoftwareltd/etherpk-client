/**
 * A picture being rotated: Rotate pressed on its actions, and the turn not yet saved or cancelled.
 *
 * Rotate shows the picture a quarter turn clockwise and puts three buttons in place of its actions:
 * Rotate again, Save and Cancel. Nothing is stored until Save, which the workspace carries out
 * (`../../image-rotation.ts`): the turned picture is saved as a new Asset and the references to the
 * old one move to it. Escape, Cancel, the caret placed anywhere, or the picture stopping being drawn
 * (its line edited, deleted or folded away) ends the rotation with nothing changed.
 *
 * Editor state, the position of the image's `!`, so it follows the picture through edits around it
 * and the rules are read in Node (`outliner-keymap.rules.test.ts`).
 */

import { MapMode, StateEffect, StateField, type EditorState, type Transaction, type TransactionSpec } from '@codemirror/state'

import { nextQuarterTurns } from '../../image-rotation'
import { caretPlaced, drawnAsPicture } from './image-select'

export interface PictureRotation {
    /** The position of the picture's `!`. */
    readonly pos: number
    /** Quarter turns clockwise from how it is stored. */
    readonly turns: number
    /** How many other documents the Save would change too, once counted. */
    readonly elsewhere: number | null
    /** Save is under way: the buttons wait for it. */
    readonly saving: boolean
}

const startRotation = StateEffect.define<number>()
const turnRotation = StateEffect.define<null>()
const countElsewhere = StateEffect.define<number>()
const markSaving = StateEffect.define<boolean>()
const endRotation = StateEffect.define<null>()

/** The rotation through a transaction's edits: gone once the caret is placed or the picture's `!` deleted. */
function carried(value: PictureRotation | null, tr: Transaction): PictureRotation | null {
    // The caret placed anywhere is the person moving on: the turn was not wanted.
    if (value === null || caretPlaced(tr)) return null
    const pos = tr.changes.mapPos(value.pos, 1, MapMode.TrackAfter)
    return pos === null ? null : pos === value.pos ? value : { ...value, pos }
}

/** The rotation after one of this module's effects. */
function applied(value: PictureRotation | null, effect: StateEffect<unknown>): PictureRotation | null {
    if (effect.is(startRotation)) return { pos: effect.value, turns: 1, elsewhere: null, saving: false }
    if (value === null || effect.is(endRotation)) return null
    if (effect.is(turnRotation)) return { ...value, turns: nextQuarterTurns(value.turns) }
    if (effect.is(countElsewhere)) return { ...value, elsewhere: effect.value }
    if (effect.is(markSaving)) return { ...value, saving: effect.value }
    return value
}

export const rotationField = StateField.define<PictureRotation | null>({
    create: () => null,
    update(value, tr) {
        const next = tr.effects.reduce(applied, carried(value, tr))
        return next !== null && drawnAsPicture(tr.state, next.pos) ? next : null
    },
})

/** The picture being rotated, or null. Null too in an editor with no image augmentation. */
export function pictureRotation(state: EditorState): PictureRotation | null {
    return state.field(rotationField, false) ?? null
}

/** The 1-based line of the picture being rotated, or null. */
export function rotatingImageLine(state: EditorState): number | null {
    const rotation = pictureRotation(state)
    return rotation === null ? null : state.doc.lineAt(rotation.pos).number
}

/** Rotate on the picture on line `n`: shown a quarter turn clockwise, nothing stored yet. */
export function startRotationSpec(state: EditorState, n: number): TransactionSpec {
    const line = state.doc.line(n)
    return { effects: startRotation.of(line.from + Math.max(0, line.text.indexOf('!['))) }
}

/** Rotate again: one more quarter turn, back to how it is stored after four. */
export function turnRotationSpec(): TransactionSpec {
    return { effects: turnRotation.of(null) }
}

/** The count of other documents a Save would change, once the index has answered. */
export function countElsewhereSpec(documents: number): TransactionSpec {
    return { effects: countElsewhere.of(documents) }
}

/** Save under way (true), or failed and the buttons back (false). */
export function savingSpec(saving: boolean): TransactionSpec {
    return { effects: markSaving.of(saving) }
}

/** Cancel, Escape, or a Save done: the picture as it is stored, or as the Save left it. */
export function endRotationSpec(): TransactionSpec {
    return { effects: endRotation.of(null) }
}
