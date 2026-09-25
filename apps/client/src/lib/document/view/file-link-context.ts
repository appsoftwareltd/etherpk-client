/**
 * The [[File Link]] the caret means, for the surfaces that act on "the link here" rather than on
 * a clicked element: the `/` menu's Copy file path row and the Command behind it.
 *
 * Read off the editor's own syntax tree through the same {@link linkPieces} the rendering uses,
 * so the row and what is drawn cannot disagree about where a link is. The tree is ensured up to
 * the caret's line first: the caret is on screen, so the parse has normally reached it, and a
 * short budget covers the rare case it has not.
 *
 * Two readings. {@link fileLinkAtCaret} is exact: the construct containing the caret.
 * {@link fileLinkForCaret} is what the menu needs: the `/` opens only at a word boundary, so it
 * can never be typed inside a bare `file:///…` url without changing the url, and the caret is a
 * space or two past the link by the time the row shows. It takes the link at the caret, else the
 * nearest one before it on the line, else the first on the line.
 */

import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

import { linkPieces } from './augmentations/markdown-link-core'

export interface FileLinkAtCaret {
    /** The native path the link names (file-link.ts). */
    path: string
    /** The whole construct's span in the document, syntax included. */
    from: number
    to: number
}

/** How long to wait for the parse to reach the caret's line before answering from what there is. */
const PARSE_BUDGET_MS = 20

/** Every file link on the main caret's line, in order, each spanning its whole construct. */
function fileLinksOnCaretLine(state: EditorState): FileLinkAtCaret[] {
    const line = state.doc.lineAt(state.selection.main.head)
    const tree = ensureSyntaxTree(state, line.to, PARSE_BUDGET_MS) ?? syntaxTree(state)
    const pieces = linkPieces({
        tree,
        sliceDoc: (from, to) => state.sliceDoc(from, to),
        from: line.from,
        to: line.to,
        isActiveLine: () => true, // the syntax pieces are not wanted; the construct span is on the piece
    })
    const links: FileLinkAtCaret[] = []
    for (const piece of pieces) {
        if (piece.kind === 'file-link') links.push({ path: piece.path, from: piece.construct.from, to: piece.construct.to })
    }
    return links
}

/** The file link whose construct contains the main caret, or null. */
export function fileLinkAtCaret(state: EditorState): FileLinkAtCaret | null {
    const pos = state.selection.main.head
    return fileLinksOnCaretLine(state).find((link) => pos >= link.from && pos <= link.to) ?? null
}

/** The file link the caret means: at the caret, else the nearest before it on the line, else the line's first. */
export function fileLinkForCaret(state: EditorState): FileLinkAtCaret | null {
    const pos = state.selection.main.head
    const links = fileLinksOnCaretLine(state)
    if (links.length === 0) return null
    const at = links.find((link) => pos >= link.from && pos <= link.to)
    if (at) return at
    const before = links.filter((link) => link.to < pos)
    return before.length > 0 ? before[before.length - 1] : links[0]
}
