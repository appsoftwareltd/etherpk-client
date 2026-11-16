/**
 * The bullet [[Block]] an open block menu is for, followed through edits (Editor Content Rules →
 * The block menu). The menu's rows run some time after it opened, and a peer may edit the document
 * in between: a row must act on the bullet the person chose, as it was when they chose it, or do
 * nothing. The menu's target carries the bullet's line number and text, which is not enough: a
 * peer who deletes lines above can bring another bullet with the same words onto that line, and one
 * who adds children changes what "Delete block" takes while the label still says what it took when
 * the menu opened.
 *
 * So the editor keeps the bullet's line start, followed as a line anchor is (line-anchor.ts: through
 * lines added or removed above, and through a move), and the Block's markdown as it was. A row finds
 * its bullet through {@link anchoredBlock}, which answers only while the bullet is still there and its
 * Block reads the same.
 */

import { type EditorState, type Extension, StateEffect, StateField } from '@codemirror/state'

import { blockMarkdown } from './block-actions'
import { followLine, lineRemoved } from './line-anchor'

interface BlockAnchor {
    /** The bullet line's start, or null once the line is gone. */
    start: number | null
    /** The Block as markdown when the menu opened. */
    markdown: string
}

/** Anchor the block menu to the bullet on this 1-based line, or to none (null). */
export const anchorBlockMenu = StateEffect.define<number | null>()

const blockMenuAnchorField = StateField.define<BlockAnchor | null>({
    create: () => null,
    update(value, tr) {
        let next = value
        if (next && next.start !== null && tr.docChanged) {
            next = { ...next, start: lineRemoved(next.start, tr) ? null : followLine(next.start, tr) }
        }
        for (const effect of tr.effects) {
            if (!effect.is(anchorBlockMenu)) continue
            const markdown = effect.value === null ? null : blockMarkdown(tr.state, effect.value)
            next = markdown === null || effect.value === null ? null : { start: tr.state.doc.line(effect.value).from, markdown }
        }
        return next
    },
})

/**
 * The 1-based line of the bullet the open block menu is for, or null when the bullet is gone or its
 * Block no longer reads as it did when the menu opened.
 */
export function anchoredBlock(state: EditorState): number | null {
    const anchor = state.field(blockMenuAnchorField, false)
    if (!anchor || anchor.start === null) return null
    const line = state.doc.lineAt(Math.min(anchor.start, state.doc.length)).number
    return blockMarkdown(state, line) === anchor.markdown ? line : null
}

export function blockMenuAnchor(): Extension {
    return blockMenuAnchorField
}
