/**
 * The [[Rich Paste]] decision (CONTEXT.md; ADR 0090): what a paste whose clipboard carries HTML
 * puts into the document, as a pure rule over the editor state so it has Node rows
 * (`rich-paste.test.ts`). The augmentation (`augmentations/rich-paste.ts`) reads the clipboard,
 * dispatches what this returns as an ordinary paste, and starts the image uploads.
 *
 * The precedence with the other paste routes: clipboard files with no plain text beside them
 * upload as before (`augmentations/asset-paste.ts` runs first); then HTML makes a Rich Paste,
 * except inside a [[Fenced Code Block]] or the [[Frontmatter]], where a paste is always the plain
 * text; then the plain text. The browser's paste-as-plain-text carries no HTML, so it opts out.
 *
 * Into a [[Block]] the converter's outline is pasted: when the first pasted line may take the whole
 * caret line (an empty bullet, or selected blocks) the outline lands as itself; when the caret's
 * block has text, the outline is pasted after an empty first line, which the block-per-line rule
 * (ADR 0089) reads as "nest this tree under the caret's block" - the same convention a copied tree
 * follows. Into prose, flat markdown.
 */

import type { EditorState } from '@codemirror/state'

import { blocksAsMarkdown, blocksAsOutline, htmlToBlocks, type PastedImage } from './html-blocks'
import { fencedBlockAt, lineInFrontmatter } from './outliner-context'
import { blockPasteTarget } from './paste-clamp'

export interface RichPastePlan {
    /** The text to paste over the selection, as the ordinary paste would be dispatched. */
    text: string
    /** The images the text carries as remote links, for the upload half. */
    images: PastedImage[]
}

/** The browser's parser. */
export function parseHtml(html: string): Document {
    return new DOMParser().parseFromString(html, 'text/html')
}

/**
 * What the paste puts in, or null when the plain text should be pasted instead: the caret is in a
 * fenced block or the frontmatter, or the HTML holds nothing to paste.
 */
export function planRichPaste(state: EditorState, html: string, parse: (html: string) => Document, displaySize?: string): RichPastePlan | null {
    const { from, to } = state.selection.main
    if (lineInFrontmatter(state, from) || fencedBlockAt(state, from)) return null
    const { blocks, images } = htmlToBlocks(parse(html), { displaySize })
    if (blocks.length === 0) return null
    const outline = blocksAsOutline(blocks)
    // The target is judged over the text that will be pasted, as the paste filter judges it: a one-line
    // outline is a single-line paste to the filter, and a selection that only holds the marker then
    // does not take the line.
    const target = blockPasteTarget(state, from, to, outline.includes('\n'))
    if (!target) return { text: blocksAsMarkdown(blocks), images }
    return { text: target.emptyBullet || target.replacesMarker ? outline : `\n${outline}`, images }
}
