/**
 * The CSS custom property the workspace root carries for Graph Settings → Document width
 * (`maxContentWidth`): how wide a document tab's text may run before its pane centres it.
 * DocumentView reads it as the side padding of the editor's scroller, so the scrollbar stays
 * at the pane's edge and the backlinks and panels beneath the text line up with it.
 *
 * The setting is pixels at the default text size. It is written as a multiple of
 * `--editor-font-size`, the zoom (Alt+= / Alt+-) that editor-font.ts keeps on the document root:
 * zoomed in, the column widens with the text, so a line holds the same words at every size. It
 * resolves the same anywhere in the View, so the row of buttons below the text, whose own font is
 * not zoomed, lines up with the column too.
 */

import { DEFAULT_FONT_SIZE } from '#lib/document/editor-font.js'

export function contentWidthStyle(width: number | null): string {
    const length = width === null ? '100%' : `calc(var(--editor-font-size, ${DEFAULT_FONT_SIZE}px) * ${width / DEFAULT_FONT_SIZE})`
    return `--gk-content-max-width: ${length};`
}
