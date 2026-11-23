/**
 * The Text Editor's line numbers (text-file.ts): CodeMirror's own gutter, set as the file's rows are
 * so each number sits on its line's first row, and the gutter's presses that are a line's.
 *
 * A right-click on a number opens the line's menu, as one on the line does. A tap on a number with
 * a finger bookmarks the line: the bookmark's own column is too narrow for one, and a phone has no
 * Ctrl+Alt+K. With a mouse a number takes no click, since the column beside it does.
 */
import type { Extension } from '@codemirror/state'
import { type BlockInfo, EditorView, highlightActiveLineGutter, lineNumbers } from '@codemirror/view'

import { CODE_FONT_SIZE, CODE_LINE_HEIGHT, CODE_LINE_HEIGHT_SNAPPED, CODE_ROW_PAD, SUPPORTS_ROUNDED_LINE_HEIGHT } from './code-highlight'

/** What a press on a line of the gutter does. `line` is 1-based. */
export interface GutterPresses {
    /** A finger's tap, and a mouse's click where `byMouse` says so. */
    press?: { line: (view: EditorView, line: number) => void; byMouse?: boolean }
    /** A right-click, at viewport `x`/`y`. True when it opened a menu, so the browser's does not. */
    menu?: (view: EditorView, line: number, x: number, y: number) => boolean
}

const lineOf = (view: EditorView, block: BlockInfo) => view.state.doc.lineAt(block.from).number

/**
 * Whether an event is level with `block`. The gutter is as tall as the pane, and CodeMirror gives a
 * press below the text the last line's block.
 */
function levelWith(view: EditorView, block: BlockInfo, event: Event): boolean {
    const y = ((event as MouseEvent).clientY - view.documentTop) / view.scaleY
    return block.top <= y && y < block.bottom
}

/** Whether a mouse event came from a finger. A `click` is a pointer event and says; where it is not, it is a mouse's. */
const byTouch = (event: Event) => (event as PointerEvent).pointerType === 'touch'

/** The gutter event handlers a column of the gutter shares, for {@link GutterPresses}. */
export function gutterPressHandlers({ press, menu }: GutterPresses) {
    return {
        // The press itself, kept from taking the focus and the selection from the text: a number is
        // text to the browser, which would give the focus to the scroller around it.
        mousedown(_view: EditorView, _block: BlockInfo, event: Event): boolean {
            event.preventDefault()
            return true
        },
        click(view: EditorView, block: BlockInfo, event: Event): boolean {
            if (!press || !levelWith(view, block, event) || !(byTouch(event) || press.byMouse)) return false
            press.line(view, lineOf(view, block))
            return true
        },
        contextmenu(view: EditorView, block: BlockInfo, event: Event): boolean {
            if (!menu || byTouch(event) || !levelWith(view, block, event)) return false
            const { clientX, clientY, shiftKey } = event as MouseEvent
            // Shift with a right-click is the browser's own menu, as on the line.
            if (shiftKey || !menu(view, lineOf(view, block), clientX, clientY)) return false
            event.preventDefault()
            return true
        },
    }
}

/**
 * The height of a file's first row, line height and room above and below (text-file.ts). As the
 * line height of what stands in the gutter, not as padding: CodeMirror's spacer, an element of no
 * height, would take the padding and push every number down by it.
 */
export const GUTTER_ROW = `calc(${CODE_LINE_HEIGHT}em + 2 * ${CODE_ROW_PAD})`
export const GUTTER_ROW_SNAPPED = `calc(${CODE_LINE_HEIGHT_SNAPPED} + 2 * ${CODE_ROW_PAD})`

const theme = EditorView.theme({
    // On the editor's own surface with no rule beside it: the numbers recede by colour alone.
    '.cm-gutters.cm-gutters-before': {
        border: 'none',
        backgroundColor: 'transparent',
        color: 'var(--gk-text-subtle, #737373)',
        fontFamily: 'var(--gk-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    },
    '.cm-lineNumbers .cm-gutterElement': {
        minWidth: '3.5ch',
        padding: '0',
        fontSize: CODE_FONT_SIZE,
        lineHeight: GUTTER_ROW,
        fontVariantNumeric: 'tabular-nums',
        cursor: 'default',
        userSelect: 'none',
    },
    [SUPPORTS_ROUNDED_LINE_HEIGHT]: {
        '.cm-lineNumbers .cm-gutterElement': { lineHeight: GUTTER_ROW_SNAPPED },
    },
    // The caret's own line, by its ink alone.
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--gk-text-default, #404040)' },
})

/** The Text Editor's line numbers. `presses` is absent where the editor has no bookmarks and no line menu. */
export function lineNumberGutter(presses: GutterPresses = {}): Extension {
    return [lineNumbers({ domEventHandlers: gutterPressHandlers(presses) }), highlightActiveLineGutter(), theme]
}
