/**
 * The editor's own selection highlight (Editor Content Rules → Selection).
 *
 * CodeMirror's `drawSelection` draws a selection as up to three rectangles per range: the first
 * and last rows sized from the caret rectangles (the font's text box) and the middle block from
 * the line blocks (the full line height), all running from the content element's left edge to its
 * right edge. Over an outliner that is wrong in every direction: it paints the indent gutter and
 * the margin past the text, and the end rows are shorter than the rows between them. The first
 * attempt masked the excess per line with surface-coloured pseudo-elements and grew into a set of
 * masks with their own geometry bugs. This layer replaces the rectangles instead.
 *
 * One rectangle per selected line: from the line's content column (the bullet marker included, so
 * an empty selected bullet still reads as selected; a fenced line's fence column; a continuation's
 * floor; column 0 for prose) to the painted end of its text, the full line block tall. A partially
 * selected line is split by visual row from the caret positions, each row still the full row
 * height. Nothing is masked; there is nothing to mask.
 *
 * Horizontally the highlight follows the caret, as Logseq's does: a text range (any selection that is
 * not a block selection) starts and ends where the caret sits, with no padding, and a row the range
 * runs on past reaches the painted end of the line. A block selection (block-select.ts: whole blocks,
 * caret hidden) is padded {@link SELECTION_PAD} left and right, so its rows read as selected blocks
 * rather than selected text. A blank line has no text to cover, so it shows one character cell at its
 * content column for its line break: always in a block selection, and in a text range only when the
 * break itself is selected (a range ending at the line's start has selected nothing on it).
 *
 * Geometry is read in the layer's measure phase, where the DOM is laid out, so no separate
 * measurement pass or state field is needed; the layer redraws on document, selection, viewport
 * and geometry changes.
 */

import type { EditorState, Extension } from '@codemirror/state'
import { EditorView, layer, RectangleMarker } from '@codemirror/view'

import { isBulletLine, lineIndent, continuationFloor } from '../../outliner'
import { isBlockSelection } from '../block-select'
import { SELECTION_PAD } from '../cm-document'
import { visibleFencedBlockAt } from '../outliner-context'

const CLASS = 'gk-selection'

/** The column the highlight starts at: the marker start on a bullet, the fence column in code, the floor on a continuation. */
function contentColumn(state: EditorState, line: { from: number; text: string; number: number }): number {
    const block = visibleFencedBlockAt(state, line.from)
    if (block && block.from !== line.from) return Math.min(block.fenceColumn, line.text.length)
    if (isBulletLine(line.text)) return lineIndent(line.text)
    const floor = continuationFloor(state.doc.toString().split('\n'), line.number - 1)
    return floor > 0 ? Math.min(floor, line.text.length) : 0
}

/** The scroll-content origin, the coordinate space the layer's markers are positioned in. */
function base(view: EditorView): { left: number; top: number } {
    const rect = view.scrollDOM.getBoundingClientRect()
    return { left: rect.left - view.scrollDOM.scrollLeft * view.scaleX, top: rect.top - view.scrollDOM.scrollTop * view.scaleY }
}

/** The line element for `pos`, for its painted extent and its line-height. */
function lineElement(view: EditorView, pos: number): HTMLElement | null {
    let node: Node | null = view.domAtPos(pos).node
    while (node && !(node instanceof HTMLElement && node.classList.contains('cm-line'))) node = node.parentNode
    return node as HTMLElement | null
}

/** The right edge (viewport px) of everything painted on the line: inline boxes with their padding. */
function paintedRight(lineEl: HTMLElement): number {
    const range = document.createRange()
    range.selectNodeContents(lineEl)
    const rect = range.getBoundingClientRect()
    return rect.width > 0 ? rect.right : lineEl.getBoundingClientRect().left
}

function markers(view: EditorView): RectangleMarker[] {
    const { state } = view
    const origin = base(view)
    const out: RectangleMarker[] = []
    const rect = (left: number, top: number, right: number, height: number) => {
        if (right > left && height > 0) out.push(new RectangleMarker(CLASS, left - origin.left, top - origin.top, right - left, height))
    }
    const blocks = isBlockSelection(state)
    const pad = blocks ? SELECTION_PAD : 0
    for (const range of state.selection.ranges) {
        if (range.empty) continue
        const first = state.doc.lineAt(range.from).number
        const last = state.doc.lineAt(range.to).number
        for (let n = first; n <= last; n++) {
            const line = state.doc.line(n)
            if (line.to < view.viewport.from || line.from > view.viewport.to) continue
            const lineEl = lineElement(view, line.from)
            if (!lineEl) continue
            const block = view.lineBlockAt(line.from)
            const blockTop = block.top + view.documentTop
            const rowHeight = parseFloat(getComputedStyle(lineEl).lineHeight) || block.height
            const lineRect = lineEl.getBoundingClientRect()
            // A code line never wraps and its block scrolls sideways (ADR 0094): the fence-column
            // character and either end of a partial selection can sit outside the panel, and the
            // highlight must not paint over the gutter or past the panel's right edge.
            const panelLeft = lineEl.classList.contains('gk-code-block')
                ? lineRect.left + (parseFloat(getComputedStyle(lineEl, '::after').left) || 0)
                : -Infinity
            const col = contentColumn(state, line)
            const colLeft = view.coordsAtPos(line.from + col, 1)?.left ?? lineRect.left
            // Nothing is painted past the content column of a blank line, so its "text" is one character cell.
            const blank = line.from + col >= line.to
            if (blank && !blocks && range.to <= line.to) continue
            const contentLeft = Math.max(colLeft - pad, panelLeft)
            const textRight = Math.min((blank ? colLeft + view.defaultCharacterWidth : paintedRight(lineEl)) + pad, lineRect.right)
            const selFrom = Math.max(range.from, line.from)
            const selTo = Math.min(range.to, line.to)
            const wholeStart = selFrom <= line.from + col
            const wholeEnd = selTo >= line.to
            if (wholeStart && wholeEnd) {
                rect(contentLeft, blockTop, textRight, block.height)
                continue
            }
            // A partially selected line: the caret rectangles say which visual row each end sits on.
            const a = view.coordsAtPos(selFrom, 1)
            const b = view.coordsAtPos(selTo, -1)
            if (!a || !b) continue
            const rowTop = (c: { top: number; bottom: number }) => c.top - (rowHeight - (c.bottom - c.top)) / 2
            const left = wholeStart ? contentLeft : Math.max(a.left - pad, panelLeft)
            const right = wholeEnd ? textRight : Math.min(b.left + pad, lineRect.right)
            if (b.top - a.top < rowHeight / 2) {
                rect(left, rowTop(a), right, rowHeight) // one visual row
                continue
            }
            rect(left, rowTop(a), textRight, rowHeight) // first row, to the end of the text
            rect(contentLeft, rowTop(a) + rowHeight, textRight, rowTop(b) - rowTop(a) - rowHeight) // rows between
            rect(contentLeft, rowTop(b), right, rowHeight) // last row, from the content column
        }
    }
    return out
}

const theme = EditorView.baseTheme({
    [`.${CLASS}`]: { background: 'var(--gk-selection, #d2ebfc)', position: 'absolute' },
    // drawSelection still draws the caret; only its selection rectangles are replaced.
    '.cm-selectionLayer': { display: 'none' },
})

/** The selection highlight augmentation. Mounted in DocumentView alongside the others. */
export function selectionLayerAugmentation(): Extension {
    return [
        layer({
            above: false,
            class: 'gk-selection-layer',
            markers,
            update: (update) => update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged,
        }),
        theme,
    ]
}
