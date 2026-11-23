/**
 * The Text Editor's bookmarks (text-file.ts): a column at the pane's left edge, before the line
 * numbers. It is where a document draws them, in the outer part of its padding, so a file's bookmarks
 * stay put when its editor is switched, and the same size and colour. A gutter and not a layer over
 * the padding, since the numbers stand where the padding was.
 *
 * Hovering the column shows a faint bookmark on a line that can take one, and a click sets or clears
 * it, as in a document. The column is drawn for sight alone (CodeMirror hides gutters from a screen
 * reader); the keys and the line's menu are the same as everywhere.
 */
import type { EditorState, Extension } from '@codemirror/state'
import { EditorView, GutterMarker, gutter } from '@codemirror/view'

import { bookmarkMarkState, bookmarkOnLine } from './bookmark-marks'
import { CODE_FONT_SIZE, SUPPORTS_ROUNDED_LINE_HEIGHT } from './code-highlight'
import { GUTTER_ROW, GUTTER_ROW_SNAPPED, type GutterPresses, gutterPressHandlers } from './line-numbers'

export interface BookmarkGutterOptions extends Pick<GutterPresses, 'menu'> {
    /** Set or clear the bookmark of 1-based `line`. */
    toggle: (view: EditorView, line: number) => void
    /** Whether `line` is offered one to set: a line with words. */
    offers: (state: EditorState, line: number) => boolean
}

class BookmarkMarker extends GutterMarker {
    constructor(private readonly set: boolean) {
        super()
    }
    eq(other: BookmarkMarker): boolean {
        return other.set === this.set
    }
    toDOM(): HTMLElement {
        const mark = document.createElement('div')
        mark.className = 'gk-bookmark-slot'
        const ribbon = mark.appendChild(document.createElement('div'))
        ribbon.className = this.set ? 'gk-bookmark' : 'gk-bookmark gk-bookmark-ghost'
        return mark
    }
}

const SET = new BookmarkMarker(true)
/** Drawn only under the pointer. */
const OFFERED = new BookmarkMarker(false)

/** The marker of 1-based `line`: its bookmark, the faint one it is offered, or none. */
export function bookmarkMarkerOf(state: EditorState, line: number, offers: BookmarkGutterOptions['offers']): GutterMarker | null {
    if (bookmarkOnLine(state, line) !== null) return SET
    return offers(state, line) ? OFFERED : null
}

const theme = EditorView.theme({
    // As wide as the padding a document draws them in (`CONTENT_PAD_X`).
    '.gk-bookmark-gutter': { width: '1.25rem' },
    '.gk-bookmark-gutter .cm-gutterElement': { fontSize: CODE_FONT_SIZE },
    // The line's first row, with the ribbon in the middle of it.
    '.gk-bookmark-slot': { display: 'grid', placeItems: 'center', height: GUTTER_ROW, cursor: 'pointer' },
    [SUPPORTS_ROUNDED_LINE_HEIGHT]: { '.gk-bookmark-slot': { height: GUTTER_ROW_SNAPPED } },
    '.gk-bookmark-gutter .gk-bookmark': { width: '10px', height: '14px' },
    '.gk-bookmark-gutter .gk-bookmark-ghost': { visibility: 'hidden' },
    '@media (hover: hover)': {
        '.gk-bookmark-gutter .cm-gutterElement:hover .gk-bookmark-ghost': { visibility: 'visible' },
    },
})

/** The bookmark column. The marks themselves are `bookmark-marks.ts`'s, as in a document. */
export function bookmarkGutter({ toggle, offers, menu }: BookmarkGutterOptions): Extension {
    return [
        gutter({
            class: 'gk-bookmark-gutter',
            lineMarker: (view, block) => bookmarkMarkerOf(view.state, view.state.doc.lineAt(block.from).number, offers),
            lineMarkerChange: (update) => update.docChanged || update.startState.field(bookmarkMarkState).marks !== update.state.field(bookmarkMarkState).marks,
            domEventHandlers: gutterPressHandlers({ press: { line: toggle, byMouse: true }, menu }),
        }),
        theme,
    ]
}
