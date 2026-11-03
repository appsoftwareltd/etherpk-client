/**
 * The outline level an editor draws from: column 0 in an editor that shows a whole document, and in
 * an editor that shows one part of it (`shown-range.ts`: the [[Task Editor]]'s description and
 * comments, ADR 0170) the level below the bullet the part is nested under, so the part reads as a
 * document of its own, as a block zoomed into does in Logseq. The part's first-level bullets (the
 * task's children, or each comment) sit at the left edge with no guide beside them, as a top-level
 * bullet does in a tab, and each level below them is one step in.
 *
 * Display only. The text keeps its real indentation, so Enter, Tab, Shift+Tab and a paste write
 * what they write anywhere in the document; only the drawing moves. The content clamp
 * (`content-clamp.ts`) moves the whole text area left by the base level's width, which keeps every
 * alignment it and the block widgets make inside it, and the guides (`outline-guides.ts`) hang
 * threads only from the lines the part shows.
 *
 * The level comes from the bullet the part is nested under, never from what the part holds, so it
 * stays put while the person types: a description of prose alone, or the first bullet typed into
 * one, draws from the same level as one full of bullets. Prose nested under the task is the task's
 * own continuation, one level up, so it hangs a couple of pixels left of the first-level dots, as
 * it hangs beside the task's children in a tab.
 *
 * The level's indent is the Indent Unit past the parent's. A child indented off that grid (four
 * spaces under a task at column 0, ADR 0067) is drawn the difference further in.
 */
import { type EditorState, Facet } from '@codemirror/state'

/** The level an editor draws from, and the lines it shows from there. */
export interface OutlineBase {
    /** The structural depth of the level drawn at the left edge. */
    depth: number
    /** The columns a bullet on that level is indented. */
    indent: number
    /** The 0-based lines shown, first and last included: a guide hangs only from one of these. */
    shown: { first: number; last: number }
}

/** The level an editor draws from; null (no value given) draws from column 0. */
export const outlineBaseFacet = Facet.define<OutlineBase | null, OutlineBase | null>({
    combine: (values) => values.find((value) => value !== null) ?? null,
    compare: (a, b) =>
        a === b ||
        (!!a && !!b && a.depth === b.depth && a.indent === b.indent && a.shown.first === b.shown.first && a.shown.last === b.shown.last),
})

/** The level `state`'s editor draws from, or null for column 0. */
export function outlineBaseIn(state: EditorState): OutlineBase | null {
    return state.facet(outlineBaseFacet)
}
